import { describe, expect, it } from 'vitest';

import { findBrowser } from '../auth/browser/find.js';

const only = (...paths: string[]) => {
  const set = new Set(paths);
  return async (p: string) => set.has(p);
};
const noWhich = async () => undefined;

describe('findBrowser', () => {
  it('prefers HYDRA_ONIX_MCP_BROWSER when it exists', async () => {
    const found = await findBrowser({
      env: { HYDRA_ONIX_MCP_BROWSER: '/opt/my-chrome' },
      platform: 'darwin',
      exists: only('/opt/my-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      which: noWhich,
    });
    expect(found).toBe('/opt/my-chrome');
  });

  it('falls through to the normal search when the override does not exist', async () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const found = await findBrowser({
      env: { HYDRA_ONIX_MCP_BROWSER: '/missing' },
      platform: 'darwin',
      exists: only(chrome),
      which: noWhich,
    });
    expect(found).toBe(chrome);
  });

  it('finds Chrome on darwin without consulting which', async () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(await findBrowser({ env: {}, platform: 'darwin', exists: only(chrome), which: noWhich })).toBe(chrome);
  });

  it('orders darwin browsers Chrome > Chromium > Edge > Brave', async () => {
    const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    const run = (...paths: string[]) =>
      findBrowser({ env: {}, platform: 'darwin', exists: only(...paths), which: noWhich });
    expect(await run(brave, edge, chromium)).toBe(chromium);
    expect(await run(brave, edge)).toBe(edge);
    expect(await run(brave)).toBe(brave);
  });

  it('also looks under ~/Applications on darwin', async () => {
    const mine = '/Users/me/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    expect(
      await findBrowser({ env: { HOME: '/Users/me' }, platform: 'darwin', exists: only(mine), which: noWhich }),
    ).toBe(mine);
  });

  it('checks Windows install roots in order', async () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LocalAppData: 'C:\\Users\\me\\AppData\\Local',
    };
    const pf = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const x86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    const local = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const run = (...paths: string[]) => findBrowser({ env, platform: 'win32', exists: only(...paths), which: noWhich });
    expect(await run(local, x86, pf)).toBe(pf);
    expect(await run(local, x86)).toBe(x86);
    expect(await run(local)).toBe(local);
    expect(await run('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')).toBe(
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  });

  it('tries linux commands via which in order', async () => {
    const asked: string[] = [];
    const which = async (cmd: string) => {
      asked.push(cmd);
      return cmd === 'microsoft-edge' ? '/usr/bin/microsoft-edge' : undefined;
    };
    const found = await findBrowser({ env: {}, platform: 'linux', exists: only(), which });
    expect(found).toBe('/usr/bin/microsoft-edge');
    expect(asked).toEqual(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']);
  });

  it('finds a linux browser by absolute path when PATH lookup fails', async () => {
    const found = await findBrowser({ env: {}, platform: 'linux', exists: only('/snap/bin/chromium'), which: noWhich });
    expect(found).toBe('/snap/bin/chromium');
    const opt = await findBrowser({
      env: {},
      platform: 'linux',
      exists: only('/opt/brave.com/brave/brave'),
      which: noWhich,
    });
    expect(opt).toBe('/opt/brave.com/brave/brave');
  });

  it('returns undefined when nothing is found', async () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(await findBrowser({ env: {}, platform, exists: only(), which: noWhich })).toBeUndefined();
    }
  });
});
