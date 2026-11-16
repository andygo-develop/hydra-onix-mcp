/**
 * The `claude` CLI, used to register the server in Claude Code's user config.
 *
 * Claude Code rewrites `~/.claude.json` while it runs, so going through its own
 * CLI avoids racing it. An overridden home (`HYDRA_ONIX_MCP_HOME`) means "not
 * the real user": the real CLI would write the real `~/.claude.json`, so it is
 * never used then.
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { HarnessError } from '../errors.js';

export interface ClaudeCli {
  available(): Promise<boolean>;
  addUserServer(name: string, entry: object): Promise<void>;
}

async function onPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  // `execFile` without a shell cannot run a `.cmd`/`.bat` shim on Windows, so
  // only a real executable counts there.
  const names = platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        await access(join(dir, name), constants.X_OK);
        return true;
      } catch {
        // try the next candidate
      }
    }
  }
  return false;
}

/**
 * Whether `addUserServer` failed because `claude` could not be started at all
 * (ENOENT/EINVAL from spawn), as opposed to running and exiting non-zero.
 */
export function isClaudeSpawnFailure(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | undefined)?.cause ?? error;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'EINVAL';
}

export function defaultClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
  opts: { platform?: NodeJS.Platform } = {},
): ClaudeCli {
  return {
    async available() {
      if (env.HYDRA_ONIX_MCP_HOME) return false;
      return onPath(env, opts.platform ?? process.platform);
    },
    addUserServer(name, entry) {
      return new Promise<void>((resolve, reject) => {
        execFile(
          'claude',
          ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(entry)],
          { env },
          (error, _stdout, stderr) => {
            if (!error) {
              resolve();
              return;
            }
            const detail = String(stderr).trim() || error.message;
            reject(new HarnessError('`claude mcp add-json` failed.', { hint: detail, cause: error }));
          },
        );
      });
    },
  };
}
