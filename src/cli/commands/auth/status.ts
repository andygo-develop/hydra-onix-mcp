/**
 * `hydra-onix-mcp auth status`: who is signed in, where the credentials live,
 * when the session and the access token expire, and which browser would be
 * used. Never prints cookies or tokens: the result is built field by field
 * from the stored entry, never by spreading it.
 */
import { findBrowser } from '../../../auth/browser/find.js';
import type { SessionUser } from '../../../auth/session.js';
import { CredentialStore, type AppCredentials } from '../../../auth/store.js';
import { appUrl } from '../../../constants.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';

export interface AuthStatus {
  loggedIn: boolean;
  appUrl: string;
  user?: SessionUser;
  credentialsFile: string;
  sessionExpires?: string;
  accessTokenExpires?: string;
  /** The browser `auth login` would use, if one is found. */
  browser?: string;
}

export interface AuthStatusOptions {
  env?: NodeJS.ProcessEnv;
  /** Browser lookup; defaults to `findBrowser` with `env`. */
  find?: () => Promise<string | undefined>;
}

/** A stored entry with cookies whose web session has not (yet) expired. */
export function hasLiveSession(c: AppCredentials | undefined, now = Date.now()): boolean {
  if (!c || c.cookies.length === 0) return false;
  if (!c.sessionExpires) return true;
  const expires = Date.parse(c.sessionExpires);
  return Number.isNaN(expires) || expires > now;
}

/** Display name for a session user: email first, then name. */
export function describeUser(user: SessionUser | undefined): string | undefined {
  return user?.email || user?.name || undefined;
}

export async function runAuthStatus(o: AuthStatusOptions = {}): Promise<AuthStatus> {
  const env = o.env ?? process.env;
  const paths = hydraPaths(env);
  const app = appUrl(env);
  const stored = await new CredentialStore(paths, app).read();
  const browser = await (o.find ?? (() => findBrowser({ env })))();

  const status: AuthStatus = {
    loggedIn: hasLiveSession(stored),
    appUrl: app,
    credentialsFile: paths.credentialsFile,
  };
  if (stored?.user) status.user = { name: stored.user.name, email: stored.user.email };
  if (stored?.sessionExpires) status.sessionExpires = stored.sessionExpires;
  if (stored?.accessTokenExpires) status.accessTokenExpires = stored.accessTokenExpires;
  if (browser) status.browser = browser;
  return status;
}

/** The human-readable lines shared with `mcp status`. */
export function printAuthStatus(status: AuthStatus): void {
  if (status.loggedIn) {
    const who = describeUser(status.user);
    logger.success(who ? `Signed in to Hydra as ${who}` : 'Signed in to Hydra');
  } else {
    logger.warn('Not signed in to Hydra');
  }
  const row = (label: string, value: string): void => logger.print(`  ${`${label}:`.padEnd(22)} ${value}`);
  row('App', status.appUrl);
  row('Credentials', status.credentialsFile);
  if (status.sessionExpires) row('Session expires', status.sessionExpires);
  if (status.accessTokenExpires) row('Access token expires', status.accessTokenExpires);
  row('Browser', status.browser ?? 'none found (use `auth login --manual`)');
  if (!status.loggedIn) {
    logger.print();
    logger.print('Run:');
    logger.print('  npx @andygo.dev/hydra-onix-mcp auth login');
  }
}

export async function authStatusCommand(o: AuthStatusOptions & { json?: boolean } = {}): Promise<void> {
  const status = await runAuthStatus(o);
  if (o.json) {
    logger.print(JSON.stringify(status, null, 2));
    return;
  }
  printAuthStatus(status);
}
