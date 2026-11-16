import { spawn as nodeSpawn } from 'node:child_process';

export interface OpenUrlOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/**
 * Opens a URL in the default browser. Never throws: callers print the URL
 * too, so a failed launch only means the user opens it by hand.
 */
export function openUrl(url: string, o: OpenUrlOptions = {}): void {
  const platform = o.platform ?? process.platform;
  const spawn = o.spawn ?? nodeSpawn;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    // Swallowed on purpose; see above.
  }
}
