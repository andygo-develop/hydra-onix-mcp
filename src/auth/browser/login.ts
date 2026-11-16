/**
 * Captures the Hydra web session from a dedicated browser profile.
 *
 * The browser is driven over `--remote-debugging-pipe` (no port is opened).
 * We poll `Storage.getCookies` until the next-auth session cookies appear and
 * the app accepts them, then close the browser. Neither messages nor errors
 * here may contain cookie or token values.
 */
import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
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
}) => Promise<{
  cdp: CdpConnection;
  kill(): void;
  /** Set by launchers that can tell the browser died right after starting. */
  launchFailure?(): BrowserLaunchError | undefined;
}>;

/** How soon after launch an exit counts as a failed launch rather than a closed window. */
const EARLY_EXIT_MS = 1_000;
/** How long to let the browser flush its profile after `Browser.close`. */
const SHUTDOWN_GRACE_MS = 5_000;

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

export class BrowserLaunchError extends HarnessError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, {
      hint:
        'Check HYDRA_ONIX_MCP_BROWSER, or run `hydra-onix-mcp auth login --manual` to paste your session cookies instead.',
      cause: options.cause,
    });
    this.name = 'BrowserLaunchError';
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

/** Kill functions of the browsers this process launched and that are still running. */
const activeBrowsers = new Set<() => void>();
/** Set by `killActiveBrowsers`: the process is exiting, so no browser may start. */
let shuttingDown = false;

/**
 * Kills every browser this process launched that is still running, and stops
 * any more from starting. For a shutdown (`mcp start` on SIGTERM / stdin
 * close, or a signal to another command) that must not wait for a login in
 * flight, must not leave its window open, and must not let the killed silent
 * attempt fall through to a visible window.
 */
export function killActiveBrowsers(): void {
  shuttingDown = true;
  for (const kill of [...activeBrowsers]) kill();
}

export const launchChrome: BrowserLauncher = async ({ executable, profileDir, url, headless }) => {
  if (shuttingDown) throw new BrowserLaunchError('Not starting the browser: hydra-onix-mcp is shutting down.');
  const child = spawn(executable, chromeArgs(profileDir, url, headless), {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const toBrowser = child.stdio[3] as Writable | null;
  const fromBrowser = child.stdio[4] as Readable | null;
  const stderr = child.stdio[2] as Readable | null;
  // Drain so a chatty browser can never block on a full pipe.
  stderr?.resume();
  stderr?.on('error', () => undefined);
  toBrowser?.on('error', () => undefined);

  const kill = (): void => {
    activeBrowsers.delete(kill);
    if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
  };
  // Tracked from the moment of spawning, so a shutdown during startup kills it too.
  activeBrowsers.add(kill);
  child.once('exit', () => activeBrowsers.delete(kill));
  child.once('error', () => activeBrowsers.delete(kill));

  // A failed spawn still hands out stdio pipes, so wait for the outcome.
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new BrowserLaunchError(`Could not start the browser ${executable} (${code}).`, { cause: error });
  }
  child.on('error', () => undefined);
  const startedAt = Date.now();

  if (!toBrowser || !fromBrowser) {
    kill();
    throw new HarnessError('Could not open the browser DevTools pipe.');
  }
  return {
    cdp: connectPipe(toBrowser, fromBrowser),
    kill,
    // Only consulted once the pipe has closed.
    launchFailure: () =>
      Date.now() - startedAt < EARLY_EXIT_MS
        ? new BrowserLaunchError(
            `The browser exited immediately; is another hydra-onix-mcp login or Chrome using ${profileDir}?`,
          )
        : undefined,
  };
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

async function waitForClose(cdp: CdpConnection): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
  });
  await Promise.race([cdp.closed, grace]);
  clearTimeout(timer);
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

  const { cdp, kill, launchFailure } = await launch({
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

    const gone = (): Error => launchFailure?.() ?? new LoginCancelledError();

    while (Date.now() < deadline) {
      if (closed) throw gone();
      let cookies: StoredCookie[] = [];
      try {
        const reply = await cdp.send<{ cookies?: CdpCookie[] }>('Storage.getCookies');
        cookies = appCookies(reply.cookies ?? [], o.appUrl);
      } catch {
        if (closed) throw gone();
      }

      const key = cookieKey(cookies);
      if (cookies.length > 0 && key !== lastKey) {
        lastKey = key;
        try {
          const session = await validate(cookies);
          const closing = await cdp.send('Browser.close').then(
            () => true,
            () => false,
          );
          // Let Chrome flush the profile (cookies) before we ever kill it.
          if (closing) await waitForClose(cdp);
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
    if (closed) throw gone();
    throw new LoginTimeoutError(lastError);
  } finally {
    kill();
    cdp.dispose();
  }
}

async function exists(dir: string): Promise<boolean> {
  try {
    await stat(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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
  // A profile created just now holds no sign-in, so the silent attempt would
  // only spend its timeout in silence.
  const hadProfile = await exists(o.profileDir);
  if (!hadProfile && !o.interactive) {
    throw new HarnessError('Not signed in to Hydra yet.', { hint: commandHint('hydra-onix-mcp auth login') });
  }
  await mkdir(o.profileDir, { recursive: true, mode: 0o700 });

  const base = {
    appUrl: o.appUrl,
    executable,
    profileDir: o.profileDir,
    launch: o.launch,
    validate: o.validate,
  };
  if (hadProfile) {
    o.log?.('Checking for an existing Hydra sign-in...');
    try {
      return await captureSession({ ...base, headless: true, timeoutMs: o.silentTimeoutMs ?? SILENT_LOGIN_TIMEOUT_MS });
    } catch (error) {
      const recoverable = error instanceof LoginTimeoutError || error instanceof LoginCancelledError;
      // A shutdown killed the silent browser: that is not the user closing a window.
      if (!recoverable || !o.interactive || shuttingDown) throw error;
    }
  }
  o.log?.(`Opening your browser to sign in to Hydra (profile: ${o.profileDir})...`);
  return captureSession({ ...base, headless: false, timeoutMs: o.timeoutMs ?? LOGIN_TIMEOUT_MS });
}
