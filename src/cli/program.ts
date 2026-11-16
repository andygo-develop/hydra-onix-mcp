/**
 * The commander program and its error boundary.
 *
 * Kept apart from `index.ts` (which runs it) so tests can build the program
 * and walk its commands without parsing the test runner's argv. Commands are
 * hierarchical (`auth login`, `mcp start`, `targets add`).
 */
import { Command } from 'commander';

import { killActiveBrowsers } from '../auth/browser/login.js';
import { isHarnessError } from '../errors.js';
import { logger } from '../logger.js';
import { packageVersion } from '../package-version.js';
import { authLoginCommand } from './commands/auth/login.js';
import { authLogoutCommand } from './commands/auth/logout.js';
import { authStatusCommand } from './commands/auth/status.js';
import { doctorCommand } from './commands/doctor.js';
import { mcpStartCommand } from './commands/mcp/start.js';
import { mcpStatusCommand } from './commands/mcp/status.js';
import { setupCommand } from './commands/setup.js';
import { targetsAddCommand } from './commands/targets/add.js';
import { targetsInstallCommand } from './commands/targets/install.js';
import { targetsListCommand } from './commands/targets/list.js';
import { targetsRemoveCommand } from './commands/targets/remove.js';

/** Collects a repeatable `--target` flag, which also accepts comma-separated ids. */
const collectTargets = (value: string, previous: string[] = []): string[] => [...previous, value];

export function createProgram(): Command {
  const program = new Command();

  program
    .name('hydra-onix-mcp')
    .description('Hydra Onix MCP for any coding agent: a local stdio proxy with one-time browser login')
    .version(packageVersion(), '-V, --version', 'Show the version')
    .option('--verbose', 'Show diagnostic output and stack traces', false)
    .hook('preAction', (thisCommand) => {
      logger.setVerbose(Boolean(thisCommand.opts().verbose));
    });

  program
    .command('setup')
    .description('One-command setup: detect agents, register the MCP server, sign in')
    .option('-y, --yes', 'Answer yes to prompts (registers the MCP server without asking)', false)
    .option('--no-mcp', 'Skip MCP registration')
    .option('--no-login', 'Skip signing in to Hydra')
    .option('--target <agent>', 'Coding agent to set up (repeatable; default: detected)', collectTargets)
    .action(async (o: { yes: boolean; mcp: boolean; login: boolean; target?: string[] }) => {
      await setupCommand({ yes: o.yes, mcp: o.mcp, login: o.login, target: o.target });
    });

  program
    .command('doctor')
    .description('Check that everything is set up and list the available commands')
    .option('--json', 'Output machine-readable JSON', false)
    .option('--online', 'Also refresh the session and list the tools on the Hydra MCP server', false)
    .action(async (o: { json: boolean; online: boolean }) => {
      await doctorCommand({ json: o.json, online: o.online });
    });

  const auth = program.command('auth').description('Sign in to Hydra and manage the stored session');

  auth
    .command('login')
    .description('Sign in through a dedicated browser window (or paste cookies with --manual)')
    .option('--manual', 'Paste the session cookies instead of using a browser', false)
    .option('--force', 'Discard the stored session first', false)
    .action(async (o: { manual: boolean; force: boolean }) => {
      await authLoginCommand({ manual: o.manual, force: o.force });
    });

  auth
    .command('logout')
    .description('Remove the stored session and the dedicated browser profile')
    .option('--keep-profile', 'Keep the browser profile (the next login may be silent)', false)
    .action(async (o: { keepProfile: boolean }) => {
      await authLogoutCommand({ keepProfile: o.keepProfile });
    });

  auth
    .command('status')
    .description('Show who is signed in and when the session expires (never prints secrets)')
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (o: { json: boolean }) => {
      await authStatusCommand({ json: o.json });
    });

  const mcp = program.command('mcp').description('Run or inspect the Hydra MCP relay');

  mcp
    .command('start')
    .description('Run the stdio relay to the Hydra MCP server (launched by coding agents)')
    .action(async () => {
      await mcpStartCommand();
    });

  mcp
    .command('status')
    .description('Show MCP registration per agent and the login state')
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (o: { json: boolean }) => {
      await mcpStatusCommand({ json: o.json });
    });

  const targets = program.command('targets').description('Manage which coding agents are set up');

  targets
    .command('list')
    .description('List supported coding agents and whether they are set up')
    .option('--json', 'Output machine-readable JSON', false)
    .action(async (o: { json: boolean }) => {
      await targetsListCommand({ json: o.json });
    });

  targets
    .command('add <agent...>')
    .description('Set up another coding agent and register the MCP server with it')
    .option('-y, --yes', 'Answer yes to prompts (registers the MCP server without asking)', false)
    .option('--no-mcp', 'Skip MCP registration')
    .action(async (agents: string[], o: { yes: boolean; mcp: boolean }) => {
      await targetsAddCommand({ agents, yes: o.yes, mcp: o.mcp });
    });

  targets
    .command('remove <agent...>')
    .description("Stop setting up a coding agent (its config file is left as it is)")
    .action(async (agents: string[]) => {
      await targetsRemoveCommand({ agents });
    });

  targets
    .command('install')
    .description('Register the MCP server with every configured coding agent')
    .option('-y, --yes', 'Answer yes to prompts (registers the MCP server without asking)', false)
    .option('--target <agent>', 'Restrict to one coding agent (repeatable)', collectTargets)
    .action(async (o: { yes: boolean; target?: string[] }) => {
      await targetsInstallCommand({ yes: o.yes, target: o.target });
    });

  return program;
}

/**
 * Prints expected failures as a message plus an actionable hint, with no stack
 * trace unless --verbose. Unexpected errors always show their stack, because
 * those are bugs.
 */
export function reportError(error: unknown): number {
  if (isHarnessError(error)) {
    logger.error(error.message);
    if (error.hint) process.stderr.write(`\n${error.hint}\n`);
    if (logger.isVerbose() && error.stack) process.stderr.write(`\n${error.stack}\n`);
    return error.exitCode;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(err.message);
  process.stderr.write(`\n${err.stack ?? ''}\n`);
  return 1;
}

/** `mcp start` speaks JSON-RPC on stdout: route everything else to stderr before anything runs. */
function isMcpStart(argv: readonly string[]): boolean {
  const words = argv.slice(2).filter((a) => !a.startsWith('-'));
  return words[0] === 'mcp' && words[1] === 'start';
}

/**
 * Ctrl+C (or SIGTERM) exits through `process.exit`, so the store's exit
 * handler still releases a credentials lock held by a login, and kills a
 * login browser this process started. `mcp start` has its own handlers.
 * Returns a function that removes the handlers.
 */
function exitOnSignals(): () => void {
  const handlers = {
    SIGINT: () => {
      killActiveBrowsers();
      process.exit(130);
    },
    SIGTERM: () => {
      killActiveBrowsers();
      process.exit(143);
    },
  };
  process.once('SIGINT', handlers.SIGINT);
  process.once('SIGTERM', handlers.SIGTERM);
  return () => {
    process.off('SIGINT', handlers.SIGINT);
    process.off('SIGTERM', handlers.SIGTERM);
  };
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const mcpStart = isMcpStart(argv);
  if (mcpStart) logger.useStderr();
  const removeSignalHandlers = mcpStart ? undefined : exitOnSignals();
  try {
    await createProgram().parseAsync([...argv]);
  } catch (error) {
    process.exitCode = reportError(error);
  } finally {
    removeSignalHandlers?.();
  }
}
