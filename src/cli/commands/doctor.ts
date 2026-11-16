/**
 * `hydra-onix-mcp doctor`: one command that answers "is this set up
 * correctly?", and the command catalog (`DOCTOR_COMMANDS`).
 *
 * Offline it checks Node, the config, each agent's registration, the browser,
 * the credentials file (and its mode on POSIX) and the session expiry.
 * `--online` also refreshes the session through the TokenManager and runs
 * `initialize` + `tools/list` against the real server. It never logs in, so it
 * never launches a browser.
 *
 * Nothing here throws: a diagnostic command that dies on the first problem is
 * useless exactly when it is needed. Never put cookie or token values in a
 * check.
 */
import { stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { findBrowser } from '../../auth/browser/find.js';
import { SessionExpiredError } from '../../auth/session.js';
import { CredentialStore, type AppCredentials } from '../../auth/store.js';
import { TokenManager } from '../../auth/token-manager.js';
import { loadConfig } from '../../config/config.js';
import type { UserConfig } from '../../config/schema.js';
import { appUrl, mcpUrl, SERVER_NAME } from '../../constants.js';
import { commandHint, isHarnessError } from '../../errors.js';
import { inspectTargetRegistration } from '../../generators/targets/mcp.js';
import { TARGETS } from '../../generators/targets/registry.js';
import { logger } from '../../logger.js';
import { packageVersion } from '../../package-version.js';
import { hydraPaths } from '../../paths.js';
import { authorizedFetch, type TokenSource } from '../../proxy/relay.js';
import { hasLiveSession } from './auth/status.js';
import { manualEntry } from './targets/install.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  hint?: string;
}

export interface DoctorCommandInfo {
  command: string;
  description: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  commands: DoctorCommandInfo[];
  ok: boolean;
}

export const DOCTOR_COMMANDS: DoctorCommandInfo[] = [
  { command: 'npx @andygo.dev/hydra-onix-mcp setup', description: 'Run the full idempotent setup flow' },
  { command: 'npx @andygo.dev/hydra-onix-mcp doctor', description: 'Check setup health and list available commands' },
  { command: 'npx @andygo.dev/hydra-onix-mcp auth login', description: 'Sign in to Hydra (browser, or --manual paste)' },
  { command: 'npx @andygo.dev/hydra-onix-mcp auth logout', description: 'Forget the stored session and login profile' },
  { command: 'npx @andygo.dev/hydra-onix-mcp auth status', description: 'Show who is signed in and when it expires' },
  { command: 'npx @andygo.dev/hydra-onix-mcp mcp start', description: 'Run the stdio relay (launched by agents)' },
  { command: 'npx @andygo.dev/hydra-onix-mcp mcp status', description: 'Show registration per agent and login state' },
  { command: 'npx @andygo.dev/hydra-onix-mcp targets list', description: 'List coding agents and their setup state' },
  { command: 'npx @andygo.dev/hydra-onix-mcp targets add <agent>', description: 'Set up another coding agent' },
  { command: 'npx @andygo.dev/hydra-onix-mcp targets remove <agent>', description: 'Stop setting up a coding agent' },
  { command: 'npx @andygo.dev/hydra-onix-mcp targets install', description: 'Register the server with every configured agent' },
];

/** Lists the tool names the MCP server offers, over an authorized connection. */
export type ConnectFn = (o: { mcpUrl: string; tokens: TokenSource }) => Promise<string[]>;

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** Also refresh the session and talk to the real MCP server. */
  online?: boolean;
  /** Replaces the SDK client used for `initialize` + `tools/list`. */
  connect?: ConnectFn;
  /** Browser lookup; defaults to `findBrowser` with `env`. */
  find?: () => Promise<string | undefined>;
  platform?: NodeJS.Platform;
}

