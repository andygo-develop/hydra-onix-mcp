/**
 * Captures the Hydra web session from a dedicated browser profile.
 *
 * The browser is driven over `--remote-debugging-pipe` (no port is opened).
 * We poll `Storage.getCookies` until the next-auth session cookies appear and
 * the app accepts them, then close the browser. Neither messages nor errors
 * here may contain cookie or token values.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';

import { COOKIE_POLL_MS, LOGIN_TIMEOUT_MS, SESSION_COOKIE_PREFIX, SILENT_LOGIN_TIMEOUT_MS } from '../../constants.js';
import { HarnessError, commandHint } from '../../errors.js';
import { refreshSession, SessionExpiredError, type SessionResult, type StoredCookie } from '../session.js';
import { connectPipe, type CdpConnection } from './cdp-pipe.js';
import { findBrowser } from './find.js';

export type BrowserLauncher = (a: {
  executable: string;
  profileDir: string;
  url: string;
  headless: boolean;
}) => Promise<{ cdp: CdpConnection; kill(): void }>;

type Validate = (cookies: StoredCookie[]) => Promise<SessionResult>;

export class LoginCancelledError extends HarnessError {
  constructor() {
    super('Login cancelled: the browser window was closed.', {
      hint: commandHint('hydra-onix-mcp auth login'),
    });
    this.name = 'LoginCancelledError';
  }
}

export class LoginTimeoutError extends HarnessError {
  constructor(lastError?: string) {
    const base = commandHint('hydra-onix-mcp auth login');
    super('Timed out waiting for the Hydra sign-in to complete.', {
      hint: lastError ? `${base}\n\nLast error: ${lastError}` : base,
    });
    this.name = 'LoginTimeoutError';
  }
}

export class NoBrowserError extends HarnessError {
  constructor() {
    super('No supported browser (Chrome, Chromium, Edge or Brave) was found.', {
      hint:
        'Run `hydra-onix-mcp auth login --manual` to paste your session cookies instead, ' +
        'or set HYDRA_ONIX_MCP_BROWSER to the path of a Chromium-based browser.',
    });
    this.name = 'NoBrowserError';
  }
}

export function chromeArgs(profileDir: string, url: string, headless: boolean): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []),
    '--new-window',
    url,
  ];
}

export const launchChrome: BrowserLauncher = async ({ executable, profileDir, url, headless }) => {
  const child = spawn(executable, chromeArgs(profileDir, url, headless), {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const toBrowser = child.stdio[3] as Writable | null;
  const fromBrowser = child.stdio[4] as Readable | null;
  const stderr = child.stdio[2] as Readable | null;
  // Drain so a chatty browser can never block on a full pipe.
  stderr?.resume();
  stderr?.on('error', () => undefined);
  child.on('error', () => undefined);
  toBrowser?.on('error', () => undefined);

  const kill = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  if (!toBrowser || !fromBrowser) {
    kill();
    throw new HarnessError('Could not open the browser DevTools pipe.');
  }
  return { cdp: connectPipe(toBrowser, fromBrowser), kill };
};

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

/** Session cookies that belong to the app host (not Passport or other hosts). */
export function appCookies(cdpCookies: CdpCookie[], appUrl: string): StoredCookie[] {
  const host = new URL(appUrl).hostname;
  const result: StoredCookie[] = [];
  for (const c of cdpCookies) {
    if (!c.name.startsWith(SESSION_COOKIE_PREFIX)) continue;
    if (c.domain !== host && c.domain !== `.${host}`) continue;
    const cookie: StoredCookie = { name: c.name, value: c.value };
    if (typeof c.expires === 'number' && c.expires > 0) cookie.expires = new Date(c.expires * 1000).toISOString();
    result.push(cookie);
  }
  return result;
}

function cookieKey(cookies: StoredCookie[]): string {
  return JSON.stringify(cookies.map((c) => [c.name, c.value]).sort());
}

export async function captureSession(o: {
  appUrl: string;
  executable: string;
  profileDir: string;
  headless: boolean;
  timeoutMs: number;
  pollMs?: number;
  launch?: BrowserLauncher;
  validate?: Validate;
}): Promise<SessionResult> {
  const launch = o.launch ?? launchChrome;
  const pollMs = o.pollMs ?? COOKIE_POLL_MS;
  const validate = o.validate ?? ((cookies) => refreshSession(o.appUrl, cookies));
  const deadline = Date.now() + o.timeoutMs;

  const { cdp, kill } = await launch({
    executable: o.executable,
    profileDir: o.profileDir,
    url: `${o.appUrl.replace(/\/+$/, '')}/`,
    headless: o.headless,
  });

  try {
    let closed = false;
    void cdp.closed.then(() => {
      closed = true;
    });
    let lastKey: string | undefined;
    let lastError: string | undefined;

    while (Date.now() < deadline) {
      if (closed) throw new LoginCancelledError();
      let cookies: StoredCookie[] = [];
      try {
        const reply = await cdp.send<{ cookies?: CdpCookie[] }>('Storage.getCookies');
        cookies = appCookies(reply.cookies ?? [], o.appUrl);
      } catch {
        if (closed) throw new LoginCancelledError();
      }

      const key = cookieKey(cookies);
      if (cookies.length > 0 && key !== lastKey) {
        lastKey = key;
        try {
          const session = await validate(cookies);
          await cdp.send('Browser.close').catch(() => undefined);
          return session;
        } catch (error) {
          if (!(error instanceof SessionExpiredError)) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        void cdp.closed.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (closed) throw new LoginCancelledError();
    throw new LoginTimeoutError(lastError);
  } finally {
    kill();
    cdp.dispose();
  }
}

export async function browserLogin(o: {
  appUrl: string;
  profileDir: string;
  interactive: boolean;
  executable?: string;
  find?: () => Promise<string | undefined>;
  launch?: BrowserLauncher;
  validate?: Validate;
  silentTimeoutMs?: number;
  timeoutMs?: number;
  log?: (m: string) => void;
}): Promise<SessionResult> {
  const executable = o.executable ?? (await (o.find ?? findBrowser)());
  if (!executable) throw new NoBrowserError();
  await mkdir(o.profileDir, { recursive: true, mode: 0o700 });

  const base = {
    appUrl: o.appUrl,
    executable,
    profileDir: o.profileDir,
    launch: o.launch,
    validate: o.validate,
  };
  try {
    return await captureSession({ ...base, headless: true, timeoutMs: o.silentTimeoutMs ?? SILENT_LOGIN_TIMEOUT_MS });
  } catch (error) {
    const recoverable = error instanceof LoginTimeoutError || error instanceof LoginCancelledError;
    if (!recoverable || !o.interactive) throw error;
  }
  o.log?.(`Opening your browser to sign in to Hydra (profile: ${o.profileDir})...`);
  return captureSession({ ...base, headless: false, timeoutMs: o.timeoutMs ?? LOGIN_TIMEOUT_MS });
}
