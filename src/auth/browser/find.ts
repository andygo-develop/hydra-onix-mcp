/** Locates an installed Chromium-family browser binary. */
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface FindBrowserOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exists?: (p: string) => Promise<boolean>;
  which?: (cmd: string) => Promise<string | undefined>;
}

const MAC_APPS = ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser'];
const LINUX_COMMANDS = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];
const LINUX_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/snap/bin'];
const LINUX_OPT_PATHS = [
  '/opt/google/chrome/chrome',
  '/opt/microsoft/msedge/msedge',
  '/opt/brave.com/brave/brave',
];
const WINDOWS_ROOT_VARS = ['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData'];
const WINDOWS_RELATIVE = [
  ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
];

async function isFile(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Searches `env.PATH` itself (no shell), honouring `PATHEXT` on Windows. */
function pathLookup(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  return async (cmd: string): Promise<string | undefined> => {
    const win = platform === 'win32';
    const pathApi = win ? path.win32 : path.posix;
    const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
    const exts = win ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = pathApi.join(dir, cmd + ext);
        if (await isFile(candidate)) return candidate;
      }
    }
    return undefined;
  };
}

function candidatePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    const home = env.HOME ?? homedir();
    const roots = ['/Applications', path.posix.join(home, 'Applications')];
    return MAC_APPS.flatMap((app) =>
      roots.map((root) => path.posix.join(root, `${app}.app`, 'Contents', 'MacOS', app)),
    );
  }
  if (platform === 'win32') {
    return WINDOWS_RELATIVE.flatMap((relative) =>
      WINDOWS_ROOT_VARS.flatMap((name) => {
        const root = env[name];
        return root ? [path.win32.join(root, ...relative)] : [];
      }),
    );
  }
  return [];
}

export async function findBrowser(opts: FindBrowserOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? isFile;
  const which = opts.which ?? pathLookup(env, platform);

  const override = env.HYDRA_ONIX_MCP_BROWSER;
  if (override && (await exists(override))) return override;

  for (const candidate of candidatePaths(env, platform)) {
    if (await exists(candidate)) return candidate;
  }
  if (platform === 'linux') {
    for (const cmd of LINUX_COMMANDS) {
      const found = await which(cmd);
      if (found) return found;
    }
    // Agents often spawn us with a minimal PATH, so also try absolute locations.
    for (const dir of LINUX_BIN_DIRS) {
      for (const cmd of LINUX_COMMANDS) {
        const candidate = path.posix.join(dir, cmd);
        if (await exists(candidate)) return candidate;
      }
    }
    for (const candidate of LINUX_OPT_PATHS) {
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
