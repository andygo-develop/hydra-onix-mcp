/**
 * Credentials file (Google-Drive-MCP style): plain JSON keyed by app URL,
 * holding the Hydra session cookies and the latest access token.
 *
 * Several `mcp start` processes share it, so `withLock` provides a
 * cross-process lock built on exclusive file creation. Never log the values
 * stored here.
 */
// Default import (the module object itself) so tests can spy on `chmod`.
import fs from 'node:fs/promises';
import { dirname } from 'node:path';

import { LOCK_STALE_MS, LOGIN_TIMEOUT_MS } from '../constants.js';
import { HarnessError, commandHint } from '../errors.js';
import type { HydraPaths } from '../paths.js';
import type { SessionResult, SessionUser, StoredCookie } from './session.js';

export interface AppCredentials {
  cookies: StoredCookie[];
  sessionExpires?: string;
  accessToken?: string;
  accessTokenExpires?: string;
  user?: SessionUser;
  updatedAt: string;
}

export function toCredentials(r: SessionResult, now: Date): AppCredentials {
  return {
    cookies: r.cookies,
    sessionExpires: r.sessionExpires,
    accessToken: r.accessToken,
    accessTokenExpires: r.accessTokenExpires,
    user: r.user,
    updatedAt: now.toISOString(),
  };
}

export class CorruptCredentialsError extends HarnessError {
  constructor(file: string, options: { cause?: unknown } = {}) {
    super(`The credentials file is corrupt: ${file}`, {
      hint: commandHint('hydra-onix-mcp auth logout', 'hydra-onix-mcp auth login --force'),
      cause: options.cause,
    });
    this.name = 'CorruptCredentialsError';
  }
}

type CredentialsFile = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CredentialStore {
  private readonly posix: boolean;

  constructor(
    private readonly paths: Pick<HydraPaths, 'credentialsFile' | 'lockFile'>,
    private readonly appUrl: string,
    opts: { platform?: NodeJS.Platform } = {},
  ) {
    this.posix = (opts.platform ?? process.platform) !== 'win32';
  }

  async read(): Promise<AppCredentials | undefined> {
    const file = await this.readFile();
    const entry = file[this.appUrl];
    if (entry === undefined) return undefined;
    if (!isPlainObject(entry)) throw new CorruptCredentialsError(this.paths.credentialsFile);
    return entry as unknown as AppCredentials;
  }

  async write(c: AppCredentials): Promise<void> {
    const file = await this.readFile();
    file[this.appUrl] = c;
    await this.writeFile(file);
  }

  async remove(): Promise<void> {
    let file: CredentialsFile;
    try {
      file = await this.readFile();
    } catch (error) {
      if (!(error instanceof CorruptCredentialsError)) throw error;
      await fs.rm(this.paths.credentialsFile, { force: true });
      return;
    }
    if (!(this.appUrl in file)) return;
    delete file[this.appUrl];
    if (Object.keys(file).length === 0) {
      await fs.rm(this.paths.credentialsFile, { force: true });
      return;
    }
    await this.writeFile(file);
  }

  async withLock<T>(
    fn: () => Promise<T>,
    o: { staleMs?: number; waitMs?: number; pollMs?: number } = {},
  ): Promise<T> {
    const staleMs = o.staleMs ?? LOCK_STALE_MS;
    const waitMs = o.waitMs ?? LOGIN_TIMEOUT_MS + 30_000;
    const pollMs = o.pollMs ?? 100;
    const lockFile = this.paths.lockFile;
    const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    const deadline = Date.now() + waitMs;

    await this.ensureDir(lockFile);
    for (;;) {
      try {
        const handle = await fs.open(lockFile, 'wx');
        try {
          await handle.writeFile(body);
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      if (await this.isStale(staleMs)) {
        // Another process may win the race to recreate it; we just retry.
        await fs.rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new HarnessError(`Timed out waiting for the credentials lock: ${lockFile}`, {
          hint: `Another hydra-onix-mcp process holds it. If none is running, delete ${lockFile}.`,
        });
      }
      await sleep(pollMs);
    }

    try {
      return await fn();
    } finally {
      // Only release a lock that is still ours; a stale takeover may have replaced it.
      try {
        if ((await fs.readFile(lockFile, 'utf8')) === body) await fs.rm(lockFile, { force: true });
      } catch {
        // Already gone or unreadable: nothing of ours left to release.
      }
    }
  }

  private async isStale(staleMs: number): Promise<boolean> {
    try {
      const { mtimeMs } = await fs.stat(this.paths.lockFile);
      return Date.now() - mtimeMs > staleMs;
    } catch {
      // Vanished between open and stat: retry immediately.
      return true;
    }
  }

  private async readFile(): Promise<CredentialsFile> {
    const path = this.paths.credentialsFile;
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new CorruptCredentialsError(path, { cause: error });
    }
    if (!isPlainObject(parsed)) throw new CorruptCredentialsError(path);
    return parsed;
  }

  private async ensureDir(file: string): Promise<void> {
    await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  }

  private async writeFile(content: CredentialsFile): Promise<void> {
    const path = this.paths.credentialsFile;
    await this.ensureDir(path);
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
      if (this.posix) await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, path);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
}
