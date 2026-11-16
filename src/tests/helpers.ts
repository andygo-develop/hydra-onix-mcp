/**
 * Shared test helpers.
 *
 * Tests must never touch the real home directory, so every test that needs
 * paths gets a throwaway home under the OS temp dir via `HYDRA_ONIX_MCP_HOME`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hydraPaths, type HydraPaths } from '../paths.js';

const tempDirs: string[] = [];

export async function makeTempHome(): Promise<{ env: NodeJS.ProcessEnv; paths: HydraPaths }> {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-onix-mcp-'));
  tempDirs.push(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, HYDRA_ONIX_MCP_HOME: dir };
  // An inherited override would redirect credentials out of the temp home.
  delete env.HYDRA_ONIX_MCP_CREDENTIALS_PATH;
  return { env, paths: hydraPaths(env) };
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
