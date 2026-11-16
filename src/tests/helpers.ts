/**
 * Shared test helpers.
 *
 * Tests must never touch the real home directory, so every test that needs
 * paths gets a throwaway home under the OS temp dir via `HYDRA_ONIX_MCP_HOME`.
 */
import { PassThrough } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hydraPaths, type HydraPaths } from '../paths.js';

const tempDirs: string[] = [];

export async function makeTempHome(): Promise<{ env: NodeJS.ProcessEnv; paths: HydraPaths }> {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-onix-mcp-'));
  tempDirs.push(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, HYDRA_ONIX_MCP_HOME: dir };
  // An inherited override would redirect credentials out of the temp home.
  delete env.HYDRA_ONIX_MCP_CREDENTIALS_PATH;
  return { env, paths: hydraPaths(env) };
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface FakeAppState {
  /** Cookies that must all be sent for the session to be considered live. */
  validCookies: Map<string, string>;
  mode: 'ok' | 'expired' | 'error500' | 'redirect' | 'unauthorized';
  tokenFormat: 'jwt' | 'opaque';
  /** Replace the `.0`/`.1` session cookies on every successful call. */
  rotate: boolean;
  /** Access tokens handed out so far. */
  issued: string[];
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Builds an unsigned JWT-shaped token with the given `exp` (seconds). */
export function makeJwt(exp: number): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ exp })}.sig`;
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

/** Loopback stand-in for the Hydra web app's `/api/auth/session` endpoint. */
export async function startFakeApp(
  opts: Partial<FakeAppState> = {},
): Promise<{ url: string; state: FakeAppState; close(): Promise<void> }> {
  const state: FakeAppState = {
    validCookies: new Map([
      ['__Secure-next-auth.session-token.0', 'chunk0'],
      ['__Secure-next-auth.session-token.1', 'chunk1'],
    ]),
    mode: 'ok',
    tokenFormat: 'jwt',
    rotate: false,
    issued: [],
    ...opts,
  };
  let counter = 0;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.url !== '/api/auth/session') {
      res.writeHead(404).end();
      return;
    }
    if (state.mode === 'error500') {
      res.writeHead(500, { 'content-type': 'text/html' }).end('<html>Internal Server Error</html>');
      return;
    }
    if (state.mode === 'redirect') {
      res.writeHead(302, { location: '/api/auth/signin' }).end();
      return;
    }
    if (state.mode === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    const sent = parseCookieHeader(req.headers.cookie);
    const live =
      state.mode === 'ok' && [...state.validCookies].every(([name, value]) => sent.get(name) === value);
    const headers: Record<string, string | string[]> = { 'content-type': 'application/json' };
    if (!live) {
      res.writeHead(200, headers).end('{}');
      return;
    }
    counter += 1;
    const accessToken =
      state.tokenFormat === 'jwt' ? makeJwt(Math.floor(Date.now() / 1000) + 1800) : `opaque-token-${counter}`;
    state.issued.push(accessToken);
    if (state.rotate) {
      for (const suffix of ['0', '1']) {
        const name = `__Secure-next-auth.session-token.${suffix}`;
        state.validCookies.set(name, `rotated${counter}-${suffix}`);
      }
      headers['set-cookie'] = ['0', '1'].map(
        (suffix) =>
          `__Secure-next-auth.session-token.${suffix}=${state.validCookies.get(`__Secure-next-auth.session-token.${suffix}`)}; Path=/; HttpOnly; Secure`,
      );
    }
    res
      .writeHead(200, headers)
      .end(
        JSON.stringify({
          user: { name: 'Test User', email: 'test@example.com' },
          expires: '2099-01-01T00:00:00.000Z',
          accessToken,
        }),
      );
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * In-memory DevTools peer: parses NUL-delimited commands written to
 * `toBrowser`, answers each through `handler` on `fromBrowser`. A throwing
 * handler becomes an `error` response.
 */
export function fakeCdpPeer(handler: (method: string, params: unknown) => unknown | Promise<unknown>): {
  toBrowser: PassThrough;
  fromBrowser: PassThrough;
  calls: string[];
  close(): void;
} {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const calls: string[] = [];
  let buffer = '';
  toBrowser.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\0');
    while (index !== -1) {
      const message = JSON.parse(buffer.slice(0, index)) as { id: number; method: string; params?: unknown };
      buffer = buffer.slice(index + 1);
      calls.push(message.method);
      void (async () => {
        let reply: Record<string, unknown>;
        try {
          reply = { id: message.id, result: await handler(message.method, message.params) };
        } catch (error) {
          reply = { id: message.id, error: { code: -32000, message: (error as Error).message } };
        }
        if (!fromBrowser.destroyed && fromBrowser.writable) fromBrowser.write(`${JSON.stringify(reply)}\0`);
      })();
      index = buffer.indexOf('\0');
    }
  });
  return { toBrowser, fromBrowser, calls, close: () => fromBrowser.end() };
}
