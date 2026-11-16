import { describe, expect, it, vi } from 'vitest';
import { openUrl } from '../auth/open-url.js';
import { manualLogin, parseCookieInput } from '../auth/manual-login.js';
import { HydraUnavailableError, SessionExpiredError, type SessionResult } from '../auth/session.js';
import { HarnessError } from '../errors.js';

const P = '__Secure-next-auth.session-token';
const result: SessionResult = { accessToken: 't', accessTokenExpires: '2030-01-01T00:00:00Z', cookies: [] };

describe('parseCookieInput', () => {
  it('keeps only session-token cookies from a Cookie header', () => {
    expect(parseCookieInput(`Cookie: a=1; ${P}.0=AA; ${P}.1=BB`)).toEqual([
      { name: `${P}.0`, value: 'AA' },
      { name: `${P}.1`, value: 'BB' },
    ]);
  });
  it('accepts name=value per line and strips quotes and whitespace', () => {
    expect(parseCookieInput(`  ${P}.0="AA" \n ${P}.1='BB'\n`)).toEqual([
      { name: `${P}.0`, value: 'AA' },
      { name: `${P}.1`, value: 'BB' },
    ]);
  });
  it('treats a bare value as the unchunked token', () => {
    expect(parseCookieInput(' "abc.def" ')).toEqual([{ name: P, value: 'abc.def' }]);
  });
  it('returns [] for empty input', () => {
    expect(parseCookieInput('  ')).toEqual([]);
  });
  it('keeps = signs inside values', () => {
    expect(parseCookieInput(`${P}.0=AA==`)).toEqual([{ name: `${P}.0`, value: 'AA==' }]);
  });
});

describe('manualLogin', () => {
  const base = { appUrl: 'https://app.test', print: () => {} };

  it('opens the app, asks once, validates and returns the result', async () => {
    const open = vi.fn();
    const ask = vi.fn().mockResolvedValue(`${P}.0=AA; ${P}.1=BB`);
    const validate = vi.fn().mockResolvedValue(result);
    await expect(manualLogin({ ...base, open, ask, validate })).resolves.toBe(result);
    expect(open).toHaveBeenCalledWith('https://app.test/');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith([
      { name: `${P}.0`, value: 'AA' },
      { name: `${P}.1`, value: 'BB' },
    ]);
  });

  it('mentions both chunks in the instructions', async () => {
    const print = vi.fn();
    await manualLogin({ ...base, print, open: vi.fn(), ask: async () => 'x', validate: async () => result });
    const text = print.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toContain('https://app.test/');
    expect(text).toContain(`${P}.0`);
    expect(text).toContain(`${P}.1`);
  });

  it('asks again on empty parse, then gives up after 3 tries', async () => {
    const ask = vi.fn().mockResolvedValue('');
    const validate = vi.fn();
    await expect(manualLogin({ ...base, open: vi.fn(), ask, validate })).rejects.toBeInstanceOf(HarnessError);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(validate).not.toHaveBeenCalled();
  });

  it('recovers when a later attempt parses', async () => {
    const ask = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('tok');
    await expect(manualLogin({ ...base, open: vi.fn(), ask, validate: async () => result })).resolves.toBe(result);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('reports rejected cookies without echoing their values', async () => {
    const ask = async () => `${P}.0=SECRETVALUE`;
    const validate = async (): Promise<SessionResult> => {
      throw new SessionExpiredError();
    };
    const err = await manualLogin({ ...base, open: vi.fn(), ask, validate }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    const e = err as HarnessError;
    expect(e.message).toMatch(/did not accept/);
    expect(`${e.message} ${e.hint}`).not.toContain('SECRETVALUE');
  });

  it('lets HydraUnavailableError propagate unchanged', async () => {
    const boom = new HydraUnavailableError('down');
    const validate = async (): Promise<SessionResult> => {
      throw boom;
    };
    await expect(manualLogin({ ...base, open: vi.fn(), ask: async () => 'tok', validate })).rejects.toBe(boom);
  });
});

describe('openUrl', () => {
  const url = 'https://app.test/';
  const run = (platform: NodeJS.Platform) => {
    const spawn = vi.fn().mockReturnValue({ on: vi.fn(), unref: vi.fn() });
    openUrl(url, { platform, spawn: spawn as never });
    return spawn;
  };

  it('uses open on darwin', () => {
    expect(run('darwin').mock.calls[0]!.slice(0, 2)).toEqual(['open', [url]]);
  });
  it('uses cmd /c start on win32', () => {
    expect(run('win32').mock.calls[0]!.slice(0, 2)).toEqual(['cmd', ['/c', 'start', '""', url]]);
  });
  it('uses xdg-open elsewhere', () => {
    expect(run('linux').mock.calls[0]!.slice(0, 2)).toEqual(['xdg-open', [url]]);
  });
  it('never throws when spawn throws', () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => openUrl(url, { platform: 'linux', spawn: spawn as never })).not.toThrow();
  });
});
