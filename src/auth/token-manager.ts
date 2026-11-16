/**
 * Hands the MCP relay a valid Hydra access token.
 *
 * In order: reuse the stored token while it is valid beyond the refresh
 * margin; otherwise refresh it through the session endpoint with the stored
 * cookies; when the web session is gone, run the browser login. Every refresh
 * and login runs under the credentials lock (other `mcp start` processes share
 * the file) and re-reads the file first, so a token another process just saved
 * is reused. Inside one process, concurrent callers share a single flight.
 * Never log cookie or token values here.
 */
import { TOKEN_REFRESH_MARGIN_MS } from '../constants.js';
import { HarnessError, commandHint } from '../errors.js';
import { logger } from '../logger.js';
import type { HydraPaths } from '../paths.js';
import { browserLogin } from './browser/login.js';
import { HydraUnavailableError, SessionExpiredError, refreshSession } from './session.js';
import type { SessionResult, StoredCookie } from './session.js';
import { CorruptCredentialsError, CredentialStore, toCredentials, type AppCredentials } from './store.js';

/** The web session is gone and a login could not restore it. */
export class LoginRequiredError extends HarnessError {
  constructor(options: { cause?: unknown } = {}) {
    const cause = options.cause;
    super('Hydra login required: run `npx @andygo.dev/hydra-onix-mcp auth login`', {
      // The login error's own hint is the more specific advice (e.g. `--manual`).
      hint: (cause instanceof HarnessError && cause.hint) || commandHint('hydra-onix-mcp auth login'),
      cause,
    });
    this.name = 'LoginRequiredError';
  }
}

export interface TokenManagerOptions {
  store: CredentialStore;
  appUrl: string;
  refresh?: (appUrl: string, cookies: StoredCookie[]) => Promise<SessionResult>;
  login: (o: { interactive: boolean }) => Promise<SessionResult>;
  now?: () => Date;
}

type ValidCredentials = AppCredentials & { accessToken: string };

export class TokenManager {
  private readonly store: CredentialStore;
  private readonly appUrl: string;
  private readonly refresh: (appUrl: string, cookies: StoredCookie[]) => Promise<SessionResult>;
  private readonly login: (o: { interactive: boolean }) => Promise<SessionResult>;
  private readonly now: () => Date;
  private pending?: Promise<string>;

  constructor(o: TokenManagerOptions) {
    this.store = o.store;
    this.appUrl = o.appUrl;
    this.now = o.now ?? (() => new Date());
    this.refresh = o.refresh ?? ((appUrl, cookies) => refreshSession(appUrl, cookies, { now: this.now }));
    this.login = o.login;
  }

  async getToken(o: { interactive: boolean }): Promise<string> {
    const stored = await this.store.read();
    if (this.isValid(stored)) return stored.accessToken;
    return this.flight(undefined, o.interactive);
  }

  /** The MCP server rejected `usedToken`: get a different one, refreshing if needed. */
  async onUnauthorized(usedToken: string, o: { interactive: boolean }): Promise<string> {
    if (this.pending) {
      // A flight that started before the 401 may still settle on the rejected token.
      const token = await this.pending;
      if (token !== usedToken) return token;
    }
    return this.flight(usedToken, o.interactive);
  }

  private flight(rejected: string | undefined, interactive: boolean): Promise<string> {
    this.pending ??= this.renew(rejected, interactive).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private renew(rejected: string | undefined, interactive: boolean): Promise<string> {
    return this.store.withLock(async () => {
      const current = await this.store.read();
      if (this.isValid(current) && current.accessToken !== rejected) return current.accessToken;

      let result: SessionResult | undefined;
      if (current && current.cookies.length > 0) {
        try {
          result = await this.refresh(this.appUrl, current.cookies);
        } catch (error) {
          if (!(error instanceof SessionExpiredError)) throw error;
        }
      }
      result ??= await this.runLogin(interactive);

      await this.store.write(toCredentials(result, this.now()));
      return result.accessToken;
    });
  }

  private async runLogin(interactive: boolean): Promise<SessionResult> {
    try {
      return await this.login({ interactive });
    } catch (error) {
      if (error instanceof HydraUnavailableError || error instanceof CorruptCredentialsError) throw error;
      throw new LoginRequiredError({ cause: error });
    }
  }

  private isValid(c: AppCredentials | undefined): c is ValidCredentials {
    if (!c?.accessToken || !c.accessTokenExpires) return false;
    const expires = Date.parse(c.accessTokenExpires);
    return !Number.isNaN(expires) && expires - this.now().getTime() > TOKEN_REFRESH_MARGIN_MS;
  }
}

export function createTokenManager(
  paths: HydraPaths,
  appUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): TokenManager {
  return new TokenManager({
    store: new CredentialStore(paths, appUrl),
    appUrl,
    login: ({ interactive }) =>
      browserLogin({
        appUrl,
        profileDir: paths.browserProfile,
        interactive,
        executable: env.HYDRA_ONIX_MCP_BROWSER || undefined,
        log: (m) => logger.info(m),
      }),
  });
}
