/**
 * Command-level tests: they drive the same `run*` / `*Command` functions the
 * commander program wires up, against a throwaway home. Logins are injected,
 * so no browser is launched; `HYDRA_ONIX_MCP_HOME` keeps the real `claude`
 * CLI out of it (Ruling R1).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoBrowserError } from '../auth/browser/login.js';
import type { SessionResult } from '../auth/session.js';
import { CredentialStore, type AppCredentials } from '../auth/store.js';
import { authLoginCommand, runAuthLogin } from '../cli/commands/auth/login.js';
import { runAuthLogout } from '../cli/commands/auth/logout.js';
import { authStatusCommand, runAuthStatus } from '../cli/commands/auth/status.js';
import { DOCTOR_COMMANDS } from '../cli/commands/doctor.js';
import { mcpStartCommand } from '../cli/commands/mcp/start.js';
import { mcpStatusCommand, runMcpStatus } from '../cli/commands/mcp/status.js';
import { runSetup, setupCommand } from '../cli/commands/setup.js';
import { runTargetsAdd } from '../cli/commands/targets/add.js';
import { runTargetsInstall } from '../cli/commands/targets/install.js';
import { runTargetsList, targetsListCommand } from '../cli/commands/targets/list.js';
import { runTargetsRemove } from '../cli/commands/targets/remove.js';
import { createProgram } from '../cli/program.js';
import { loadConfig } from '../config/config.js';
import { appUrl } from '../constants.js';
import {
  capture,
  cleanupTempDirs,
  isProcessAlive,
  makeJwt,
  makeTempHome,
  redirectOutput,
  startFakeApp,
  startFakeMcp,
  waitFor,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
let restoreOutput: () => void;

// Commands report progress; keep the test output clean.
beforeEach(() => {
  restoreOutput = redirectOutput(() => undefined);
});

afterEach(async () => {
  restoreOutput();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  await cleanupTempDirs();
});

const SECRET_COOKIE = 'cookie-secret-value-7f3a';
const TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 3600);

function session(): SessionResult {
  return {
    accessToken: TOKEN,
    accessTokenExpires: new Date(Date.now() + 3_600_000).toISOString(),
    sessionExpires: '2099-01-01T00:00:00.000Z',
    user: { name: 'Test User', email: 'test@example.com' },
    cookies: [{ name: '__Secure-next-auth.session-token.0', value: SECRET_COOKIE }],
  };
}

const fakeLogin = () => vi.fn(async (_o: { interactive: boolean }) => session());
const noBrowser = async () => undefined;

async function homeWithCursor() {
  const temp = await makeTempHome();
  await mkdir(path.join(temp.paths.home, '.cursor'), { recursive: true });
  return temp;
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

describe('setup', () => {
  it('detects agents, records them and registers the server, idempotently (-y --no-login)', async () => {
    const { env, paths } = await homeWithCursor();
    const cursorFile = path.join(paths.home, '.cursor', 'mcp.json');

    const first = await runSetup({ yes: true, login: false, env });
    expect(await loadConfig(paths)).toEqual({ version: 1, targets: ['cursor'] });
    expect(first.registrations.map((r) => [r.target, r.changed, r.via])).toEqual([['cursor', true, 'file']]);
    expect((await readJson(cursorFile)).mcpServers['hydra-onix']).toEqual({
      command: 'npx',
      args: ['-y', '@andygo.dev/hydra-onix-mcp', 'mcp', 'start'],
    });
    expect(first.login).toBe('skipped');

    const before = await readFile(cursorFile, 'utf8');
    const second = await runSetup({ yes: true, login: false, env });
    expect(second.created).toBe(false);
    expect(second.registrations.map((r) => r.changed)).toEqual([false]);
    expect(await readFile(cursorFile, 'utf8')).toBe(before);
    expect(existsSync(paths.credentialsFile)).toBe(false);
  });

  it('says how each agent was registered', async () => {
    const { env } = await homeWithCursor();
    const output = await capture(() => setupCommand({ yes: true, login: false, env }));
    expect(output).toContain('Registered "hydra-onix" with Cursor in ~/.cursor/mcp.json (file write)');
  });

  it('logs in only when there is no working session', async () => {
    const { env } = await homeWithCursor();
    const login = fakeLogin();

    const first = await runSetup({ yes: true, env, loginOptions: { login } });
    expect(first.login).toMatchObject({ user: { email: 'test@example.com' } });
    expect(login).toHaveBeenCalledTimes(1);

    const second = await runSetup({ yes: true, env, loginOptions: { login } });
    expect(second.login).toBe('existing');
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('records --target as the configured agents', async () => {
    const { env, paths } = await homeWithCursor();
    await runSetup({ yes: true, login: false, mcp: false, target: ['gemini'], env });
    expect((await loadConfig(paths))?.targets).toEqual(['gemini']);
  });
});

describe('auth login', () => {
  it('runs the browser login interactively and saves the session', async () => {
    const { env, paths } = await makeTempHome();
    const login = fakeLogin();

    const result = await runAuthLogin({ env, login });

    expect(login).toHaveBeenCalledWith({ interactive: true });
    expect(result).toEqual({ user: session().user, sessionExpires: session().sessionExpires });
    expect(await new CredentialStore(paths, appUrl(env)).read()).toMatchObject({ accessToken: TOKEN });
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  it('holds the credentials lock while logging in', async () => {
    const { env, paths } = await makeTempHome();
    let lockHeld = false;
    await runAuthLogin({
      env,
      login: async () => {
        lockHeld = existsSync(paths.lockFile);
        return session();
      },
    });
    expect(lockHeld).toBe(true);
  });

  it('says it is waiting when another login holds the credentials lock', async () => {
    const { env, paths } = await makeTempHome();
    await mkdir(path.dirname(paths.lockFile), { recursive: true });
    await writeFile(paths.lockFile, '{"pid":1,"at":"x"}');
    setTimeout(() => void rm(paths.lockFile, { force: true }), 300);

    const output = await capture(() => runAuthLogin({ env, login: fakeLogin() }));
    expect(output).toContain('Waiting for another hydra-onix-mcp login to finish...');
  });

  it('prints who signed in, never the token or cookies', async () => {
    const { env } = await makeTempHome();
    const output = await capture(() => authLoginCommand({ env, login: fakeLogin() }));
    expect(output).toContain('Signed in to Hydra as test@example.com');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain(SECRET_COOKIE);
  });

  it('--force succeeds on a corrupt credentials file', async () => {
    const { env, paths } = await makeTempHome();
    await mkdir(path.dirname(paths.credentialsFile), { recursive: true });
    await writeFile(paths.credentialsFile, '{not json');

    await expect(runAuthLogin({ env, login: fakeLogin() })).rejects.toMatchObject({
      name: 'CorruptCredentialsError',
    });
    await expect(runAuthLogin({ env, force: true, login: fakeLogin() })).resolves.toMatchObject({
      user: { email: 'test@example.com' },
    });
    expect(await new CredentialStore(paths, appUrl(env)).read()).toMatchObject({ accessToken: TOKEN });
  });

  it('--force discards the stored session first', async () => {
    const { env, paths } = await makeTempHome();
    await runAuthLogin({ env, login: fakeLogin() });
    let seen: unknown = 'unset';
    await runAuthLogin({
      env,
      force: true,
      login: async () => {
        seen = await new CredentialStore(paths, appUrl(env)).read();
        return session();
      },
    });
    expect(seen).toBeUndefined();
  });

  it('falls back to the manual paste login on a terminal when no browser is found', async () => {
    const { env } = await makeTempHome();
    const pasteLogin = vi.fn(async () => session());
    const login = vi.fn(async () => {
      throw new NoBrowserError();
    });

    await runAuthLogin({ env, login, pasteLogin, interactiveTerminal: true });
    expect(pasteLogin).toHaveBeenCalledTimes(1);
  });

  it('rethrows NoBrowserError without a terminal', async () => {
    const { env, paths } = await makeTempHome();
    const pasteLogin = vi.fn(async () => session());
    const login = vi.fn(async () => {
      throw new NoBrowserError();
    });

    await expect(runAuthLogin({ env, login, pasteLogin, interactiveTerminal: false })).rejects.toBeInstanceOf(
      NoBrowserError,
    );
    expect(pasteLogin).not.toHaveBeenCalled();
    expect(existsSync(paths.credentialsFile)).toBe(false);
  });

  it('--manual goes straight to the paste login', async () => {
    const { env } = await makeTempHome();
    const login = fakeLogin();
    const pasteLogin = vi.fn(async () => session());

    await runAuthLogin({ env, manual: true, login, pasteLogin });
    expect(pasteLogin).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
  });
});

describe('auth logout', () => {
  it('removes the credentials entry and the browser profile', async () => {
    const { env, paths } = await makeTempHome();
    await runAuthLogin({ env, login: fakeLogin() });
    await mkdir(paths.browserProfile, { recursive: true });

    const result = await runAuthLogout({ env });

    expect(result).toMatchObject({ credentialsRemoved: true, profileRemoved: true });
    expect(await new CredentialStore(paths, appUrl(env)).read()).toBeUndefined();
    expect(existsSync(paths.browserProfile)).toBe(false);
  });

  it('keeps the browser profile with keepProfile', async () => {
    const { env, paths } = await makeTempHome();
    await runAuthLogin({ env, login: fakeLogin() });
    await mkdir(paths.browserProfile, { recursive: true });

    await runAuthLogout({ env, keepProfile: true });

    expect(await new CredentialStore(paths, appUrl(env)).read()).toBeUndefined();
    expect((await stat(paths.browserProfile)).isDirectory()).toBe(true);
  });

  it('succeeds on a corrupt credentials file and removes it', async () => {
    const { env, paths } = await makeTempHome();
    await mkdir(path.dirname(paths.credentialsFile), { recursive: true });
    await writeFile(paths.credentialsFile, '{not json');

    await expect(runAuthLogout({ env })).resolves.toMatchObject({ credentialsRemoved: true });
    expect(existsSync(paths.credentialsFile)).toBe(false);
  });

  it('leaves other apps’ entries alone', async () => {
    const { env, paths } = await makeTempHome();
    const staging = { ...env, HYDRA_ONIX_MCP_APP_URL: 'https://staging.example.test' };
    await runAuthLogin({ env: staging, login: fakeLogin() });
    await runAuthLogin({ env, login: fakeLogin() });

    await runAuthLogout({ env, keepProfile: true });

    expect(await new CredentialStore(paths, appUrl(staging)).read()).toMatchObject({ accessToken: TOKEN });
  });
});

describe('auth status', () => {
  it('reports the signed-in user without any cookie or token', async () => {
    const { env, paths } = await makeTempHome();
    await runAuthLogin({ env, login: fakeLogin() });

    const status = await runAuthStatus({ env, find: async () => '/fake/chrome' });

    expect(status).toMatchObject({
      loggedIn: true,
      user: { email: 'test@example.com' },
      credentialsFile: paths.credentialsFile,
      sessionExpires: '2099-01-01T00:00:00.000Z',
      browser: '/fake/chrome',
    });
    expect(status.accessTokenExpires).toBeTruthy();
    const json = JSON.stringify(status);
    expect(json).not.toContain(SECRET_COOKIE);
    expect(json).not.toContain(TOKEN);

    const output = await capture(() => authStatusCommand({ env, json: true, find: noBrowser }));
    expect(output).not.toContain(SECRET_COOKIE);
    expect(output).not.toContain(TOKEN);
    expect(JSON.parse(output)).toMatchObject({ loggedIn: true });
  });

  it('reports logged out on a fresh home', async () => {
    const { env } = await makeTempHome();
    expect(await runAuthStatus({ env, find: noBrowser })).toMatchObject({ loggedIn: false });
  });

  it('reports logged out once the web session has expired', async () => {
    const { env, paths } = await makeTempHome();
    await new CredentialStore(paths, appUrl(env)).write({
      ...session(),
      sessionExpires: '2000-01-01T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    });
    expect(await runAuthStatus({ env, find: noBrowser })).toMatchObject({ loggedIn: false });
  });
});

describe('targets and mcp status', () => {
  it('report the registration and the login state after setup', async () => {
    const { env } = await homeWithCursor();
    await runSetup({ yes: true, login: false, env });

    const list = await runTargetsList({ env });
    expect(list.targets.find((t) => t.id === 'cursor')).toMatchObject({
      enabled: true,
      detected: true,
      registered: true,
      current: true,
    });
    expect(list.targets.find((t) => t.id === 'gemini')).toMatchObject({ enabled: false, registered: false });

    const listJson = JSON.parse(await capture(() => targetsListCommand({ env, json: true })));
    expect(listJson.targets.find((t: { id: string }) => t.id === 'cursor')).toMatchObject({
      registered: true,
      current: true,
    });

    const status = await runMcpStatus({ env, find: noBrowser });
    expect(status.targets).toEqual([
      expect.objectContaining({ target: 'cursor', registered: true, current: true }),
    ]);
    expect(status.login).toMatchObject({ loggedIn: false });

    const statusJson = JSON.parse(await capture(() => mcpStatusCommand({ env, json: true, find: noBrowser })));
    expect(statusJson.targets[0]).toMatchObject({ target: 'cursor', registered: true, current: true });
    expect(statusJson.login).toMatchObject({ loggedIn: false });
  });

  it('flags an existing entry that is not ours, and leaves it alone', async () => {
    const { env, paths } = await homeWithCursor();
    const cursorFile = path.join(paths.home, '.cursor', 'mcp.json');
    const foreign = { mcpServers: { 'hydra-onix': { type: 'http', url: 'https://example.test/mcp' } } };
    await writeFile(cursorFile, JSON.stringify(foreign));

    const output = await capture(() => setupCommand({ yes: true, login: false, env }));
    expect(output).toContain('not ours');
    expect(await readJson(cursorFile)).toEqual(foreign);

    const status = await runMcpStatus({ env, find: noBrowser });
    expect(status.targets[0]).toMatchObject({ registered: true, current: false });
  });

  it('targets add registers the agent and records it; remove only drops the config target', async () => {
    const { env, paths } = await homeWithCursor();
    await runSetup({ yes: true, login: false, env });
    const geminiFile = path.join(paths.home, '.gemini', 'settings.json');

    const added = await runTargetsAdd({ agents: ['gemini'], yes: true, env });
    expect(added.added).toEqual(['gemini']);
    expect((await loadConfig(paths))?.targets).toEqual(['cursor', 'gemini']);
    expect((await readJson(geminiFile)).mcpServers['hydra-onix']).toBeDefined();

    const before = await readFile(geminiFile, 'utf8');
    const removed = await runTargetsRemove({ agents: ['gemini'], env });
    expect(removed.removed).toEqual(['gemini']);
    expect((await loadConfig(paths))?.targets).toEqual(['cursor']);
    expect(await readFile(geminiFile, 'utf8')).toBe(before);
  });

  it('targets remove refuses to leave no agent configured', async () => {
    const { env } = await homeWithCursor();
    await runSetup({ yes: true, login: false, env });
    await expect(runTargetsRemove({ agents: ['cursor'], env })).rejects.toMatchObject({ name: 'HarnessError' });
  });

  it('targets install registers every configured agent, asking unless -y', async () => {
    const { env, paths } = await homeWithCursor();
    await runSetup({ yes: true, login: false, mcp: false, env });
    expect(existsSync(path.join(paths.home, '.cursor', 'mcp.json'))).toBe(false);

    // Not a TTY under vitest: the prompt declines.
    const declined = await runTargetsInstall({ env });
    expect(declined.map((o) => [o.target, o.declined])).toEqual([['cursor', true]]);

    const installed = await runTargetsInstall({ yes: true, env });
    expect(installed.map((o) => [o.target, o.changed, o.via])).toEqual([['cursor', true, 'file']]);
  });

  it('targets install without a config says to run setup', async () => {
    const { env } = await makeTempHome();
    await expect(runTargetsInstall({ yes: true, env })).rejects.toMatchObject({
      hint: expect.stringContaining('hydra-onix-mcp setup'),
    });
  });
});

describe('the commander program', () => {
  const leafPaths = (command: Command, prefix: string[] = []): string[][] =>
    command.commands.flatMap((sub) => {
      const here = [...prefix, sub.name()];
      return sub.commands.length > 0 ? leafPaths(sub, here) : [here];
    });

  const commandPath = (entry: string): string[] =>
    entry
      .split(/\s+/)
      .slice(1)
      .filter((word) => !/^[<[-]/.test(word));

  it('registers every command DOCTOR_COMMANDS lists, and DOCTOR_COMMANDS lists every command', () => {
    const program = createProgram();
    const registered = leafPaths(program).map((p) => p.join(' '));

    for (const entry of DOCTOR_COMMANDS) {
      const words = commandPath(entry.command);
      let current: Command | undefined = program;
      for (const word of words) current = current?.commands.find((c) => c.name() === word);
      expect(current, entry.command).toBeDefined();
    }
    expect(new Set(DOCTOR_COMMANDS.map((e) => commandPath(e.command).join(' ')))).toEqual(new Set(registered));
  });

  it('has the global flags', () => {
    const program = createProgram();
    expect(program.options.map((o) => o.flags)).toEqual(expect.arrayContaining(['-V, --version', '--verbose']));
  });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT = existsSync(path.join(ROOT, 'dist', 'cli', 'index.js'));

/**
 * Spawns the built `mcp start` against fake Hydra servers. By default the
 * stored token is valid (so no login) and the browser is pinned to a path that
 * does not exist, so a rejected token can never start a real browser login.
 */
