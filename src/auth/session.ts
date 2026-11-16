/**
 * Turns stored next-auth session cookies into a Hydra access token.
 *
 * `GET <app>/api/auth/session` returns `{ user, expires, accessToken }` while
 * the web session is live and `{}` once it is gone. next-auth also slides the
 * session via `Set-Cookie`, so the cookie set is kept current from every
 * response. Neither errors nor logs here may contain cookie or token values.
 */
import { FALLBACK_TOKEN_TTL_MS, SESSION_COOKIE_PREFIX } from '../constants.js';
import { HarnessError, commandHint } from '../errors.js';

export interface StoredCookie {
  name: string;
  value: string;
  /** ISO timestamp; absent for session cookies. */
  expires?: string;
}

export interface SessionUser {
  name?: string;
  email?: string;
}

export interface SessionResult {
  accessToken: string;
  /** ISO timestamp of the access token's expiry. */
  accessTokenExpires: string;
  /** ISO timestamp of the web session's expiry, when reported. */
  sessionExpires?: string;
  user?: SessionUser;
  cookies: StoredCookie[];
}

/** The web session is gone; the user must log in again. */
export class SessionExpiredError extends HarnessError {
  constructor(options: { cause?: unknown } = {}) {
    super('The Hydra web session has expired.', {
      hint: commandHint('hydra-onix-mcp auth login'),
      cause: options.cause,
    });
    this.name = 'SessionExpiredError';
  }
}

/** Hydra could not be reached or answered unusably; the cookies are still good. */
export class HydraUnavailableError extends HarnessError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      hint: 'Hydra may be down or unreachable. Try again in a moment.',
      cause: options.cause,
    });
    this.name = 'HydraUnavailableError';
  }
}

export function cookieHeader(cookies: StoredCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

interface ParsedSetCookie {
  name: string;
  value: string;
  remove: boolean;
  expires?: string;
}

function parseSetCookie(line: string, now: Date): ParsedSetCookie | undefined {
  const [pair = '', ...attributes] = line.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();

  let maxAge: number | undefined;
  let expiresAt: number | undefined;
  for (const attribute of attributes) {
    const idx = attribute.indexOf('=');
    if (idx < 0) continue;
    const key = attribute.slice(0, idx).trim().toLowerCase();
    const attrValue = attribute.slice(idx + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) maxAge = seconds;
    } else if (key === 'expires') {
      const time = Date.parse(attrValue);
      if (!Number.isNaN(time)) expiresAt = time;
    }
  }

  // Max-Age wins over Expires (RFC 6265).
  const expiryMs = maxAge !== undefined ? now.getTime() + maxAge * 1000 : expiresAt;
  const remove = (maxAge !== undefined && maxAge <= 0) || (expiryMs !== undefined && expiryMs <= now.getTime());
  return {
    name,
    value,
    remove,
    expires: expiryMs !== undefined ? new Date(expiryMs).toISOString() : undefined,
  };
}

/** Applies response `Set-Cookie` lines to the stored set (session cookies only). */
export function applySetCookies(cookies: StoredCookie[], setCookie: string[], now: Date): StoredCookie[] {
  let result = [...cookies];
  for (const line of setCookie) {
    const parsed = parseSetCookie(line, now);
    if (!parsed || !parsed.name.startsWith(SESSION_COOKIE_PREFIX)) continue;
    result = result.filter((c) => c.name !== parsed.name);
    if (parsed.remove) continue;
    const cookie: StoredCookie = { name: parsed.name, value: parsed.value };
    if (parsed.expires) cookie.expires = parsed.expires;
    result.push(cookie);
  }
  return result;
}

/** A JWT's `exp` claim when readable, otherwise `now` plus the fallback TTL. */
export function tokenExpiry(accessToken: string, now: Date): string {
  const fallback = new Date(now.getTime() + FALLBACK_TOKEN_TTL_MS).toISOString();
  try {
    const segment = accessToken.split('.')[1];
    if (!segment) return fallback;
    const payload: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return fallback;
    return new Date(exp * 1000).toISOString();
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export async function refreshSession(
  appUrl: string,
  cookies: StoredCookie[],
  opts: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<SessionResult> {
  const doFetch = opts.fetch ?? fetch;
  const now = (opts.now ?? (() => new Date()))();
  const url = `${appUrl.replace(/\/+$/, '')}/api/auth/session`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { cookie: cookieHeader(cookies), accept: 'application/json' },
      redirect: 'manual',
    });
  } catch (error) {
    throw new HydraUnavailableError('Could not reach the Hydra web app.', { cause: error });
  }

  const { status } = response;
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
    throw new SessionExpiredError();
  }
  if (status < 200 || status >= 300) {
    throw new HydraUnavailableError(`The Hydra web app answered with HTTP ${status}.`);
  }
  if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('json')) {
    throw new HydraUnavailableError('The Hydra web app returned a non-JSON session response.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new HydraUnavailableError('The Hydra web app returned an unreadable session response.', {
      cause: error,
    });
  }

  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const accessToken = optionalString(record.accessToken);
  if (!accessToken) throw new SessionExpiredError();

  const result: SessionResult = {
    accessToken,
    accessTokenExpires: tokenExpiry(accessToken, now),
    cookies: applySetCookies(cookies, response.headers.getSetCookie(), now),
  };
  const sessionExpires = optionalString(record.expires);
  if (sessionExpires) result.sessionExpires = sessionExpires;
  if (typeof record.user === 'object' && record.user !== null) {
    const raw = record.user as Record<string, unknown>;
    const user: SessionUser = {};
    const name = optionalString(raw.name);
    const email = optionalString(raw.email);
    if (name) user.name = name;
    if (email) user.email = email;
    result.user = user;
  }
  return result;
}
