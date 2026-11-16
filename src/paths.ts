/**
 * Where the CLI keeps its state on disk.
 *
 * Everything lives under one per-user directory so it can be inspected or
 * removed in one go. `HYDRA_ONIX_MCP_HOME` replaces the home directory (used
 * by tests so they never touch the real one) and
 * `HYDRA_ONIX_MCP_CREDENTIALS_PATH` relocates only the credentials file.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The per-user state directory's name, under the home directory. */
export const CONFIG_DIR_NAME = '.hydra-onix-mcp';

export interface HydraPaths {
  home: string;
  configDir: string;
  configFile: string;
  credentialsFile: string;
  lockFile: string;
  browserProfile: string;
}

export function hydraPaths(env: NodeJS.ProcessEnv = process.env): HydraPaths {
  const home = resolve(env.HYDRA_ONIX_MCP_HOME || homedir());
  const configDir = join(home, CONFIG_DIR_NAME);
  const credentialsFile = env.HYDRA_ONIX_MCP_CREDENTIALS_PATH
    ? resolve(env.HYDRA_ONIX_MCP_CREDENTIALS_PATH)
    : join(configDir, 'credentials.json');

  return {
    home,
    configDir,
    configFile: join(configDir, 'config.json'),
    credentialsFile,
    lockFile: `${credentialsFile}.lock`,
    browserProfile: join(configDir, 'browser-profile'),
  };
}
