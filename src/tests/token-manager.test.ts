import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CorruptCredentialsError, CredentialStore, type AppCredentials } from '../auth/store.js';
import { HydraUnavailableError, SessionExpiredError, type SessionResult, type StoredCookie } from '../auth/session.js';
import { LoginCancelledError, NoBrowserError } from '../auth/browser/login.js';
import { LoginRequiredError, TokenManager } from '../auth/token-manager.js';
import type { HydraPaths } from '../paths.js';
import { cleanupTempDirs, makeTempHome } from './helpers.js';

const APP = 'https://hydra.test';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const now = (): Date => NOW;
const inMs = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const COOKIES: StoredCookie[] = [{ name: '__Secure-next-auth.session-token', value: 'old-cookie' }];

const stored = (accessToken: string, expiresInMs: number): AppCredentials => ({
  cookies: COOKIES,
  accessToken,
  accessTokenExpires: inMs(expiresInMs),
  updatedAt: NOW.toISOString(),
});

const session = (accessToken: string, cookieValue = 'new-cookie'): SessionResult => ({
  accessToken,
  accessTokenExpires: inMs(3_600_000),
  sessionExpires: inMs(7 * 24 * 3_600_000),
  user: { email: 'test@example.com' },
  cookies: [{ name: '__Secure-next-auth.session-token', value: cookieValue }],
});

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Fakes {
  refreshCalls: StoredCookie[][];
  loginCalls: Array<{ interactive: boolean }>;
  refresh: (appUrl: string, cookies: StoredCookie[]) => Promise<SessionResult>;
  login: (o: { interactive: boolean }) => Promise<SessionResult>;
}

function fakes(o: {
  refresh?: (n: number) => Promise<SessionResult>;
  login?: (n: number) => Promise<SessionResult>;
}): Fakes {
  const f: Fakes = {
    refreshCalls: [],
    loginCalls: [],
    refresh: async (_appUrl, cookies) => {
      f.refreshCalls.push(cookies);
      if (!o.refresh) throw new Error('unexpected refresh');
      return o.refresh(f.refreshCalls.length);
    },
    login: async (args) => {
      f.loginCalls.push(args);
      if (!o.login) throw new Error('unexpected login');
      return o.login(f.loginCalls.length);
    },
  };
  return f;
}

