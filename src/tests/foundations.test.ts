import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appUrl, DEFAULT_APP_URL, DEFAULT_MCP_URL, mcpUrl } from '../constants.js';
import { commandHint, HarnessError, isHarnessError } from '../errors.js';
import { packageVersion } from '../package-version.js';
import { hydraPaths } from '../paths.js';
import { cleanupTempDirs, makeTempHome } from './helpers.js';

afterEach(cleanupTempDirs);

describe('hydraPaths', () => {
  it('derives everything from HYDRA_ONIX_MCP_HOME', () => {
    const paths = hydraPaths({ HYDRA_ONIX_MCP_HOME: '/h' });
    expect(paths.home).toBe(join('/h'));
    expect(paths.configDir).toBe(join('/h', '.hydra-onix-mcp'));
    expect(paths.configFile).toBe(join('/h', '.hydra-onix-mcp', 'config.json'));
    expect(paths.credentialsFile).toBe(join('/h', '.hydra-onix-mcp', 'credentials.json'));
    expect(paths.browserProfile).toBe(join('/h', '.hydra-onix-mcp', 'browser-profile'));
    expect(paths.lockFile.endsWith('credentials.json.lock')).toBe(true);
  });

  it('lets HYDRA_ONIX_MCP_CREDENTIALS_PATH override only credentials and lock', () => {
    const base = hydraPaths({ HYDRA_ONIX_MCP_HOME: '/h' });
    const paths = hydraPaths({ HYDRA_ONIX_MCP_HOME: '/h', HYDRA_ONIX_MCP_CREDENTIALS_PATH: '/x/c.json' });
    expect(paths.credentialsFile).toBe(join('/x/c.json'));
    expect(paths.lockFile).toBe(`${join('/x/c.json')}.lock`);
    expect(paths.configDir).toBe(base.configDir);
    expect(paths.configFile).toBe(base.configFile);
    expect(paths.browserProfile).toBe(base.browserProfile);
  });

  it('makeTempHome ignores an inherited credentials override', async () => {
    const { env, paths } = await makeTempHome();
    expect(env.HYDRA_ONIX_MCP_CREDENTIALS_PATH).toBeUndefined();
    expect(paths.credentialsFile.startsWith(paths.home)).toBe(true);
  });
});

describe('urls', () => {
  it('strips a trailing slash from the app url', () => {
    expect(appUrl({ HYDRA_ONIX_MCP_APP_URL: 'http://127.0.0.1:1/' })).toBe('http://127.0.0.1:1');
  });

  it('falls back to defaults', () => {
    expect(appUrl({})).toBe('https://projects.onix.hydra-systems.net');
    expect(appUrl({})).toBe(DEFAULT_APP_URL);
    expect(mcpUrl({})).toBe('https://api.projects.onix.hydra-systems.net/mcp');
    expect(mcpUrl({})).toBe(DEFAULT_MCP_URL);
  });

  it('honours HYDRA_ONIX_MCP_URL', () => {
    expect(mcpUrl({ HYDRA_ONIX_MCP_URL: 'http://127.0.0.1:2/mcp/' })).toBe('http://127.0.0.1:2/mcp');
  });
});

describe('packageVersion', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe('HarnessError', () => {
  it('keeps hint and exitCode', () => {
    const e = new HarnessError('m', { hint: 'h', exitCode: 2 });
    expect(e.message).toBe('m');
    expect(e.hint).toBe('h');
    expect(e.exitCode).toBe(2);
    expect(isHarnessError(e)).toBe(true);
    expect(isHarnessError(new Error('x'))).toBe(false);
  });

  it('defaults exitCode to 1 and formats command hints', () => {
    expect(new HarnessError('m').exitCode).toBe(1);
    expect(commandHint('a', 'b')).toBe('Run:\n\n  a\n  b');
  });
});
