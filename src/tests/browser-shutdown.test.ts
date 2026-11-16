/**
 * Shutdown and the browser login. `killActiveBrowsers` marks the whole process
 * as shutting down, so these tests live in their own file (module state is per
 * test file).
 */
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BrowserLaunchError,
  LoginCancelledError,
  browserLogin,
  killActiveBrowsers,
  launchChrome,
  type BrowserLauncher,
} from '../auth/browser/login.js';
import { connectPipe } from '../auth/browser/cdp-pipe.js';
import { cleanupTempDirs, fakeCdpPeer, isProcessAlive, makeTempHome, waitFor } from './helpers.js';

afterEach(cleanupTempDirs);

describe('once shutting down', () => {
  // First: every test here sets the process-wide flag, and this one needs a real launch.
  it.skipIf(process.platform === 'win32')(
    'a real launched login never opens a second window after killActiveBrowsers',
    async () => {
      const wrapper = fileURLToPath(new URL('./fixtures/fake-chrome-bin.sh', import.meta.url));
      await chmod(wrapper, 0o755);
      const { paths } = await makeTempHome();
      const profileDir = `${paths.home}/profile`;
      await mkdir(profileDir, { recursive: true });
      const marker = join(paths.home, 'browser.pid');
      const pids = (): number[] => readFileSync(marker, 'utf8').split('\n').filter(Boolean).map(Number);
      const saved = { ...process.env };
      Object.assign(process.env, { FAKE_CHROME_MARKER: marker, FAKE_CHROME_COOKIES: '[]', FAKE_CHROME_STUBBORN: '1' });
      try {
        const login = browserLogin({
          appUrl: 'https://app.example.com',
          profileDir,
          interactive: true,
          executable: wrapper,
          silentTimeoutMs: 10_000,
          timeoutMs: 10_000,
        }).catch((e: unknown) => e);
        await waitFor(() => existsSync(marker), 5_000, 'the silent browser to start');
        const [silentPid] = pids();
        // Past the early-exit window, so the kill reads as a closed window (the recoverable case).
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        killActiveBrowsers();

        expect(await login).toBeInstanceOf(LoginCancelledError);
        await waitFor(() => !isProcessAlive(silentPid!), 3_000, 'the silent browser to exit');
        expect(pids()).toEqual([silentPid]);
      } finally {
        for (const key of ['FAKE_CHROME_MARKER', 'FAKE_CHROME_COOKIES', 'FAKE_CHROME_STUBBORN']) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
        for (const pid of existsSync(marker) ? pids() : []) if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    },
  );

  it('browserLogin never falls through to a visible window when the silent browser is killed', async () => {
    const { paths } = await makeTempHome();
    const profileDir = `${paths.home}/profile`;
    await mkdir(profileDir, { recursive: true });
    const launches: boolean[] = [];
    const launch: BrowserLauncher = async (a) => {
      launches.push(a.headless);
      const peer = fakeCdpPeer(() => ({ cookies: [] }));
      // The shutdown kills this (headless) browser: its pipe closes.
      setTimeout(() => {
        killActiveBrowsers();
        peer.close();
      }, 20);
      return { cdp: connectPipe(peer.toBrowser, peer.fromBrowser), kill: () => undefined };
    };

    await expect(
      browserLogin({ appUrl: 'https://app.example.com', profileDir, interactive: true, executable: '/bin/browser', launch }),
    ).rejects.toBeInstanceOf(LoginCancelledError);
    expect(launches).toEqual([true]);
  });

  it('launchChrome refuses to start a browser', async () => {
    killActiveBrowsers();
    const error = await launchChrome({
      executable: '/nonexistent/chrome',
      profileDir: '/tmp/unused',
      url: 'https://x/',
      headless: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect((error as Error).message).toContain('shutting down');
  });
});
