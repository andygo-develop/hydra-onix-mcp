/**
 * Fixed names, endpoints and timings shared across the CLI and the proxy.
 *
 * Endpoints can be overridden through the environment so tests and staging
 * setups never need code changes; the functions take `env` explicitly so
 * tests can pass their own object instead of mutating `process.env`.
 */
export const PACKAGE_NAME = '@andygo.dev/hydra-onix-mcp';
export const SERVER_NAME = 'hydra-onix';

export const DEFAULT_MCP_URL = 'https://api.projects.onix.hydra-systems.net/mcp';
export const DEFAULT_APP_URL = 'https://projects.onix.hydra-systems.net';

/** Name prefix of the NextAuth session cookie (the `__Secure-` form is HTTPS-only). */
export const SESSION_COOKIE_PREFIX = '__Secure-next-auth.session-token';

/** Refresh a token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Assumed token lifetime when the server does not state one (25 min). */
export const FALLBACK_TOKEN_TTL_MS = 1_500_000;
/** How long an interactive login may take (5 min). */
export const LOGIN_TIMEOUT_MS = 300_000;
/** How long a headless, no-prompt login attempt may take. */
export const SILENT_LOGIN_TIMEOUT_MS = 20_000;
/** A login lock older than this is considered abandoned. */
export const LOCK_STALE_MS = 60_000;
/** Interval between checks for the session cookie during login. */
export const COOKIE_POLL_MS = 1_000;

/** JSON-RPC error code returned when the user must log in again. */
export const LOGIN_REQUIRED_CODE = -32001;

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function mcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return stripTrailingSlashes(env.HYDRA_ONIX_MCP_URL || DEFAULT_MCP_URL);
}

export function appUrl(env: NodeJS.ProcessEnv = process.env): string {
  return stripTrailingSlashes(env.HYDRA_ONIX_MCP_APP_URL || DEFAULT_APP_URL);
}
