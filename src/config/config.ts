/**
 * Reading and writing `~/.hydra-onix-mcp/config.json`. Writes are atomic
 * (temp file + rename). The file holds no credentials.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

import { HarnessError } from '../errors.js';
import { detectTargets } from '../generators/targets/registry.js';
import type { TargetId } from '../generators/targets/types.js';
import type { HydraPaths } from '../paths.js';
import { configSchema, type UserConfig } from './schema.js';

/** Loads config, or undefined when none has been written yet. */
export async function loadConfig(paths: HydraPaths): Promise<UserConfig | undefined> {
  let text: string;
  try {
    text = await readFile(paths.configFile, 'utf8');
  } catch (cause) {
    // Only "no file yet" is absent; anything else would lead to an overwrite.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new HarnessError(`Could not read the user config ${paths.configFile} (${code ?? 'unknown error'}).`, {
      hint: 'Fix its permissions or remove it, then re-run setup.',
      cause,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new HarnessError('The user config is not valid JSON.', {
      hint: `Fix it, or delete it and re-run setup.\n\nFile: ${paths.configFile}`,
      cause,
    });
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new HarnessError('The user config is not valid.', {
      hint: `${issues}\n\nFix it, or delete it and re-run setup.\n\nFile: ${paths.configFile}`,
    });
  }
  return parsed.data;
}

export async function saveConfig(paths: HydraPaths, config: UserConfig): Promise<void> {
  // The directory also holds the credentials and the browser profile: 0700.
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(paths.configDir, 0o700);
  const temp = `${paths.configFile}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(temp, paths.configFile);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Creates the config if absent; never touches an existing one. */
export async function ensureConfig(
  paths: HydraPaths,
  options: { targets?: readonly TargetId[] } = {},
): Promise<{ config: UserConfig; created: boolean }> {
  const existing = await loadConfig(paths);
  if (existing) return { config: existing, created: false };

  const chosen = options.targets ?? (await detectTargets(paths.home));
  const targets: TargetId[] = chosen.length > 0 ? [...chosen] : ['claude-code'];
  const config: UserConfig = { version: 1, targets };
  await saveConfig(paths, config);
  return { config, created: true };
}
