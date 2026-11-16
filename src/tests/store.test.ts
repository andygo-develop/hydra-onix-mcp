import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CorruptCredentialsError,
  CredentialStore,
  toCredentials,
  type AppCredentials,
} from '../auth/store.js';
import { HarnessError } from '../errors.js';
import { cleanupTempDirs, makeTempHome } from './helpers.js';

const APP_A = 'https://a.example.com';
const APP_B = 'https://b.example.com';

function creds(token = 'tok'): AppCredentials {
  return {
    cookies: [
      { name: '__Secure-next-auth.session-token.0', value: 'c0' },
      {
        name: '__Secure-next-auth.session-token.1',
        value: 'c1',
        expires: '2030-01-01T00:00:00.000Z',
      },
    ],
    sessionExpires: '2030-01-01T00:00:00.000Z',
    accessToken: token,
    accessTokenExpires: '2026-01-01T01:00:00.000Z',
    user: { name: 'T', email: 't@example.com' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDirs();
});

describe('toCredentials', () => {
  it('maps every session field and stamps updatedAt', () => {
    const now = new Date('2026-02-03T04:05:06.000Z');
    const result = toCredentials(
      {
        accessToken: 'a',
        accessTokenExpires: '2026-02-03T05:05:06.000Z',
        sessionExpires: '2026-02-10T00:00:00.000Z',
        user: { name: 'N', email: 'e@x.io' },
        cookies: [{ name: 'c', value: 'v' }],
      },
      now,
    );
    expect(result).toEqual({
      accessToken: 'a',
      accessTokenExpires: '2026-02-03T05:05:06.000Z',
      sessionExpires: '2026-02-10T00:00:00.000Z',
      user: { name: 'N', email: 'e@x.io' },
      cookies: [{ name: 'c', value: 'v' }],
      updatedAt: '2026-02-03T04:05:06.000Z',
    });
  });
});

describe('CredentialStore files', () => {
  it('round-trips and keys the file by app url', async () => {
    const { paths } = await makeTempHome();
    const store = new CredentialStore(paths, APP_A);
    await store.write(creds());
    expect(await store.read()).toEqual(creds());
    expect(Object.keys(JSON.parse(await fs.readFile(paths.credentialsFile, 'utf8')))).toEqual([APP_A]);
  });

  it('keeps other apps and removes only its own key, deleting the empty file', async () => {
    const { paths } = await makeTempHome();
    const a = new CredentialStore(paths, APP_A);
    const b = new CredentialStore(paths, APP_B);
    await a.write(creds('a'));
    await b.write(creds('b'));
    expect((await a.read())?.accessToken).toBe('a');
    await a.remove();
    expect(await a.read()).toBeUndefined();
    expect((await b.read())?.accessToken).toBe('b');
    await b.remove();
    await expect(fs.access(paths.credentialsFile)).rejects.toThrow();
  });

  it('remove on a missing file is a no-op', async () => {
    const { paths } = await makeTempHome();
    await expect(new CredentialStore(paths, APP_A).remove()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('uses 0600 for the file and 0700 for the directory', async () => {
    const { paths } = await makeTempHome();
    const store = new CredentialStore(
      {
        ...paths,
        credentialsFile: `${paths.configDir}/sub/credentials.json`,
      },
      APP_A,
    );
    await store.write(creds());
    const file = `${paths.configDir}/sub/credentials.json`;
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('does not chmod on win32', async () => {
    const { paths } = await makeTempHome();
    const chmod = vi.spyOn(fs, 'chmod');
    await new CredentialStore(paths, APP_A, { platform: 'win32' }).write(creds());
    expect(chmod).not.toHaveBeenCalled();
  });

  it('leaves no temp file behind', async () => {
    const { paths } = await makeTempHome();
    await new CredentialStore(paths, APP_A).write(creds());
    expect((await fs.readdir(dirname(paths.credentialsFile))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('read returns undefined for a missing file', async () => {
    const { paths } = await makeTempHome();
    expect(await new CredentialStore(paths, APP_A).read()).toBeUndefined();
  });

  it.each([
    '',
    '{not json',
    '[]',
    '"x"',
    'null',
    JSON.stringify({ [APP_A]: 'oops' }),
    '{"https://a.example.com":{}}',
    '{"https://a.example.com":{"cookies":"x"}}',
    '{"secret-cookie-value": tok',
  ])('read throws CorruptCredentialsError for %j without leaking contents', async (content) => {
    const { paths } = await makeTempHome();
    await fs.mkdir(dirname(paths.credentialsFile), { recursive: true });
    await fs.writeFile(paths.credentialsFile, content);
    const error = await new CredentialStore(paths, APP_A).read().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorruptCredentialsError);
    expect((error as Error).message).toContain(paths.credentialsFile);
    const secret = 'secret-cookie-value';
    for (const text of [
      (error as Error).message,
      (error as HarnessError).hint ?? '',
      String((error as Error).cause ?? ''),
    ]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain('tok');
    }
    expect((error as HarnessError).hint).toContain('auth logout');
  });

  it('remove deletes a corrupt file instead of throwing', async () => {
    const { paths } = await makeTempHome();
    await fs.mkdir(dirname(paths.credentialsFile), { recursive: true });
    await fs.writeFile(paths.credentialsFile, '{not json');
    await new CredentialStore(paths, APP_A).remove();
    await expect(fs.access(paths.credentialsFile)).rejects.toThrow();
  });
});

describe('CredentialStore.withLock', () => {
  it('serializes concurrent callers across store instances', async () => {
    const { paths } = await makeTempHome();
    const events: string[] = [];
    const run = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 60));
      events.push(`${name}:end`);
    };
    await Promise.all([
      new CredentialStore(paths, APP_A).withLock(run('1'), { pollMs: 10 }),
      new CredentialStore(paths, APP_A).withLock(run('2'), { pollMs: 10 }),
    ]);
    expect(events).toHaveLength(4);
    expect(events[0]!.slice(0, 1)).toBe(events[1]!.slice(0, 1));
    expect(events[2]!.slice(0, 1)).toBe(events[3]!.slice(0, 1));
  });

  it('keeps a long-running lock alive so a waiter never takes it over', async () => {
    const { paths } = await makeTempHome();
    const events: string[] = [];
    const run = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      events.push(`${name}:end`);
    };
    const opts = { staleMs: 100, pollMs: 10, waitMs: 5_000 };
    await Promise.all([
      new CredentialStore(paths, APP_A).withLock(run('1', 300), opts),
      new CredentialStore(paths, APP_A).withLock(run('2', 10), opts),
    ]);
    const first = events[0]!.slice(0, 1);
    const second = first === '1' ? '2' : '1';
    expect(events).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
  });

  it('never removes a lock that vanished and was recreated by someone else', async () => {
    const { paths } = await makeTempHome();
    await fs.mkdir(dirname(paths.lockFile), { recursive: true });
    await fs.writeFile(paths.lockFile, '{"pid":1,"at":"x"}');
    const realStat = fs.stat.bind(fs);
    let thrown = false;
    vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (!thrown) {
        thrown = true;
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }
      return realStat(...args);
    });
    await expect(
      new CredentialStore(paths, APP_A).withLock(async () => 'no', {
        waitMs: 150,
        pollMs: 20,
      }),
    ).rejects.toBeInstanceOf(HarnessError);
    expect(await fs.readFile(paths.lockFile, 'utf8')).toBe('{"pid":1,"at":"x"}');
  });

  it('writes pid and time, and removes the lock after fn throws', async () => {
    const { paths } = await makeTempHome();
    const store = new CredentialStore(paths, APP_A);
    await expect(
      store.withLock(async () => {
        const body = JSON.parse(await fs.readFile(paths.lockFile, 'utf8')) as {
          pid: number;
          at: string;
        };
        expect(body.pid).toBe(process.pid);
        expect(Number.isNaN(Date.parse(body.at))).toBe(false);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(fs.access(paths.lockFile)).rejects.toThrow();
  });

  it('takes over a stale lock immediately', async () => {
    const { paths } = await makeTempHome();
    await fs.mkdir(dirname(paths.lockFile), { recursive: true });
    await fs.writeFile(paths.lockFile, '{"pid":1,"at":"x"}');
    const old = new Date(Date.now() - 61_000);
    await fs.utimes(paths.lockFile, old, old);
    const result = await new CredentialStore(paths, APP_A).withLock(async () => 'ok', { waitMs: 200 });
    expect(result).toBe('ok');
    await expect(fs.access(paths.lockFile)).rejects.toThrow();
  });

  it('does not delete a lock another process took over', async () => {
    const { paths } = await makeTempHome();
    await new CredentialStore(paths, APP_A).withLock(async () => {
      await fs.writeFile(paths.lockFile, '{"pid":999999,"at":"other"}');
    });
    expect(await fs.readFile(paths.lockFile, 'utf8')).toBe('{"pid":999999,"at":"other"}');
  });

  it('calls onWait once while a fresh foreign lock makes it wait, and not when the lock is free', async () => {
    const { paths } = await makeTempHome();
    const store = new CredentialStore(paths, APP_A);
    let waits = 0;
    await store.withLock(async () => undefined, { onWait: () => (waits += 1) });
    expect(waits).toBe(0);

    await fs.mkdir(dirname(paths.lockFile), { recursive: true });
    await fs.writeFile(paths.lockFile, '{"pid":1,"at":"x"}');
    setTimeout(() => void fs.rm(paths.lockFile, { force: true }), 150);
    await store.withLock(async () => undefined, { pollMs: 20, onWait: () => (waits += 1) });
    expect(waits).toBe(1);
  });

  it('times out on a fresh foreign lock with a HarnessError naming the lock', async () => {
    const { paths } = await makeTempHome();
    await fs.mkdir(dirname(paths.lockFile), { recursive: true });
    await fs.writeFile(paths.lockFile, '{"pid":1,"at":"x"}');
    const error = await new CredentialStore(paths, APP_A)
      .withLock(async () => 'no', { waitMs: 200, pollMs: 20 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as Error).message).toContain(paths.lockFile);
  });
});

const DIST_STORE = new URL('../../dist/auth/store.js', import.meta.url);

describe.skipIf(!existsSync(DIST_STORE))('CredentialStore.withLock on process.exit (built)', () => {
  /** Runs a node child that takes the lock, runs `inside`, then calls process.exit inside fn. */
  function exitInsideLock(
    paths: { lockFile: string; credentialsFile: string },
    inside = '',
  ): Promise<{ code: number | null; out: string }> {
    const files = { lockFile: paths.lockFile, credentialsFile: paths.credentialsFile };
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      const { CredentialStore } = await import(${JSON.stringify(DIST_STORE.href)});
      const store = new CredentialStore(${JSON.stringify(files)}, 'https://a.example.com');
      await store.withLock(async () => {
        process.stdout.write(existsSync(${JSON.stringify(paths.lockFile)}) ? 'held' : 'missing');
        ${inside}
        process.exit(0);
      });`;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.on('exit', (code) => resolve({ code, out }));
    });
  }

  it('removes a lock still held when the process exits', async () => {
    const { paths } = await makeTempHome();
    expect(await exitInsideLock(paths)).toEqual({ code: 0, out: 'held' });
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it('leaves alone a lock someone else has taken over meanwhile', async () => {
    const { paths } = await makeTempHome();
    const takeover = `writeFileSync(${JSON.stringify(paths.lockFile)}, 'other');`;
    expect((await exitInsideLock(paths, takeover)).out).toBe('held');
    expect(readFileSync(paths.lockFile, 'utf8')).toBe('other');
  });
});
