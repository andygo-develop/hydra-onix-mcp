import { describe, expect, it, vi } from 'vitest';

const NAMES = [
  'PACKAGE_NAME', 'SERVER_NAME', 'DEFAULT_MCP_URL', 'DEFAULT_APP_URL', 'SESSION_COOKIE_PREFIX',
  'TOKEN_REFRESH_MARGIN_MS', 'FALLBACK_TOKEN_TTL_MS', 'LOGIN_TIMEOUT_MS', 'SILENT_LOGIN_TIMEOUT_MS',
  'LOCK_STALE_MS', 'COOKIE_POLL_MS', 'LOGIN_REQUIRED_CODE', 'mcpUrl', 'appUrl',
  'hydraPaths', 'HarnessError', 'isHarnessError', 'commandHint', 'packageVersion',
  'refreshSession', 'cookieHeader', 'applySetCookies', 'tokenExpiry', 'SessionExpiredError', 'HydraUnavailableError',
  'CredentialStore', 'toCredentials', 'CorruptCredentialsError',
  'TokenManager', 'createTokenManager', 'LoginRequiredError',
  'findBrowser', 'browserLogin', 'captureSession', 'chromeArgs', 'launchChrome', 'appCookies',
  'LoginCancelledError', 'LoginTimeoutError', 'BrowserLaunchError', 'NoBrowserError',
  'manualLogin', 'parseCookieInput', 'openUrl', 'startRelay', 'authorizedFetch',
  'TARGETS', 'ALL_TARGETS', 'TARGET_IDS', 'detectTargets', 'parseTargetIds', 'requireTarget',
  'inspectTargetRegistration', 'registerTargetServer', 'registerTargets',
  'mcpLaunch', 'mcpCommandLine', 'defaultClaudeCli',
  'loadConfig', 'saveConfig', 'ensureConfig', 'configSchema',
  'runDoctor', 'DOCTOR_COMMANDS',
];

describe('public exports', () => {
  it('exposes every public name and writes nothing on import', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let mod: typeof import('../index.js');
    try {
      mod = await import('../index.js');
      expect(out).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const record = mod as unknown as Record<string, unknown>;
    for (const name of NAMES) {
      expect(record[name], name).toBeDefined();
    }
    expect(mod.isHarnessError(new mod.HarnessError('x'))).toBe(true);
  });
});
