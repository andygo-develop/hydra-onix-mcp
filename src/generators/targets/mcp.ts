/**
 * Registering the server with each coding agent's user-level config.
 *
 * Three dialects, one policy: merge into whatever is already there, never
 * rewrite or remove another server's entry, and leave an existing entry for our
 * own server alone — whoever customised it meant to.
 *
 * The TOML path is append-only: rewriting a file we cannot fully parse could
 * lose settings we never understood. For Claude Code, the `claude` CLI is
 * preferred over editing `~/.claude.json`, which Claude rewrites while running.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError } from '../../errors.js';
import { defaultClaudeCli, type ClaudeCli } from '../claude-cli.js';
import { mcpCommandLine, mcpLaunch } from '../mcp-entry.js';
import { TARGETS } from './registry.js';
import type { McpStyle, TargetDefinition, TargetId } from './types.js';

export interface TargetRegistrationState {
  target: TargetId;
  label: string;
  /** Absolute path to the tool's MCP configuration file. */
  configFile: string;
  /** `~/`-prefixed path, for display. */
  relativeFile: string;
  fileExists: boolean;
  /** Our server name is present. */
  registered: boolean;
  /** Present and pointing at this package's `mcp start`. */
  current: boolean;
  /** Other servers already configured, left untouched. */
  otherServers: string[];
}

export interface TargetRegisterResult extends TargetRegistrationState {
  changed: boolean;
  /** How the entry was written, when it was. */
  via?: 'claude-cli' | 'file';
}

export interface InspectOptions {
  platform?: NodeJS.Platform;
}

export interface RegisterOptions extends InspectOptions {
  claude?: ClaudeCli;
  /** Environment for the default `claude` CLI (an overridden home never uses it). */
  env?: NodeJS.ProcessEnv;
}

/* ------------------------------------------------------------------ JSON -- */

interface JsonServers {
  [key: string]: unknown;
}

/** The `command`/`args` entry shape used by Claude Code, Cursor and Gemini CLI. */
export function commandArgsEntry(platform?: NodeJS.Platform): { command: string; args: string[] } {
  return mcpLaunch(platform);
}

/** OpenCode takes the whole launch line as one array. */
export function opencodeEntry(platform?: NodeJS.Platform): {
  type: string;
  command: string[];
  enabled: boolean;
} {
  return { type: 'local', command: mcpCommandLine(platform), enabled: true };
}

function serversKey(style: McpStyle): string {
  return style === 'opencode' ? 'mcp' : 'mcpServers';
}

function desiredJsonEntry(style: McpStyle, platform?: NodeJS.Platform): Record<string, unknown> {
  return style === 'opencode' ? opencodeEntry(platform) : commandArgsEntry(platform);
}

/** Field-by-field comparison, so an added `env` or `enabled` does not make an entry stale. */
function isSameJsonEntry(entry: unknown, style: McpStyle, platform?: NodeJS.Platform): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const record = entry as Record<string, unknown>;

  if (style === 'opencode') {
    return JSON.stringify(record.command) === JSON.stringify(mcpCommandLine(platform));
  }

  const launch = mcpLaunch(platform);
  return (
    record.command === launch.command &&
    JSON.stringify(record.args ?? []) === JSON.stringify(launch.args)
  );
}

/**
 * The file's text, or undefined when it does not exist. Only ENOENT means
 * "absent": any other failure (EACCES, EISDIR, ...) throws, because treating
 * an unreadable file as empty would overwrite it on the next write.
 */
