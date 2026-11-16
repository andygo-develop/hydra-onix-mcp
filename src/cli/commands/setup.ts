/**
 * `hydra-onix-mcp setup`: the one command a new user runs.
 *
 * Detect the coding agents → record them in the config → register the server
 * with each (asking per agent unless `-y`) → sign in to Hydra when there is no
 * working session. Every step is idempotent, so re-running it is safe.
 */
import { ensureConfig, saveConfig } from '../../config/config.js';
import type { UserConfig } from '../../config/schema.js';
import type { ClaudeCli } from '../../generators/claude-cli.js';
import type { TargetMcpOutcome } from '../../generators/targets/install.js';
import { parseTargetIds, TARGETS } from '../../generators/targets/registry.js';
import { logger } from '../../logger.js';
import { hydraPaths } from '../../paths.js';
import {
  hasWorkingSession,
  reportSignedIn,
  runAuthLogin,
  type AuthLoginOptions,
  type AuthLoginResult,
} from './auth/login.js';
import { exitNonZeroOnFailures, registerTargetsInteractively } from './targets/install.js';

export interface SetupOptions {
  /** Answer yes to the registration prompts. */
  yes?: boolean;
  /** `false` skips the MCP registration. */
  mcp?: boolean;
  /** `false` skips signing in. */
  login?: boolean;
  /** Coding agents to set up; recorded as the configured ones. */
  target?: readonly string[];
  env?: NodeJS.ProcessEnv;
  claude?: ClaudeCli;
  /** Passed through to `auth login` (tests inject the login here). */
  loginOptions?: Pick<AuthLoginOptions, 'login' | 'pasteLogin' | 'interactiveTerminal'>;
}

export interface SetupResult {
  config: UserConfig;
  /** The config was written for the first time. */
  created: boolean;
  registrations: TargetMcpOutcome[];
  login: 'skipped' | 'existing' | AuthLoginResult;
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export async function runSetup(o: SetupOptions = {}): Promise<SetupResult> {
  const env = o.env ?? process.env;
  const paths = hydraPaths(env);
  const withMcp = o.mcp !== false;
  const withLogin = o.login !== false;
  const total = 1 + (withMcp ? 1 : 0) + (withLogin ? 1 : 0);
  let n = 0;
  const step = (message: string): void => logger.info(`[${++n}/${total}] ${message}`);

  step('Detecting coding agents...');
  const requested = o.target?.length ? parseTargetIds(o.target) : undefined;
  const ensured = await ensureConfig(paths, { targets: requested });
  let config = ensured.config;
  // `--target` means "exactly these"; `targets add` is the additive one.
  if (requested && !same(requested, config.targets)) {
    config = { ...config, targets: [...requested] };
    await saveConfig(paths, config);
  }
  logger.success(
    `Setting up for: ${config.targets.map((id) => TARGETS[id].label).join(', ')}` +
      (ensured.created ? ` (config created at ${paths.configFile})` : ''),
  );

  let registrations: TargetMcpOutcome[] = [];
  if (withMcp) {
    step('Registering the MCP server...');
    registrations = await registerTargetsInteractively(config.targets, { yes: o.yes, env, claude: o.claude });
  }

  let login: SetupResult['login'] = 'skipped';
  if (withLogin) {
    step('Signing in to Hydra...');
    if (await hasWorkingSession(env)) {
      login = 'existing';
      logger.success('Already signed in to Hydra');
    } else {
      login = await runAuthLogin({ ...o.loginOptions, env });
      reportSignedIn(login);
    }
  }

  return { config, created: ensured.created, registrations, login };
}

export async function setupCommand(o: SetupOptions = {}): Promise<void> {
  const result = await runSetup(o);
  const labels = result.config.targets.map((id) => TARGETS[id].label).join(', ');

  logger.print();
  const failed = result.registrations.filter((r) => r.error).map((r) => TARGETS[r.target].label);
  if (failed.length > 0) {
    logger.warn(`Setup complete except for ${failed.join(', ')}: fix the file(s) named above and re-run setup.`);
  } else {
    logger.success('Setup complete');
  }
  if (result.login === 'skipped') {
    logger.print();
    logger.print('Sign in before first use:');
    logger.print('  npx @andygo.dev/hydra-onix-mcp auth login');
  }
  logger.print();
  logger.print(`Restart ${labels} if already running.`);
  exitNonZeroOnFailures(result.registrations);
}
