import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureConfig, loadConfig, saveConfig } from '../config/config.js';
import { cleanupTempDirs, makeTempHome } from './helpers.js';

afterEach(cleanupTempDirs);

describe('user config', () => {
  it('is absent until created', async () => {
    const { paths } = await makeTempHome();
    expect(await loadConfig(paths)).toBeUndefined();
  });

  it('defaults to Claude Code when nothing is detected', async () => {
    const { paths } = await makeTempHome();
    const { config, created } = await ensureConfig(paths);

    expect(created).toBe(true);
    expect(config).toEqual({ version: 1, targets: ['claude-code'] });
    expect(JSON.parse(await readFile(paths.configFile, 'utf8'))).toEqual(config);
  });

  it('records detected agents when it is created', async () => {
    const { paths } = await makeTempHome();
    await mkdir(`${paths.home}/.cursor`, { recursive: true });
    await mkdir(`${paths.home}/.gemini`, { recursive: true });

    expect((await ensureConfig(paths)).config.targets).toEqual(['cursor', 'gemini']);
  });

  it('prefers explicit targets over detection', async () => {
    const { paths } = await makeTempHome();
    await mkdir(`${paths.home}/.cursor`, { recursive: true });

    expect((await ensureConfig(paths, { targets: ['codex'] })).config.targets).toEqual(['codex']);
  });

  it('is idempotent and never rewrites an existing config', async () => {
    const { paths } = await makeTempHome();
    await ensureConfig(paths, { targets: ['cursor'] });
    const again = await ensureConfig(paths, { targets: ['gemini'] });

    expect(again).toEqual({ config: { version: 1, targets: ['cursor'] }, created: false });
    expect(await loadConfig(paths)).toEqual({ version: 1, targets: ['cursor'] });
  });

  it('round-trips through saveConfig', async () => {
    const { paths } = await makeTempHome();
    await saveConfig(paths, { version: 1, targets: ['opencode', 'codex'] });
    expect(await loadConfig(paths)).toEqual({ version: 1, targets: ['opencode', 'codex'] });
  });

  it('rejects invalid JSON, naming the file', async () => {
    const { paths } = await makeTempHome();
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.configFile, '{ nope');

    await expect(loadConfig(paths)).rejects.toMatchObject({
      name: 'HarnessError',
      hint: expect.stringContaining(paths.configFile),
    });
  });

  it('rejects an unknown agent or version, naming the file', async () => {
    const { paths } = await makeTempHome();
    await mkdir(paths.configDir, { recursive: true });

    await writeFile(paths.configFile, JSON.stringify({ version: 1, targets: ['nonsuch'] }));
    await expect(loadConfig(paths)).rejects.toMatchObject({ hint: expect.stringContaining(paths.configFile) });

    await writeFile(paths.configFile, JSON.stringify({ version: 2, targets: [] }));
    await expect(loadConfig(paths)).rejects.toMatchObject({ hint: expect.stringContaining(paths.configFile) });
  });
});