async function spawnMcpStart(
  o: { credentials?: AppCredentials; env?: NodeJS.ProcessEnv; profile?: boolean } = {},
) {
  const { env, paths } = await makeTempHome();
  if (o.profile) await mkdir(paths.browserProfile, { recursive: true });
  const app = await startFakeApp();
  const mcp = await startFakeMcp({ isValid: (t) => t === TOKEN });
  cleanups.push(app.close, mcp.close);
  const childEnv = {
    ...env,
    HYDRA_ONIX_MCP_APP_URL: app.url,
    HYDRA_ONIX_MCP_URL: mcp.url,
    HYDRA_ONIX_MCP_BROWSER: '/nonexistent/browser',
    ...o.env,
  };
  await new CredentialStore(paths, appUrl(childEnv)).write(
    o.credentials ?? { ...session(), updatedAt: new Date().toISOString() },
  );

  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'hydra-onix-mcp.js'), 'mcp', 'start'], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const output = { stderr: '' };
  child.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()));
  return { child, exited, output, paths };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
};

describe('mcp start (built binary)', () => {
  it.skipIf(!BUILT)('writes nothing but JSON-RPC to stdout, and exits cleanly when stdin closes', async () => {
    const { child, exited, output } = await spawnMcpStart();

    const lines: string[] = [];
    const waiting = new Map<number, (m: unknown) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line);
      try {
        const m = JSON.parse(line) as { id?: number };
        if (typeof m.id === 'number') waiting.get(m.id)?.(m);
      } catch {
        // asserted below
      }
    });
    const request = (id: number, method: string, params: object = {}) =>
      new Promise<{ result?: { tools?: unknown[]; protocolVersion?: string } }>((resolve) => {
        waiting.set(id, resolve as (m: unknown) => void);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const init = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    expect(init.result?.protocolVersion, output.stderr).toBeTruthy();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await request(2, 'tools/list');
    expect(tools.result?.tools).toHaveLength(1);

    child.stdin.end();
    expect(await exited).toBe(0);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(output.stderr).toBe('');
  });

  it.skipIf(!BUILT || process.platform === 'win32')('shuts down cleanly on SIGTERM', async () => {
    const { child, exited, output } = await spawnMcpStart();
    // A reply proves the relay (and its signal handlers) are up.
    const replied = new Promise<string>((resolve) => child.stdout.once('data', (c: Buffer) => resolve(c.toString())));
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    expect(JSON.parse(await replied)).toMatchObject({ jsonrpc: '2.0', id: 1 });

    child.kill('SIGTERM');

    expect(await exited).toBe(0);
    expect(output.stderr).toBe('');
  });

  it.skipIf(!BUILT || process.platform === 'win32')(
    'exits promptly on SIGTERM while a browser login is running, killing the browser and releasing the lock',
    async () => {
      const wrapper = fileURLToPath(new URL('./fixtures/fake-chrome-bin.sh', import.meta.url));
      await chmod(wrapper, 0o755);
      const scratch = (await makeTempHome()).paths.home;
      const marker = path.join(scratch, 'browser.pid');
      // An expired token and cookies the fake app rejects: the first request starts a login,
      // in a "browser" that never produces cookies.
      // A stubborn browser outlives its pipe, so only killActiveBrowsers gets rid of it.
      const { child, exited, paths } = await spawnMcpStart({
        credentials: {
          cookies: [{ name: '__Secure-next-auth.session-token.0', value: 'rejected' }],
          accessToken: 'expired',
          accessTokenExpires: '2000-01-01T00:00:00.000Z',
          updatedAt: new Date().toISOString(),
        },
        env: {
          HYDRA_ONIX_MCP_BROWSER: wrapper,
          FAKE_CHROME_MARKER: marker,
          FAKE_CHROME_COOKIES: '[]',
          FAKE_CHROME_STUBBORN: '1',
        },
        // An existing profile, so the login starts with the silent (headless) attempt.
        profile: true,
      });
      const pids = (): number[] => readFileSync(marker, 'utf8').split('\n').filter(Boolean).map(Number);
      cleanups.push(async () => {
        for (const pid of existsSync(marker) ? pids() : []) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));

      child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
      await waitFor(() => existsSync(marker), 10_000, 'the fake browser to be launched');
      const [browserPid] = pids();
      expect(isProcessAlive(browserPid!)).toBe(true);
      expect(existsSync(paths.lockFile)).toBe(true);

      const signalledAt = Date.now();
      child.kill('SIGTERM');
      const code = await Promise.race([
        exited,
        new Promise<string>((resolve) => setTimeout(() => resolve('still running after 3 s'), 3_000)),
      ]);

      expect(code).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(3_000);
      await waitFor(() => !isProcessAlive(browserPid!), 2_000, 'the fake browser to exit');
      // No visible window was started in its place on the way out.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pids()).toEqual([browserPid]);
      expect(existsSync(paths.lockFile)).toBe(false);
      for (const line of stdout.split('\n').filter(Boolean)) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    },
  );
});

describe('mcpStartCommand (injected relay and exit)', () => {
  it('closes the relay and exits 0 once the agent goes away, removing its signal handlers', async () => {
    let endAgent!: () => void;
    const relay = {
      close: vi.fn(async () => undefined),
      closed: new Promise<void>((resolve) => (endAgent = resolve)),
    };
    const exit = vi.fn();
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const { env } = await makeTempHome();

    const running = mcpStartCommand({ env, exit, start: async () => relay });
    await vi.waitFor(() => expect(process.listenerCount('SIGTERM')).toBe(before[1]! + 1));
    expect(exit).not.toHaveBeenCalled();

    endAgent();
    await running;

    expect(relay.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});
