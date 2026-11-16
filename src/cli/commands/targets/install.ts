/**
 * `hydra-onix-mcp targets install`: register the server with every configured
 * coding agent (or the `--target` ones).
 *
 * `setup` and `targets add` share `registerTargetsInteractively`, which asks
 * once per agent that is not yet registered and reports how each entry was
 * written: through the `claude` CLI or by editing the file.
 */
import { loadConfig } from '../../../config/config.js';
import { SERVER_NAME } from '../../../constants.js';
import { HarnessError, commandHint } from '../../../errors.js';
import type { ClaudeCli } from '../../../generators/claude-cli.js';
import { registerTargets, type TargetMcpOutcome } from '../../../generators/targets/install.js';
import { commandArgsEntry, opencodeEntry, type TargetRegistrationState } from '../../../generators/targets/mcp.js';
import { parseTargetIds, TARGETS } from '../../../generators/targets/registry.js';
import type { TargetDefinition, TargetId } from '../../../generators/targets/types.js';
import { mcpLaunch } from '../../../generators/mcp-entry.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';
import { confirm } from '../../prompt.js';

/** The entry to put in a target's file by hand, in that file's dialect. */
export function manualEntry(target: TargetDefinition, serverName: string = SERVER_NAME): string {
  const key = JSON.stringify(serverName);
  if (target.mcp.style === 'codex-toml') {
    const { command, args } = mcpLaunch();
    const name = /^[A-Za-z0-9_-]+$/.test(serverName) ? serverName : key;
    return [
      `[mcp_servers.${name}]`,
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    ].join('\n');
  }
  if (target.mcp.style === 'opencode') {
    return `"mcp": { ${key}: ${JSON.stringify(opencodeEntry())} }`;
  }
  return `"mcpServers": { ${key}: ${JSON.stringify(commandArgsEntry())} }`;
}

function printEntry(target: TargetDefinition, intro: string): void {
  logger.print();
  logger.print(intro);
  logger.print();
  for (const line of manualEntry(target).split('\n')) logger.print(`  ${line}`);
  logger.print();
}

export interface RegisterInteractivelyOptions {
  yes?: boolean;
  env: NodeJS.ProcessEnv;
  claude?: ClaudeCli;
}

/** Registration with a prompt per agent and a line per outcome; shared with `setup` and `targets add`. */
export async function registerTargetsInteractively(
  targets: readonly TargetId[],
  o: RegisterInteractivelyOptions,
): Promise<TargetMcpOutcome[]> {
  const describe = (target: TargetDefinition, state: TargetRegistrationState): string =>
    state.fileExists
      ? `Add the "${SERVER_NAME}" server to ${state.relativeFile} for ${target.label}?` +
        (state.otherServers.length > 0
          ? ` (${state.otherServers.length} existing server(s) will be left unchanged)`
          : '')
      : `Create ${state.relativeFile} registering the "${SERVER_NAME}" MCP server for ${target.label}?`;

  const outcomes = await registerTargets(targets, {
    home: hydraPaths(o.env).home,
    serverName: SERVER_NAME,
    env: o.env,
    claude: o.claude,
    confirm: (target, state) => confirm(describe(target, state), { assumeYes: o.yes }),
  });

  for (const outcome of outcomes) {
    const target = TARGETS[outcome.target];
    if (outcome.declined) {
      logger.info(`Skipped ${target.label} registration`);
      printEntry(target, `To register later, re-run setup or add this to ${outcome.relativeFile}:`);
    } else if (outcome.changed && outcome.via === 'claude-cli') {
      logger.success(`Registered "${SERVER_NAME}" with ${target.label} via the \`claude\` CLI`);
    } else if (outcome.changed) {
      logger.success(`Registered "${SERVER_NAME}" with ${target.label} in ${outcome.relativeFile} (file write)`);
      if (target.id === 'claude-code') {
        logger.info(
          outcome.note ?? `The \`claude\` CLI was not available, so ${outcome.relativeFile} was edited directly.`,
        );
      }
    } else if (outcome.current) {
      logger.success(`Already registered with ${target.label} in ${outcome.relativeFile}`);
    } else {
      logger.warn(
        `${target.label} already has a "${SERVER_NAME}" entry in ${outcome.relativeFile} that is not ours; left it alone.`,
      );
      printEntry(target, 'To use this package instead, replace that entry with:');
    }
    if (target.mcp.note) logger.info(target.mcp.note);
  }
  return outcomes;
}

export interface TargetsInstallOptions {
  /** Restrict to these agents instead of everything the config lists. */
  target?: readonly string[];
  yes?: boolean;
  env?: NodeJS.ProcessEnv;
  claude?: ClaudeCli;
}

export async function runTargetsInstall(o: TargetsInstallOptions = {}): Promise<TargetMcpOutcome[]> {
  const env = o.env ?? process.env;
  const requested = o.target?.length ? parseTargetIds(o.target) : undefined;
  const targets = requested ?? (await loadConfig(hydraPaths(env)))?.targets;
  if (!targets) {
    throw new HarnessError('No coding agents are set up yet.', {
      hint: commandHint('hydra-onix-mcp setup'),
    });
  }
  return registerTargetsInteractively(targets, { yes: o.yes, env, claude: o.claude });
}

export async function targetsInstallCommand(o: TargetsInstallOptions = {}): Promise<void> {
  await runTargetsInstall(o);
}