describe('TokenManager', () => {
  let paths: HydraPaths;
  let store: CredentialStore;

  afterEach(cleanupTempDirs);

  const setup = async (): Promise<void> => {
    ({ paths } = await makeTempHome());
    store = new CredentialStore(paths, APP);
  };
  const manager = (f: Fakes, s: CredentialStore = store): TokenManager =>
    new TokenManager({ store: s, appUrl: APP, refresh: f.refresh, login: f.login, now });

  it('returns a stored token that is valid beyond the margin without refreshing', async () => {
    await setup();
    await store.write(stored('stored-token', 10 * 60_000));
    const f = fakes({});
    expect(await manager(f).getToken({ interactive: false })).toBe('stored-token');
    expect(f.refreshCalls).toHaveLength(0);
    expect(f.loginCalls).toHaveLength(0);
  });

  it('refreshes a token inside the margin and saves the result', async () => {
    await setup();
    await store.write(stored('stale-token', 30_000));
    const f = fakes({ refresh: async () => session('fresh-token') });
    expect(await manager(f).getToken({ interactive: false })).toBe('fresh-token');
    expect(f.refreshCalls).toEqual([COOKIES]);
    expect(f.loginCalls).toHaveLength(0);
    const saved = await store.read();
    expect(saved?.accessToken).toBe('fresh-token');
    expect(saved?.accessTokenExpires).toBe(inMs(3_600_000));
    expect(saved?.cookies[0].value).toBe('new-cookie');
    expect(saved?.updatedAt).toBe(NOW.toISOString());
  });

  it('logs in straight away when nothing is stored', async () => {
    await setup();
    const f = fakes({ login: async () => session('login-token') });
    expect(await manager(f).getToken({ interactive: true })).toBe('login-token');
    expect(f.refreshCalls).toHaveLength(0);
    expect(f.loginCalls).toEqual([{ interactive: true }]);
    expect((await store.read())?.accessToken).toBe('login-token');
  });

  it('escalates to login when the session has expired', async () => {
    await setup();
    await store.write(stored('stale-token', -1));
    const f = fakes({
      refresh: async () => {
        throw new SessionExpiredError();
      },
      login: async () => session('login-token'),
    });
    expect(await manager(f).getToken({ interactive: false })).toBe('login-token');
    expect(f.loginCalls).toEqual([{ interactive: false }]);
    expect((await store.read())?.accessToken).toBe('login-token');
  });

  it('wraps a failed login in LoginRequiredError and saves nothing', async () => {
    await setup();
    const before = stored('stale-token', -1);
    await store.write(before);
    const cause = new LoginCancelledError();
    const f = fakes({
      refresh: async () => {
        throw new SessionExpiredError();
      },
      login: async () => {
        throw cause;
      },
    });
    const error = await manager(f)
      .getToken({ interactive: true })
      .catch((e: unknown) => e as LoginRequiredError);
    expect(error).toBeInstanceOf(LoginRequiredError);
    expect(error.message).toBe('Hydra login required: run `npx @andygo.dev/hydra-onix-mcp auth login`');
    expect(error.cause).toBe(cause);
    expect(await store.read()).toEqual(before);
  });

  it('keeps the underlying hint of a failed login', async () => {
    await setup();
    const cause = new NoBrowserError();
    const f = fakes({
      login: async () => {
        throw cause;
      },
    });
    const error = await manager(f)
      .getToken({ interactive: true })
      .catch((e: unknown) => e as LoginRequiredError);
    expect(error).toBeInstanceOf(LoginRequiredError);
    expect(error.hint).toBe(cause.hint);
  });

  it('rethrows HydraUnavailableError as is without logging in', async () => {
    await setup();
    const before = stored('stale-token', 30_000);
    await store.write(before);
    const unavailable = new HydraUnavailableError('down');
    const f = fakes({
      refresh: async () => {
        throw unavailable;
      },
      login: async () => session('login-token'),
    });
    await expect(manager(f).getToken({ interactive: true })).rejects.toBe(unavailable);
    expect(f.loginCalls).toHaveLength(0);
    expect(await store.read()).toEqual(before);
  });

  it('propagates a corrupt credentials file unchanged', async () => {
    await setup();
    await store.write(stored('stored-token', 10 * 60_000));
    await writeFile(paths.credentialsFile, '{ not json');
    const f = fakes({ login: async () => session('login-token') });
    await expect(manager(f).getToken({ interactive: true })).rejects.toBeInstanceOf(CorruptCredentialsError);
    await expect(manager(f).onUnauthorized('stored-token', { interactive: true })).rejects.toBeInstanceOf(
      CorruptCredentialsError,
    );
    expect(f.loginCalls).toHaveLength(0);
  });

  it('onUnauthorized reuses a different valid token another process saved', async () => {
    await setup();
    await store.write(stored('other-process-token', 10 * 60_000));
    const f = fakes({ refresh: async () => session('fresh-token') });
    expect(await manager(f).onUnauthorized('old-token', { interactive: false })).toBe('other-process-token');
    expect(f.refreshCalls).toHaveLength(0);
  });

  it('onUnauthorized forces a refresh when the store holds the rejected token', async () => {
    await setup();
    await store.write(stored('old-token', 10 * 60_000));
    const f = fakes({ refresh: async () => session('fresh-token') });
    expect(await manager(f).onUnauthorized('old-token', { interactive: false })).toBe('fresh-token');
    expect(f.refreshCalls).toHaveLength(1);
    expect((await store.read())?.accessToken).toBe('fresh-token');
  });

  it('onUnauthorized forces its own refresh after joining a flight that returned the rejected token', async () => {
    await setup();
    await store.write(stored('stale-token', 30_000));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = fakes({
      refresh: async (n) => {
        if (n === 1) {
          await gate;
          return session('first-token');
        }
        return session('second-token');
      },
    });
    const m = manager(f);
    const first = m.getToken({ interactive: false });
    await vi.waitFor(() => expect(f.refreshCalls).toHaveLength(1));
    const retried = m.onUnauthorized('first-token', { interactive: false });
    release();
    expect(await first).toBe('first-token');
    expect(await retried).toBe('second-token');
    expect(f.refreshCalls).toHaveLength(2);
  });

  it('runs a single refresh for concurrent getToken calls', async () => {
    await setup();
    await store.write(stored('stale-token', -1));
    const f = fakes({
      refresh: async (n) => {
        await tick(20);
        return session(`fresh-${n}`);
      },
    });
    const m = manager(f);
    const tokens = await Promise.all(Array.from({ length: 5 }, () => m.getToken({ interactive: false })));
    expect(tokens).toEqual(Array(5).fill('fresh-1'));
    expect(f.refreshCalls).toHaveLength(1);
  });

  it('shares one flight between getToken and onUnauthorized', async () => {
    await setup();
    await store.write(stored('stale-token', -1));
    const f = fakes({
      refresh: async (n) => {
        await tick(20);
        return session(`fresh-${n}`);
      },
    });
    const m = manager(f);
    const tokens = await Promise.all([
      m.getToken({ interactive: false }),
      m.onUnauthorized('stale-token', { interactive: false }),
    ]);
    expect(tokens).toEqual(['fresh-1', 'fresh-1']);
    expect(f.refreshCalls).toHaveLength(1);
  });

  it('starts an interactive login when the non-interactive flight it joined needed one', async () => {
    await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = fakes({
      login: async (n) => {
        if (n === 1) {
          await gate;
          throw new LoginCancelledError();
        }
        return session('window-token');
      },
    });
    const m = manager(f);
    const background = m.getToken({ interactive: false });
    await vi.waitFor(() => expect(f.loginCalls).toHaveLength(1));
    const request = m.getToken({ interactive: true });
    release();

    await expect(background).rejects.toBeInstanceOf(LoginRequiredError);
    expect(await request).toBe('window-token');
    expect(f.loginCalls).toEqual([{ interactive: false }, { interactive: true }]);
  });

  it('does not retry a failed interactive flight for an interactive joiner', async () => {
    await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = fakes({
      login: async () => {
        await gate;
        throw new LoginCancelledError();
      },
    });
    const m = manager(f);
    const first = m.getToken({ interactive: true });
    await vi.waitFor(() => expect(f.loginCalls).toHaveLength(1));
    const second = m.getToken({ interactive: true });
    release();

    await expect(first).rejects.toBeInstanceOf(LoginRequiredError);
    await expect(second).rejects.toBeInstanceOf(LoginRequiredError);
    expect(f.loginCalls).toHaveLength(1);
  });

  it.each([
    ['already expired', () => ({ ...session('dead-token'), accessTokenExpires: inMs(-1) })],
    ['the rejected one again', () => session('old-token')],
  ])('treats a refresh whose token is %s as an expired session and logs in', async (_name, result) => {
    await setup();
    await store.write(stored('old-token', 10 * 60_000));
    const f = fakes({ refresh: async () => result(), login: async () => session('login-token') });
    expect(await manager(f).onUnauthorized('old-token', { interactive: true })).toBe('login-token');
    expect(f.refreshCalls).toHaveLength(1);
    expect(f.loginCalls).toEqual([{ interactive: true }]);
    expect((await store.read())?.accessToken).toBe('login-token');
  });

  it('starts a new flight after a failed one', async () => {
    await setup();
    await store.write(stored('stale-token', -1));
    const f = fakes({
      refresh: async (n) => {
        if (n === 1) throw new HydraUnavailableError('down');
        return session('fresh-token');
      },
    });
    const m = manager(f);
    await expect(m.getToken({ interactive: false })).rejects.toBeInstanceOf(HydraUnavailableError);
    expect(await m.getToken({ interactive: false })).toBe('fresh-token');
  });

  it('refreshes once across two managers sharing the same files', async () => {
    await setup();
    await store.write(stored('stale-token', -1));
    const f = fakes({
      refresh: async (n) => {
        await tick(50);
        return session(`fresh-${n}`);
      },
    });
    const a = manager(f, new CredentialStore(paths, APP));
    const b = manager(f, new CredentialStore(paths, APP));
    const tokens = await Promise.all([a.getToken({ interactive: false }), b.getToken({ interactive: false })]);
    expect(tokens).toEqual(['fresh-1', 'fresh-1']);
    expect(f.refreshCalls).toHaveLength(1);
  });
});
