import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HydraUnavailableError,
  SessionExpiredError,
  applySetCookies,
  cookieHeader,
  refreshSession,
  tokenExpiry,
  type StoredCookie,
} from '../auth/session.js';
import { startFakeApp, makeJwt } from './helpers.js';

const P = '__Secure-next-auth.session-token';
const NOW = new Date('2026-01-01T00:00:00.000Z');
const initial = (): StoredCookie[] => [
  { name: `${P}.0`, value: 'chunk0' },
  { name: `${P}.1`, value: 'chunk1' },
];

describe('cookieHeader', () => {
  it('joins cookies', () => {
    expect(cookieHeader([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])).toBe('a=1; b=2');
  });
});

describe('applySetCookies', () => {
  it('replaces, adds, removes and ignores', () => {
    const out = applySetCookies(
      initial(),
      [
        `${P}.0=new0; Path=/; HttpOnly; Secure`,
        `${P}.2=new2; Path=/`,
        `${P}.1=; Max-Age=0; Path=/`,
        'next-auth.csrf-token=abc; Path=/',
      ],
      NOW,
    );
    expect(out.map((c) => [c.name, c.value])).toEqual([
      [`${P}.0`, 'new0'],
      [`${P}.2`, 'new2'],
    ]);
  });

  it('removes on a past Expires', () => {
    const out = applySetCookies(initial(), [`${P}.1=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT`], NOW);
    expect(out.map((c) => c.name)).toEqual([`${P}.0`]);
  });

  it('sets expires from Max-Age relative to now', () => {
    const out = applySetCookies([], [`${P}.0=v; Max-Age=60`], NOW);
    expect(out[0].expires).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });

  it('sets expires from a future Expires', () => {
    const out = applySetCookies([], [`${P}.0=v; Expires=Fri, 01 Jan 2100 00:00:00 GMT`], NOW);
    expect(out[0].expires).toBe('2100-01-01T00:00:00.000Z');
  });
});

describe('tokenExpiry', () => {
  it('reads JWT exp', () => {
    expect(tokenExpiry(makeJwt(1_800_000_000), NOW)).toBe(new Date(1_800_000_000_000).toISOString());
  });
  it('falls back for opaque tokens', () => {
    expect(tokenExpiry('opaque', NOW)).toBe(new Date(NOW.getTime() + 25 * 60_000).toISOString());
  });
  it('falls back for undecodable payloads', () => {
    expect(tokenExpiry('a.!!!.c', NOW)).toBe(new Date(NOW.getTime() + 25 * 60_000).toISOString());
  });
});

describe('refreshSession', () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  const start = async (opts?: Parameters<typeof startFakeApp>[0]) => {
    const app = await startFakeApp(opts);
    apps.push(app);
    return app;
  };

  it('returns the token, user and session expiry', async () => {
    const app = await start();
    const result = await refreshSession(app.url, initial());
    expect(result.accessToken).toBe(app.state.issued[0]);
    expect(result.user).toEqual({ name: 'Test User', email: 'test@example.com' });
    expect(result.sessionExpires).toBe('2099-01-01T00:00:00.000Z');
    expect(result.cookies).toEqual(initial());
    expect(new Date(result.accessTokenExpires).getTime()).toBeGreaterThan(Date.now());
  });

  it('applies rotated cookies, usable on the next call', async () => {
    const app = await start({ rotate: true });
    const first = await refreshSession(app.url, initial());
    expect(first.cookies[0].value).toMatch(/^rotated1-/);
    const second = await refreshSession(app.url, first.cookies);
    expect(second.accessToken).toBe(app.state.issued[1]);
  });

  it('treats an empty session as expired', async () => {
    const app = await start();
    await expect(refreshSession(app.url, [{ name: `${P}.0`, value: 'stale' }])).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('treats 401 and redirects as expired', async () => {
    for (const mode of ['unauthorized', 'redirect'] as const) {
      const app = await start({ mode });
      await expect(refreshSession(app.url, initial())).rejects.toBeInstanceOf(SessionExpiredError);
    }
  });

  it('does not leak cookie values in the expired error', async () => {
    const app = await start({ mode: 'expired' });
    const error = await refreshSession(app.url, initial()).catch((e: unknown) => e as SessionExpiredError);
    expect(error).toBeInstanceOf(SessionExpiredError);
    expect(`${error.message} ${error.hint}`).not.toContain('chunk0');
    expect(error.hint).toContain('npx @andygo.dev/hydra-onix-mcp auth login');
  });

  it('treats 500 HTML as unavailable, not expired', async () => {
    const app = await start({ mode: 'error500' });
    const error = await refreshSession(app.url, initial()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HydraUnavailableError);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
  });

  it('treats a refused connection as unavailable', async () => {
    const app = await startFakeApp();
    await app.close();
    await expect(refreshSession(app.url, initial())).rejects.toBeInstanceOf(HydraUnavailableError);
  });

  it('treats a response slower than the timeout as unavailable', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'), 10_000).unref();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apps.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    });
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    const error = await refreshSession(`http://127.0.0.1:${port}`, initial(), { timeoutMs: 50 }).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(HydraUnavailableError);
    expect(error.message).toBe('The Hydra web app did not answer in time.');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
