/**
 * `hydra-onix-mcp auth login`: sign in to Hydra and store the session.
 *
 * The browser login (silent first, then a visible window) runs under the
 * credentials lock, as the TokenManager's logins do, so it never races a
 * running `mcp start` that is refreshing or logging in itself. Without a
 * browser, a terminal gets the paste fallback; anything else gets the error.
 * Never prints cookies or tokens.
 */
import { findBrowser } from '../../../auth/browser/find.js';
import { browserLogin, NoBrowserError } from '../../../auth/browser/login.js';
import { manualLogin } from '../../../auth/manual-login.js';
import { LoginRequiredError, TokenManager } from '../../../auth/token-manager.js';
import { SessionExpiredError, type SessionResult, type SessionUser } from '../../../auth/session.js';
import { CredentialStore, toCredentials } from '../../../auth/store.js';
import { appUrl } from '../../../constants.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';
import { askSecret } from '../../prompt.js';
import { describeUser } from './status.js';

export type LoginFn = (o: { interactive: boolean }) => Promise<SessionResult>;

export interface AuthLoginOptions {
  /** Paste the cookies instead of using a browser. */
  manual?: boolean;
  /** Discard the stored session first (also clears a corrupt file). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /** The browser login; defaults to `browserLogin` with the dedicated profile. */
  login?: LoginFn;
  /** The paste login; defaults to `manualLogin` with a hidden prompt. */
  pasteLogin?: () => Promise<SessionResult>;
  /** Whether stdin is a terminal (decides the no-browser fallback). */
  interactiveTerminal?: boolean;
}

export interface AuthLoginResult {
  user?: SessionUser;
  sessionExpires?: string;
}

function defaultBrowserLogin(env: NodeJS.ProcessEnv): LoginFn {
  const paths = hydraPaths(env);
  return ({ interactive }) =>
    browserLogin({
      appUrl: appUrl(env),
      profileDir: paths.browserProfile,
      interactive,
      executable: env.HYDRA_ONIX_MCP_BROWSER || undefined,
      find: () => findBrowser({ env }),
      log: (m) => logger.info(m),
    });
}

export async function runAuthLogin(o: AuthLoginOptions = {}): Promise<AuthLoginResult> {
  const env = o.env ?? process.env;
  const app = appUrl(env);
  const store = new CredentialStore(hydraPaths(env), app);
  const login = o.login ?? defaultBrowserLogin(env);
  const paste = o.pasteLogin ?? (() => manualLogin({ appUrl: app, ask: askSecret }));
  const terminal = o.interactiveTerminal ?? Boolean(process.stdin.isTTY);

  const signIn = async (): Promise<SessionResult> => {
    if (o.manual) return paste();
    try {
      return await login({ interactive: true });
    } catch (error) {
      if (!(error instanceof NoBrowserError) || !terminal) throw error;
      logger.warn(error.message);
      logger.info('Falling back to pasting your session cookies.');
      return paste();
    }
  };

  return store.withLock(async () => {
    if (o.force) {
      await store.remove();
    } else {
      // Fails fast on a corrupt file (its hint names --force), before a login is wasted.
      await store.read();
    }
    const result = await signIn();
    await store.write(toCredentials(result, new Date()));
    const out: AuthLoginResult = {};
    if (result.user) out.user = result.user;
    if (result.sessionExpires) out.sessionExpires = result.sessionExpires;
    return out;
  });
}

/**
 * Whether the stored session still yields a token, refreshing it if needed but
 * never logging in (so never launching a browser).
 */
export async function hasWorkingSession(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const app = appUrl(env);
  const tokens = new TokenManager({
    store: new CredentialStore(hydraPaths(env), app),
    appUrl: app,
    login: async () => {
      throw new SessionExpiredError();
    },
  });
  try {
    await tokens.getToken({ interactive: false });
    return true;
  } catch (error) {
    if (error instanceof LoginRequiredError) return false;
    throw error;
  }
}

export function reportSignedIn(result: AuthLoginResult): void {
  const who = describeUser(result.user);
  logger.success(who ? `Signed in to Hydra as ${who}` : 'Signed in to Hydra');
}

export async function authLoginCommand(o: AuthLoginOptions = {}): Promise<void> {
  reportSignedIn(await runAuthLogin(o));
}
