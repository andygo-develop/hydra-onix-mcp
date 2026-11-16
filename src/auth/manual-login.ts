/**
 * Manual login for machines without a Chromium browser: the user pastes their
 * next-auth session cookies, which are validated through the session endpoint.
 * Cookie values are never printed or put in error messages.
 */
import { SESSION_COOKIE_PREFIX } from '../constants.js';
import { HarnessError, commandHint } from '../errors.js';
import { openUrl } from './open-url.js';
import { SessionExpiredError, refreshSession, type SessionResult, type StoredCookie } from './session.js';

const MAX_ATTEMPTS = 3;

function unquote(s: string): string {
  return s.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

/**
 * Accepts a full `Cookie:` header, `name=value` lines, or a bare value (taken
 * as the unchunked session token). Only session-token cookies are kept.
 */
export function parseCookieInput(input: string): StoredCookie[] {
  const text = unquote(input.replace(/^\s*cookie:\s*/i, ''));
  if (!text) {
    return [];
  }
  const cookies: StoredCookie[] = [];
  for (const part of text.split(/[;\n\r]+/)) {
    const piece = unquote(part);
    if (!piece) {
      continue;
    }
    const eq = piece.indexOf('=');
    if (eq === -1) {
      // A bare value only makes sense as the whole input.
      if (text === piece) {
        return [{ name: SESSION_COOKIE_PREFIX, value: piece }];
      }
      continue;
    }
    const name = piece.slice(0, eq).trim();
    const value = unquote(piece.slice(eq + 1));
    if (name.startsWith(SESSION_COOKIE_PREFIX) && value) {
      cookies.push({ name, value });
    }
  }
  return cookies;
}

export interface ManualLoginOptions {
  appUrl: string;
  ask: (question: string) => Promise<string>;
  open?: (url: string) => void;
  validate?: (cookies: StoredCookie[]) => Promise<SessionResult>;
  print?: (message: string) => void;
}

export async function manualLogin(o: ManualLoginOptions): Promise<SessionResult> {
  const open = o.open ?? ((url: string) => openUrl(url));
  const print = o.print ?? ((m: string) => console.error(m));
  const validate = o.validate ?? ((c: StoredCookie[]) => refreshSession(o.appUrl, c));
  const url = `${o.appUrl}/`;

  print(
    [
      `Opening ${url} in your browser. Log in to Hydra there, then copy your session cookies:`,
      `  - DevTools > Application > Cookies > projects.onix.hydra-systems.net: copy the value of each`,
      `    ${SESSION_COOKIE_PREFIX}.0 and ${SESSION_COOKIE_PREFIX}.1 cookie (Hydra's session is split into two chunks), or`,
      `  - DevTools > Network > any request: copy the "Cookie" request header.`,
      `Paste it below (input is hidden). For separate values, enter name=value pairs separated by ";".`,
    ].join('\n'),
  );
  open(url);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cookies = parseCookieInput(await o.ask('Cookies: '));
    if (cookies.length === 0) {
      print(`No ${SESSION_COOKIE_PREFIX} cookie found in that input.`);
      continue;
    }
    try {
      return await validate(cookies);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        throw new HarnessError('Hydra did not accept those cookies.', {
          hint: `Make sure you are logged in and copied every ${SESSION_COOKIE_PREFIX} chunk. ${commandHint('hydra-onix-mcp auth login --manual')}`,
          cause: error,
        });
      }
      throw error;
    }
  }
  throw new HarnessError(`No session cookie was provided after ${MAX_ATTEMPTS} attempts.`, {
    hint: commandHint('hydra-onix-mcp auth login --manual'),
  });
}
