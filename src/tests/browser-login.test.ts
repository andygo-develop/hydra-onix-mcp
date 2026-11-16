import { afterEach, describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';

import {
  LoginCancelledError,
  LoginTimeoutError,
  NoBrowserError,
  appCookies,
  browserLogin,
  captureSession,
  chromeArgs,
  type BrowserLauncher,
} from '../auth/browser/login.js';
import { connectPipe } from '../auth/browser/cdp-pipe.js';
import { refreshSession, SessionExpiredError, type StoredCookie } from '../auth/session.js';
import { cleanupTempDirs, fakeCdpPeer, makeTempHome, startFakeApp } from './helpers.js';

const HOST = 'projects.onix.hydra-systems.net';
const APP = `https://${HOST}`;
const P = '__Secure-next-auth.session-token';

afterEach(cleanupTempDirs);

describe('chromeArgs', () => {
  it('builds the visible and headless argument lists', () => {
    expect(chromeArgs('/p', 'https://x/', false)).toEqual([
      '--user-data-dir=/p',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      'https://x/',
    ]);
    const headless = chromeArgs('/p', 'https://x/', true);
    expect(headless).toContain('--headless=new');
    for (const a of [...headless, ...chromeArgs('/p', 'u', false)]) {
      expect(a).not.toMatch(/remote-debugging-port|enable-automation/);
    }
  });
});

describe('appCookies', () => {
  it('keeps only app-host session cookies and converts expiry', () => {
    const result = appCookies(
      [
        { name: `${P}.0`, value: 'a', domain: HOST, expires: 1_700_000_000 },
        { name: `${P}.1`, value: 'b', domain: `.${HOST}`, expires: -1 },
        { name: `${P}.0`, value: 'x', domain: 'passport.onix.hydra-systems.net', expires: -1 },
        { name: `${P}.0`, value: 'y', domain: 'onix.hydra-systems.net', expires: -1 },
        { name: `${P}.0`, value: 'z', domain: 'evil-projects.onix.hydra-systems.net', expires: -1 },
        { name: 'other', value: 'o', domain: HOST, expires: -1 },
      ],
      APP,
    );
    expect(result).toEqual([
      { name: `${P}.0`, value: 'a', expires: '2023-11-14T22:13:20.000Z' },
      { name: `${P}.1`, value: 'b' },
    ]);
  });
});

function fakeLauncher(
  handlerFor: (n: number) => (method: string) => unknown,
  closeOnCreate = false,
): { launch: BrowserLauncher; launches: Array<{ headless: boolean }>; killed: number[]; peers: Array<ReturnType<typeof fakeCdpPeer>> } {
  const launches: Array<{ headless: boolean }> = [];
  const killed: number[] = [];
  const peers: Array<ReturnType<typeof fakeCdpPeer>> = [];
  const launch: BrowserLauncher = async (a) => {
    const n = launches.length;
    launches.push({ headless: a.headless });
    const peer = fakeCdpPeer(handlerFor(n));
    peers.push(peer);
    if (closeOnCreate) peer.close();
    return { cdp: connectPipe(peer.toBrowser, peer.fromBrowser), kill: () => killed.push(n) };
  };
  return { launch, launches, killed, peers };
}

const cookiesFor = (host: string) => [
  { name: `${P}.0`, value: 'chunk0', domain: host, expires: -1 },
  { name: `${P}.1`, value: 'chunk1', domain: host, expires: -1 },
];
const goodCookies = cookiesFor(HOST);

const base = { appUrl: APP, executable: '/bin/browser', profileDir: '/tmp/unused', headless: true, pollMs: 5 };

describe('captureSession', () => {
  it('resolves once cookies appear on poll 3 and closes the browser', async () => {
    const app = await startFakeApp();
    try {
      let polls = 0;
      const f = fakeLauncher(() => (method) => {
        if (method === 'Storage.getCookies') return { cookies: ++polls >= 3 ? cookiesFor('127.0.0.1') : [] };
        return {};
      });
      const result = await captureSession({
        ...base,
        appUrl: app.url,
        timeoutMs: 2000,
        launch: f.launch,
        validate: (c) => refreshSession(app.url, c),
      });
      expect(result.accessToken).toBe(app.state.issued[0]);
      expect(polls).toBe(3);
      expect(f.peers[0]?.calls).toContain('Browser.close');
      expect(f.killed).toEqual([0]);
    } finally {
      await app.close();
    }
  });

  it('keeps polling while validation says the session expired', async () => {
    let validations = 0;
    const f = fakeLauncher(() => (method) => {
      if (method !== 'Storage.getCookies') return {};
      return { cookies: [{ ...goodCookies[0], value: `v${validations}` }] };
    });
    const result = await captureSession({
      ...base,
      timeoutMs: 2000,
      launch: f.launch,
      validate: async (c: StoredCookie[]) => {
        validations += 1;
        if (validations < 3) throw new SessionExpiredError();
        return { accessToken: 't', accessTokenExpires: 'x', cookies: c };
      },
    });
    expect(result.accessToken).toBe('t');
    expect(validations).toBe(3);
  });

  it('only revalidates when the cookie set changed', async () => {
    let validations = 0;
    const f = fakeLauncher(() => (method) => (method === 'Storage.getCookies' ? { cookies: goodCookies } : {}));
    await expect(
      captureSession({
        ...base,
        timeoutMs: 60,
        launch: f.launch,
        validate: async () => {
          validations += 1;
          throw new SessionExpiredError();
        },
      }),
    ).rejects.toBeInstanceOf(LoginTimeoutError);
    expect(validations).toBe(1);
  });

  it('rejects with LoginCancelledError when the browser goes away', async () => {
    const f = fakeLauncher(() => () => ({ cookies: [] }));
    const promise = captureSession({ ...base, timeoutMs: 2000, launch: f.launch });
    setTimeout(() => f.peers[0]?.close(), 20);
    await expect(promise).rejects.toBeInstanceOf(LoginCancelledError);
    expect(f.killed).toEqual([0]);
  });

  it('times out, kills the browser and reports the last validation error without secrets', async () => {
    const f = fakeLauncher(() => (method) => (method === 'Storage.getCookies' ? { cookies: goodCookies } : {}));
    const error = await captureSession({
      ...base,
      timeoutMs: 60,
      launch: f.launch,
      validate: async () => {
        throw new Error('Hydra is down');
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginTimeoutError);
    expect((error as LoginTimeoutError).hint).toContain('hydra-onix-mcp auth login');
    expect((error as LoginTimeoutError).hint).toContain('Hydra is down');
    expect((error as LoginTimeoutError).hint).not.toContain('chunk0');
    expect(f.killed).toEqual([0]);
  });
});

describe('browserLogin', () => {
  const ok = { accessToken: 't', accessTokenExpires: 'x', cookies: [] as StoredCookie[] };
  const cookiesHandler = () => (method: string) => (method === 'Storage.getCookies' ? { cookies: goodCookies } : {});
  const emptyHandler = () => () => ({ cookies: [] });

  it('uses a single headless launch when the silent attempt succeeds', async () => {
    const { paths } = await makeTempHome();
    const f = fakeLauncher(cookiesHandler);
    const result = await browserLogin({
      appUrl: APP,
      profileDir: `${paths.home}/profile`,
      interactive: true,
      executable: '/bin/browser',
      launch: f.launch,
      validate: async () => ok,
    });
    expect(result.accessToken).toBe('t');
    expect(f.launches).toEqual([{ headless: true }]);
    await expect(access(`${paths.home}/profile`)).resolves.toBeUndefined();
  });

  it('falls back to a visible window and logs the profile path', async () => {
    const { paths } = await makeTempHome();
    const profileDir = `${paths.home}/profile`;
    const f = fakeLauncher((n) => (n === 0 ? emptyHandler() : cookiesHandler()));
    const messages: string[] = [];
    await browserLogin({
      appUrl: APP,
      profileDir,
      interactive: true,
      executable: '/bin/browser',
      launch: f.launch,
      validate: async () => ok,
      silentTimeoutMs: 40,
      timeoutMs: 2000,
      log: (m) => messages.push(m),
    });
    expect(f.launches).toEqual([{ headless: true }, { headless: false }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Opening');
    expect(messages[0]).toContain(profileDir);
  });

  it('does not open a window when not interactive', async () => {
    const { paths } = await makeTempHome();
    const f = fakeLauncher(emptyHandler);
    await expect(
      browserLogin({
        appUrl: APP,
        profileDir: `${paths.home}/profile`,
        interactive: false,
        executable: '/bin/browser',
        launch: f.launch,
        silentTimeoutMs: 40,
      }),
    ).rejects.toBeInstanceOf(LoginTimeoutError);
    expect(f.launches).toHaveLength(1);
  });

  it('rejects with NoBrowserError when no browser is found', async () => {
    const f = fakeLauncher(emptyHandler);
    const error = await browserLogin({
      appUrl: APP,
      profileDir: '/tmp/unused',
      interactive: true,
      find: async () => undefined,
      launch: f.launch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoBrowserError);
    expect((error as NoBrowserError).hint).toContain('auth login --manual');
    expect((error as NoBrowserError).hint).toContain('HYDRA_ONIX_MCP_BROWSER');
    expect(f.launches).toHaveLength(0);
  });
});