async function readConfigText(configFile: string): Promise<string | undefined> {
  try {
    return await readFile(configFile, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const code = (cause as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new HarnessError(`Could not read ${configFile} (${code}).`, {
      hint: 'Fix its permissions or remove it, then re-run setup. It was left untouched.',
      cause,
    });
  }
}

async function readJsonConfig(configFile: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readConfigText(configFile);
  if (raw === undefined) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new HarnessError(`${path.basename(configFile)} exists but is not valid JSON.`, {
      hint: `Fix or remove it, then re-run setup:\n\n  ${configFile}`,
      cause,
    });
  }
}

/* ------------------------------------------------------------------ TOML -- */

/** TOML bare keys allow letters, digits, `_` and `-`; anything else is quoted. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function codexTable(serverName: string, platform?: NodeJS.Platform): string {
  const { command, args } = mcpLaunch(platform);
  return (
    `[mcp_servers.${tomlKey(serverName)}]\n` +
    `command = ${JSON.stringify(command)}\n` +
    `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]\n`
  );
}

/** Matches `[mcp_servers.name]` or `[mcp_servers."name"]` at the start of a line. */
function codexTablePattern(serverName: string): RegExp {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[mcp_servers\\.(?:"${escaped}"|${escaped})\\]`, 'm');
}

/** Every `[mcp_servers.x]` table name present in a TOML file. */
function codexServerNames(content: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]/gm;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    names.push(match[1] ?? match[2]!);
  }
  return names;
}

/* ------------------------------------------------------------ operations -- */

/** The file's permission bits, or undefined when it does not exist. */
async function existingMode(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mode & 0o777;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

/**
 * Temp file + rename. The temp file takes the original's mode, so a private
 * (0600) config stays private instead of becoming 0666 & ~umask.
 */
async function writeAtomic(configFile: string, content: string): Promise<void> {
  await mkdir(path.dirname(configFile), { recursive: true });
  const mode = await existingMode(configFile);
  const temp = `${configFile}.${process.pid}.tmp`;
  try {
    await writeFile(temp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
    // `mode` above is masked by the umask; set it exactly. POSIX only.
    if (mode !== undefined && process.platform !== 'win32') await chmod(temp, mode);
    await rename(temp, configFile);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function inspectTargetRegistration(
  home: string,
  target: TargetDefinition,
  serverName: string,
  options: InspectOptions = {},
): Promise<TargetRegistrationState> {
  const { platform } = options;
  const configFile = path.join(home, ...target.mcp.file.split('/'));
  const base = {
    target: target.id,
    label: target.label,
    configFile,
    relativeFile: `~/${target.mcp.file}`,
  };

  if (target.mcp.style === 'codex-toml') {
    const content = await readConfigText(configFile);
    const registered = content !== undefined && codexTablePattern(serverName).test(content);
    return {
      ...base,
      fileExists: content !== undefined,
      registered,
      current: registered && content!.includes(codexTable(serverName, platform).trimEnd()),
      otherServers: (content ? codexServerNames(content) : []).filter((name) => name !== serverName),
    };
  }

  const config = await readJsonConfig(configFile);
  const key = serversKey(target.mcp.style);
  const servers = (config?.[key] as JsonServers | undefined) ?? {};
  const entry = servers[serverName];

  return {
    ...base,
    fileExists: Boolean(config),
    registered: entry !== undefined,
    current: isSameJsonEntry(entry, target.mcp.style, platform),
    otherServers: Object.keys(servers).filter((name) => name !== serverName),
  };
}

/**
 * Adds our server to a target's configuration, preserving every other key and
 * server. Does nothing when an entry for this server already exists.
 */
export async function registerTargetServer(
  home: string,
  target: TargetDefinition,
  serverName: string,
  options: RegisterOptions = {},
): Promise<TargetRegisterResult> {
  const { platform } = options;
  const state = await inspectTargetRegistration(home, target, serverName, { platform });

  if (state.registered) {
    return { ...state, changed: false };
  }

  if (target.id === 'claude-code') {
    const claude = options.claude ?? defaultClaudeCli(options.env);
    if (await claude.available()) {
      await claude.addUserServer(serverName, commandArgsEntry(platform));
      // Claude may write somewhere other than the file inspected; report the
      // state as found either way.
      return {
        ...(await inspectTargetRegistration(home, target, serverName, { platform })),
        changed: true,
        via: 'claude-cli',
      };
    }
  }

  if (target.mcp.style === 'codex-toml') {
    const existing = (await readConfigText(state.configFile)) ?? '';
    const separator =
      existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    await writeAtomic(state.configFile, `${existing}${separator}${codexTable(serverName, platform)}`);
  } else {
    const config = (await readJsonConfig(state.configFile)) ?? {};
    const key = serversKey(target.mcp.style);
    const servers = { ...((config[key] as JsonServers | undefined) ?? {}) };
    servers[serverName] = desiredJsonEntry(target.mcp.style, platform);

    // Declare OpenCode's schema, first, only when we create the file.
    const schema =
      target.mcp.style === 'opencode' && !state.fileExists && !config.$schema
        ? { $schema: 'https://opencode.ai/config.json' }
        : {};
    const next: Record<string, unknown> = { ...schema, ...config, [key]: servers };

    await writeAtomic(state.configFile, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    ...(await inspectTargetRegistration(home, target, serverName, { platform })),
    changed: true,
    via: 'file',
  };
}

/** Registration state for several targets at once, in the order given. */
export async function inspectRegistrations(
  home: string,
  targets: readonly TargetId[],
  serverName: string,
  options: InspectOptions = {},
): Promise<TargetRegistrationState[]> {
  const states: TargetRegistrationState[] = [];
  for (const id of targets) {
    states.push(await inspectTargetRegistration(home, TARGETS[id], serverName, options));
  }
  return states;
}
