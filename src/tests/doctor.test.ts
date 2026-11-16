/**
 * `doctor`: every check by id, the command catalog, and the online round trip
 * through fake Hydra servers. Never launches a browser.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CredentialStore } from '../auth/store.js';
import { runAuthLogin } from '../cli/commands/auth/login.js';
import { DOCTOR_COMMANDS, doctorCommand, runDoctor, type DoctorReport } from '../cli/commands/doctor.js';
import { runSetup } from '../cli/commands/setup.js';
import { appUrl } from '../constants.js';
import {
  capture,
  cleanupTempDirs,
  makeJwt,
  makeTempHome,
  redirectOutput,
  startFakeApp,
  startFakeMcp,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
let restoreOutput: () => void;

// Setup and login report progress; keep the test output clean.
beforeEach(() => {
  restoreOutput = redirectOutput(() => undefined);
});

afterEach(async () => {
  restoreOutput();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
  await cleanupTempDirs();
});

const POSIX = process.platform !== 'win32';
const SECRET_COOKIE = 'cookie-secret-value-91be';
const TOKEN = makeJwt(Math.floor(Date.now() / 1000) + 3600);
const find = async () => '/fake/chrome';

const login = async () => ({
  accessToken: TOKEN,
  accessTokenExpires: new Date(Date.now() + 3_600_000).toISOString(),
  sessionExpires: '2099-01-01T00:00:00.000Z',
  user: { name: 'Test User', email: 'test@example.com' },
  cookies: [{ name: '__Secure-next-auth.session-token.0', value: SECRET_COOKIE }],
});

const check = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id);

async function healthyHome() {
  const temp = await makeTempHome();
  await mkdir(path.join(temp.paths.home, '.cursor'), { recursive: true });
  await runSetup({ yes: true, login: false, env: temp.env });
  await runAuthLogin({ env: temp.env, login });
  return temp;
}

describe('doctor', () => {
  it('on a fresh home fails the config check with a setup hint', async () => {
    const { env } = await makeTempHome();
    const report = await runDoctor({ env, find });

    expect(report.ok).toBe(false);
    expect(check(report, 'node')?.status).toBe('pass');
    expect(check(report, 'config')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('npx @andygo.dev/hydra-onix-mcp setup'),
    });
    expect(check(report, 'credentials')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('npx @andygo.dev/hydra-onix-mcp auth login'),
    });
    expect(check(report, 'session')?.status).toBe('skip');
    expect(report.commands).toEqual(DOCTOR_COMMANDS);
  });

  it('passes after setup and login', async () => {
    const { env } = await healthyHome();
    const report = await runDoctor({ env, find });

    expect(report.checks.map((c) => c.id)).toEqual([
      'node',
      'config',
      'registration:cursor',
      'browser',
      'credentials',
      ...(POSIX ? ['credentials-permissions'] : []),
      'session',
    ]);
    expect(report.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET_COOKIE);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('warns, but does not fail, when no browser is found', async () => {
    const { env } = await healthyHome();
    const report = await runDoctor({ env, find: async () => undefined });
    expect(check(report, 'browser')).toMatchObject({ status: 'warn', hint: expect.stringContaining('--manual') });
    expect(report.ok).toBe(true);
  });

  it.skipIf(!POSIX)('warns when the credentials file is readable by others', async () => {
    const { env, paths } = await healthyHome();
    await chmod(paths.credentialsFile, 0o644);

    const report = await runDoctor({ env, find });
    expect(check(report, 'credentials-permissions')).toMatchObject({
      status: 'warn',
      hint: expect.stringContaining('chmod 600'),
    });
  });

  it('fails the registration check for an unregistered agent', async () => {
    const { env } = await makeTempHome();
    await runSetup({ yes: true, login: false, mcp: false, target: ['gemini'], env });
    const report = await runDoctor({ env, find });
    expect(check(report, 'registration:gemini')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('npx @andygo.dev/hydra-onix-mcp targets install --target gemini'),
    });
  });

  it('fails the session check once the web session has expired', async () => {
    const { env, paths } = await healthyHome();
    const store = new CredentialStore(paths, appUrl(env));
    const current = await store.read();
    await store.write({ ...current!, sessionExpires: '2000-01-01T00:00:00.000Z' });

    const report = await runDoctor({ env, find });
    expect(check(report, 'session')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('npx @andygo.dev/hydra-onix-mcp auth login'),
    });
  });

  it('fails the credentials check on a corrupt file', async () => {
    const { env, paths } = await healthyHome();
    await writeFile(paths.credentialsFile, '{not json');

    const report = await runDoctor({ env, find });
    expect(check(report, 'credentials')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('auth login --force'),
    });
  });

  it('--online refreshes the session and lists the tools through the MCP server', async () => {
    const { env, paths } = await healthyHome();
    const app = await startFakeApp();
    const mcp = await startFakeMcp({ isValid: (t) => app.state.issued.includes(t) });
    cleanups.push(app.close, mcp.close);
    const online = { ...env, HYDRA_ONIX_MCP_APP_URL: app.url, HYDRA_ONIX_MCP_URL: mcp.url };
    // Cookies only, so the token has to come from a real refresh.
    await new CredentialStore(paths, appUrl(online)).write({
      cookies: [...app.state.validCookies].map(([name, value]) => ({ name, value })),
      updatedAt: new Date().toISOString(),
    });

    const report = await runDoctor({ env: online, find, online: true });

    expect(check(report, 'session-refresh')?.status).toBe('pass');
    expect(check(report, 'mcp-tools')).toMatchObject({ status: 'pass', label: expect.stringContaining('1 tool') });
    expect(app.state.issued).toHaveLength(1);
    expect(report.ok).toBe(true);
  });

  it('--online never opens a browser when the session is gone', async () => {
    const { env, paths } = await healthyHome();
    const app = await startFakeApp({ mode: 'expired' });
    const mcp = await startFakeMcp({ isValid: () => true });
    cleanups.push(app.close, mcp.close);
    const online = { ...env, HYDRA_ONIX_MCP_APP_URL: app.url, HYDRA_ONIX_MCP_URL: mcp.url };
    await new CredentialStore(paths, appUrl(online)).write({
      cookies: [{ name: '__Secure-next-auth.session-token', value: 'stale' }],
      updatedAt: new Date().toISOString(),
    });
    // A browser that would be found must still never be used.
    const browserEnv = { ...online, HYDRA_ONIX_MCP_BROWSER: '/nonexistent/should-not-launch' };

    const report = await runDoctor({ env: browserEnv, find, online: true });

    expect(check(report, 'session-refresh')).toMatchObject({
      status: 'fail',
      hint: expect.stringContaining('npx @andygo.dev/hydra-onix-mcp auth login'),
    });
    expect(check(report, 'mcp-tools')?.status).toBe('skip');
    expect(mcp.requests).toBe(0);
  });

  it('uses an injected connection for the tool listing', async () => {
    const { env } = await healthyHome();
    const connect = vi.fn(async () => ['a', 'b']);
    const report = await runDoctor({ env, find, online: true, connect });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(check(report, 'mcp-tools')).toMatchObject({ status: 'pass', label: expect.stringContaining('2 tools') });
  });

  it('prints JSON with --json and sets a failing exit code', async () => {
    const { env } = await makeTempHome();
    const output = await capture(() => doctorCommand({ env, json: true, find }));
    expect(JSON.parse(output)).toMatchObject({ ok: false, commands: DOCTOR_COMMANDS });
    expect(process.exitCode).toBe(1);
  });

  it('prints a readable report with the command catalog', async () => {
    const { env } = await healthyHome();
    const output = await capture(() => doctorCommand({ env, find }));
    expect(output).toContain('Available commands:');
    expect(output).toContain('npx @andygo.dev/hydra-onix-mcp auth login');
    expect(output).not.toContain(SECRET_COOKIE);
  });
});
