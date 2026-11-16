/**
 * Programmatic entry point.
 *
 * The CLI is the primary interface, but the pieces are exported so the relay,
 * login flows and agent registration can be embedded in other tooling.
 * Importing this module has no side effects.
 */
export {
  PACKAGE_NAME,
  SERVER_NAME,
  DEFAULT_MCP_URL,
  DEFAULT_APP_URL,
  SESSION_COOKIE_PREFIX,
  TOKEN_REFRESH_MARGIN_MS,
  FALLBACK_TOKEN_TTL_MS,
  LOGIN_TIMEOUT_MS,
  SILENT_LOGIN_TIMEOUT_MS,
  LOCK_STALE_MS,
  COOKIE_POLL_MS,
  LOGIN_REQUIRED_CODE,
  mcpUrl,
  appUrl,
} from './constants.js';
export { hydraPaths, type HydraPaths } from './paths.js';
export { HarnessError, isHarnessError, commandHint } from './errors.js';
export { packageVersion } from './package-version.js';

export {
  refreshSession,
  cookieHeader,
  applySetCookies,
  tokenExpiry,
  SessionExpiredError,
  HydraUnavailableError,
  type StoredCookie,
  type SessionUser,
  type SessionResult,
} from './auth/session.js';
export { CredentialStore, toCredentials, CorruptCredentialsError, type AppCredentials } from './auth/store.js';
export { TokenManager, createTokenManager, LoginRequiredError, type TokenManagerOptions } from './auth/token-manager.js';

export { findBrowser, type FindBrowserOptions } from './auth/browser/find.js';
export {
  browserLogin,
  captureSession,
  chromeArgs,
  launchChrome,
  appCookies,
  LoginCancelledError,
  LoginTimeoutError,
  BrowserLaunchError,
  NoBrowserError,
  type BrowserLauncher,
} from './auth/browser/login.js';
export { manualLogin, parseCookieInput, type ManualLoginOptions } from './auth/manual-login.js';
export { openUrl, type OpenUrlOptions } from './auth/open-url.js';

export { startRelay, authorizedFetch, type TokenSource, type RelayOptions, type Relay } from './proxy/relay.js';

export { TARGETS, ALL_TARGETS, requireTarget, parseTargetIds, detectTargets } from './generators/targets/registry.js';
export {
  TARGET_IDS,
  type TargetId,
  type TargetDefinition,
  type McpStyle,
  type TargetMcp,
} from './generators/targets/types.js';
export {
  inspectTargetRegistration,
  registerTargetServer,
  type TargetRegistrationState,
  type TargetRegisterResult,
  type InspectOptions,
  type RegisterOptions,
} from './generators/targets/mcp.js';
export { registerTargets, type RegisterTargetsOptions, type TargetMcpOutcome } from './generators/targets/install.js';
export { mcpLaunch, mcpCommandLine } from './generators/mcp-entry.js';
export { defaultClaudeCli, type ClaudeCli } from './generators/claude-cli.js';

export { loadConfig, saveConfig, ensureConfig } from './config/config.js';
export { configSchema, type UserConfig } from './config/schema.js';

export {
  runDoctor,
  DOCTOR_COMMANDS,
  type CheckStatus,
  type DoctorCheck,
  type DoctorCommandInfo,
  type DoctorReport,
  type DoctorOptions,
} from './cli/commands/doctor.js';