function messageOf(error: unknown): string {
  if (isHarnessError(error)) return error.hint ? `${error.message}\n${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const listTools: ConnectFn = async ({ mcpUrl: url, tokens }) => {
  const client = new Client({ name: 'hydra-onix-mcp-doctor', version: packageVersion() });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: authorizedFetch(tokens) });
  try {
    await client.connect(transport);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  } finally {
    await client.close().catch(() => undefined);
  }
};

export async function runDoctor(o: DoctorOptions = {}): Promise<DoctorReport> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const paths = hydraPaths(env);
  const app = appUrl(env);
  const store = new CredentialStore(paths, app);
  const checks: DoctorCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, hint?: string): void => {
    checks.push({ id, label, status, ...(hint ? { hint } : {}) });
  };

  // Node.
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 22) add('node', `Node.js ${process.versions.node}`, 'pass');
  else add('node', `Node.js ${process.versions.node}`, 'fail', 'hydra-onix-mcp requires Node.js 22 or newer.');

  // Config.
  let config: UserConfig | undefined;
  try {
    config = await loadConfig(paths);
    if (config) add('config', 'Configuration valid', 'pass');
    else add('config', 'Configuration valid', 'fail', `Not set up yet. ${commandHint('npx @andygo.dev/hydra-onix-mcp setup')}`);
  } catch (error) {
    add('config', 'Configuration valid', 'fail', messageOf(error));
  }

  // Registration, per configured agent.
  for (const id of config?.targets ?? []) {
    const target = TARGETS[id];
    const checkId = `registration:${id}`;
    const label = `MCP server registered with ${target.label}`;
    try {
      const state = await inspectTargetRegistration(paths.home, target, SERVER_NAME);
      if (!state.registered) {
        add(checkId, label, 'fail', commandHint(`npx @andygo.dev/hydra-onix-mcp targets install --target ${id}`));
      } else if (!state.current) {
        add(
          checkId,
          `${label} (registered, not ours)`,
          'warn',
          `The "${SERVER_NAME}" entry in ${state.relativeFile} was left alone. To use this package, replace it with:\n` +
            manualEntry(target),
        );
      } else {
        add(checkId, label, 'pass');
      }
    } catch (error) {
      add(checkId, label, 'fail', messageOf(error));
    }
  }

  // Browser.
  try {
    const browser = await (o.find ?? (() => findBrowser({ env })))();
    if (browser) add('browser', `Browser found: ${browser}`, 'pass');
    else
      add(
        'browser',
        'Browser found',
        'warn',
        'No Chrome, Chromium, Edge or Brave found. Use `npx @andygo.dev/hydra-onix-mcp auth login --manual`, ' +
          'or set HYDRA_ONIX_MCP_BROWSER.',
      );
  } catch (error) {
    add('browser', 'Browser found', 'warn', messageOf(error));
  }

  // Credentials.
  let stored: AppCredentials | undefined;
  let credentialsOk = false;
  try {
    stored = await store.read();
    if (stored) {
      credentialsOk = true;
      add('credentials', `Credentials stored in ${paths.credentialsFile}`, 'pass');
    } else {
      add('credentials', 'Credentials stored', 'fail', `Not signed in. ${commandHint('npx @andygo.dev/hydra-onix-mcp auth login')}`);
    }
  } catch (error) {
    add('credentials', 'Credentials stored', 'fail', messageOf(error));
  }

  if (platform !== 'win32') {
    const label = 'Credentials file readable only by you (0600)';
    try {
      const mode = (await stat(paths.credentialsFile)).mode & 0o777;
      if (mode & 0o077) {
        add('credentials-permissions', label, 'warn', `Mode is ${mode.toString(8)}. Run:\n\n  chmod 600 ${paths.credentialsFile}`);
      } else {
        add('credentials-permissions', label, 'pass');
      }
    } catch {
      add('credentials-permissions', label, 'skip', 'no credentials file');
    }
  }

  // Session expiry, as stored.
  if (!credentialsOk) {
    add('session', 'Hydra session not expired', 'skip', 'no stored session');
  } else if (hasLiveSession(stored)) {
    const until = stored?.sessionExpires ? ` (until ${stored.sessionExpires})` : '';
    add('session', `Hydra session not expired${until}`, 'pass');
  } else {
    add('session', 'Hydra session not expired', 'fail', `The session has expired. ${commandHint('npx @andygo.dev/hydra-onix-mcp auth login')}`);
  }

  if (o.online) {
    // Never logs in: a gone session is reported, not repaired with a browser.
    const manager = new TokenManager({
      store,
      appUrl: app,
      login: async () => {
        throw new SessionExpiredError();
      },
    });
    const tokens: TokenSource = {
      getToken: () => manager.getToken({ interactive: false }),
      onUnauthorized: (used) => manager.onUnauthorized(used, { interactive: false }),
    };

    let refreshed = false;
    try {
      await tokens.getToken({ interactive: false });
      refreshed = true;
      add('session-refresh', 'Hydra session refreshes to an access token', 'pass');
    } catch (error) {
      add('session-refresh', 'Hydra session refreshes to an access token', 'fail', messageOf(error));
    }

    if (!refreshed) {
      add('mcp-tools', 'Hydra MCP server lists its tools', 'skip', 'no access token');
    } else {
      try {
        const tools = await (o.connect ?? listTools)({ mcpUrl: mcpUrl(env), tokens });
        add('mcp-tools', `Hydra MCP server lists its tools (${plural(tools.length, 'tool')})`, 'pass');
      } catch (error) {
        add('mcp-tools', 'Hydra MCP server lists its tools', 'fail', messageOf(error));
      }
    }
  }

  return { checks, commands: [...DOCTOR_COMMANDS], ok: checks.every((c) => c.status !== 'fail') };
}

const SYMBOL: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗', skip: '·' };

export async function doctorCommand(o: DoctorOptions & { json?: boolean } = {}): Promise<void> {
  const report = await runDoctor(o);

  if (o.json) {
    logger.print(JSON.stringify(report, null, 2));
  } else {
    // Skipped checks usually share one cause; print it once.
    let lastSkipReason: string | undefined;
    for (const check of report.checks) {
      logger.print(`${SYMBOL[check.status]} ${check.label}`);
      if (!check.hint || check.status === 'pass') continue;
      if (check.status === 'skip') {
        if (check.hint === lastSkipReason) continue;
        lastSkipReason = check.hint;
      }
      for (const line of check.hint.split('\n')) {
        if (line.trim()) logger.print(`    ${line.trim()}`);
      }
    }

    logger.print();
    logger.print('Available commands:');
    for (const command of report.commands) {
      logger.print(`  ${command.command.padEnd(56)} ${command.description}`);
    }

    if (!report.ok) {
      logger.print();
      logger.print('Some checks failed. Fix the items above and re-run:');
      logger.print('  npx @andygo.dev/hydra-onix-mcp doctor');
    }
  }

  if (!report.ok) process.exitCode = 1;
}
