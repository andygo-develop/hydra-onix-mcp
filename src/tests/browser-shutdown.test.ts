/**
 * Shutdown and the browser login. `killActiveBrowsers` marks the whole process
 * as shutting down, so these tests live in their own file (module state is per
 * test file).
 */
import { mkdir } from 'node:fs/promises';
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
import { cleanupTempDirs, fakeCdpPeer, makeTempHome } from './helpers.js';

afterEach(cleanupTempDirs);

describe('once shutting down', () => {
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
