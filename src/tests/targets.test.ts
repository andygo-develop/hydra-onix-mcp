/**
 * User-level agent targets: detection and MCP registration in three
 * configuration dialects. Registering must be idempotent and must preserve the
 * user's own servers, customised entries and unrelated config keys.
 */
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HarnessError } from '../errors.js';
import { defaultClaudeCli, type ClaudeCli } from '../generators/claude-cli.js';
import { registerTargets } from '../generators/targets/install.js';
import { inspectTargetRegistration, registerTargetServer } from '../generators/targets/mcp.js';
import { detectTargets, parseTargetIds, requireTarget, TARGETS } from '../generators/targets/registry.js';
import { TARGET_IDS } from '../generators/targets/types.js';
import { cleanupTempDirs, makeTempHome } from './helpers.js';

afterEach(cleanupTempDirs);

const PKG = '@andygo.dev/hydra-onix-mcp';
const NAME = 'hydra-onix';

async function makeHome(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const { env, paths } = await makeTempHome();
  return { home: paths.home, env };
}

const read = (home: string, file: string) => readFile(path.join(home, file), 'utf8');

async function put(home: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(home, file)), { recursive: true });
  await writeFile(path.join(home, file), content);
}

function fakeClaude(available: boolean, failWith?: Error): ClaudeCli & { calls: [string, object][] } {
  const calls: [string, object][] = [];
  return {
    calls,
    available: async () => available,
    addUserServer: async (name, entry) => {
      calls.push([name, entry]);
      if (failWith) throw failWith;
    },
  };
}

describe('the target registry', () => {
  it('describes every supported agent at user level', () => {
    expect(TARGET_IDS.map((id) => TARGETS[id].mcp.file)).toEqual([
      '.claude.json',
      '.cursor/mcp.json',
      '.codex/config.toml',
      '.gemini/settings.json',
      '.config/opencode/opencode.json',
    ]);
    for (const id of TARGET_IDS) {
      expect(TARGETS[id].id).toBe(id);
      expect(TARGETS[id].label).toBeTruthy();
      expect(TARGETS[id].markers.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown agent with the list of real ones', () => {
    expect(() => requireTarget('copilot')).toThrow(/Unknown coding agent "copilot"/);
    try {
      requireTarget('copilot');
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('claude-code');
    }
  });

  it('accepts repeated and comma-separated flags, dropping duplicates', () => {
    expect(parseTargetIds(['cursor,codex', 'cursor', ' gemini '])).toEqual(['cursor', 'codex', 'gemini']);
  });

  it('detects the agents the user already shows signs of', async () => {
    const { home } = await makeHome();
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(path.join(home, '.claude.json'), '{}');

    expect(await detectTargets(home)).toEqual(['claude-code', 'cursor', 'opencode']);
  });

  it('detects nothing in a bare home', async () => {
    expect(await detectTargets((await makeHome()).home)).toEqual([]);
  });
});

describe('MCP registration per agent', () => {
  it.each([
    ['cursor', '.cursor/mcp.json'],
    ['gemini', '.gemini/settings.json'],
  ] as const)('registers %s in %s under mcpServers', async (id, file) => {
    const { home } = await makeHome();
    const result = await registerTargetServer(home, TARGETS[id], NAME);

    expect(result.changed).toBe(true);
    expect(result.relativeFile).toBe(`~/${file}`);
    expect(JSON.parse(await read(home, file)).mcpServers[NAME]).toEqual({
      command: 'npx',
      args: ['-y', PKG, 'mcp', 'start'],
    });
  });

  it.skipIf(process.platform === 'win32').each([
    ['codex', '.codex/config.toml', 'model = "o3"\n'],
    ['claude-code', '.claude.json', '{"theme":"dark"}\n'],
  ] as const)('keeps a private %s config (%s) at 0600', async (id, file, content) => {
    const { home } = await makeHome();
    await put(home, file, content);
    await chmod(path.join(home, file), 0o600);

    await registerTargetServer(home, TARGETS[id], NAME, { claude: fakeClaude(false) });

    expect((await stat(path.join(home, file))).mode & 0o777).toBe(0o600);
    expect((await readdir(path.dirname(path.join(home, file)))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('registers OpenCode at ~/.config/opencode/opencode.json with a $schema', async () => {
    const { home } = await makeHome();
    await registerTargetServer(home, TARGETS.opencode, NAME);

    const config = JSON.parse(await read(home, '.config/opencode/opencode.json'));
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.mcp[NAME]).toEqual({
      type: 'local',
      command: ['npx', '-y', PKG, 'mcp', 'start'],
      enabled: true,
    });
  });

  it('registers Codex as a TOML table', async () => {
    const { home } = await makeHome();
    await registerTargetServer(home, TARGETS.codex, NAME);

    const toml = await read(home, '.codex/config.toml');
    expect(toml).toContain(`[mcp_servers.${NAME}]`);
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain(`args = ["-y", "${PKG}", "mcp", "start"]`);
  });

  it('appends to an existing Codex config without touching what is there', async () => {
    const { home } = await makeHome();
    await put(home, '.codex/config.toml', 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');

    await registerTargetServer(home, TARGETS.codex, NAME);
    const toml = await read(home, '.codex/config.toml');

    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('[mcp_servers.other]');
    expect(toml).toContain(`[mcp_servers.${NAME}]`);
  });

  it('sees other servers already configured in each dialect', async () => {
    const { home } = await makeHome();
    await put(home, '.codex/config.toml', '[mcp_servers.other]\ncommand = "x"\n');

    const state = await inspectTargetRegistration(home, TARGETS.codex, NAME);
    expect(state).toMatchObject({ fileExists: true, registered: false });
    expect(state.otherServers).toEqual(['other']);
  });

  it.each(TARGET_IDS)('is idempotent for %s', async (id) => {
    const { home } = await makeHome();
    const claude = fakeClaude(false);
    await registerTargetServer(home, TARGETS[id], NAME, { claude });
    const second = await registerTargetServer(home, TARGETS[id], NAME, { claude });

    expect(second.changed).toBe(false);
    expect(second.registered).toBe(true);
    expect(second.current).toBe(true);
  });

  it('leaves a customised entry alone', async () => {
    const { home } = await makeHome();
    await put(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { [NAME]: { command: 'node', args: ['mine.js'] } } }));

    const result = await registerTargetServer(home, TARGETS.cursor, NAME);

    expect(result.changed).toBe(false);
    expect(result.current).toBe(false);
    expect(JSON.parse(await read(home, '.cursor/mcp.json')).mcpServers[NAME].command).toBe('node');
  });

  it('reports a file that is not valid JSON, naming it', async () => {
    const { home } = await makeHome();
    await put(home, '.gemini/settings.json', '{ nope');

    await expect(inspectTargetRegistration(home, TARGETS.gemini, NAME)).rejects.toMatchObject({
      name: 'HarnessError',
      message: expect.stringContaining('settings.json'),
      hint: expect.stringContaining(path.join(home, '.gemini', 'settings.json')),
    });
  });
});

describe('Claude Code', () => {
  it('registers through the claude CLI when it is available, without writing the file', async () => {
    const { home } = await makeHome();
    const claude = fakeClaude(true);

    const result = await registerTargetServer(home, TARGETS['claude-code'], NAME, { claude });

    expect(claude.calls).toEqual([[NAME, { command: 'npx', args: ['-y', PKG, 'mcp', 'start'] }]]);
    expect(result).toMatchObject({ changed: true, via: 'claude-cli', registered: false });
    await expect(read(home, '.claude.json')).rejects.toThrow();
  });

  it('reports the state as inspected after the CLI succeeds', async () => {
    const { home } = await makeHome();
    const claude: ClaudeCli = {
      available: async () => true,
      addUserServer: async () => {
        await put(home, '.claude.json', JSON.stringify({ mcpServers: { [NAME]: { command: 'npx', args: ['-y', PKG, 'mcp', 'start'] } } }));
      },
    };

    const result = await registerTargetServer(home, TARGETS['claude-code'], NAME, { claude });
    expect(result).toMatchObject({ changed: true, registered: true, current: true });
  });

  it('surfaces a CLI failure', async () => {
    const { home } = await makeHome();
    const claude = fakeClaude(true, new Error('boom'));
    await expect(registerTargetServer(home, TARGETS['claude-code'], NAME, { claude })).rejects.toThrow('boom');
  });

  it('merges into ~/.claude.json when the CLI is unavailable, preserving everything else', async () => {
    const { home } = await makeHome();
    const original = {
      numStartups: 42,
      projects: { '/some/project': { allowedTools: ['Read'], history: [{ display: 'hi' }] } },
      mcpServers: { other: { command: 'other-bin', args: ['--x'] } },
    };
    await put(home, '.claude.json', JSON.stringify(original));

    const result = await registerTargetServer(home, TARGETS['claude-code'], NAME, { claude: fakeClaude(false) });

    expect(result).toMatchObject({ changed: true, via: 'file', registered: true, current: true });
    const config = JSON.parse(await read(home, '.claude.json'));
    expect(config.numStartups).toBe(42);
    expect(config.projects).toEqual(original.projects);
    expect(config.mcpServers.other).toEqual(original.mcpServers.other);
    expect(config.mcpServers[NAME]).toEqual({ command: 'npx', args: ['-y', PKG, 'mcp', 'start'] });
  });

  it('leaves an existing http + oauth entry unchanged', async () => {
    const { home } = await makeHome();
    const entry = { type: 'http', url: 'https://example.test/mcp', oauth: { clientId: 'abc' } };
    await put(home, '.claude.json', JSON.stringify({ mcpServers: { [NAME]: entry } }));
    const claude = fakeClaude(true);

    const result = await registerTargetServer(home, TARGETS['claude-code'], NAME, { claude });

    expect(result).toMatchObject({ registered: true, current: false, changed: false });
    expect(claude.calls).toEqual([]);
    expect(JSON.parse(await read(home, '.claude.json')).mcpServers[NAME]).toEqual(entry);
  });

  it('never uses the real claude CLI when the home is overridden', async () => {
    expect(await defaultClaudeCli({ HYDRA_ONIX_MCP_HOME: '/x', PATH: process.env.PATH }).available()).toBe(false);
  });
  it('falls back to the file write when the claude CLI cannot be started', async () => {
    const { home } = await makeHome();
    const spawnFailure = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const claude = fakeClaude(true, new HarnessError('`claude mcp add-json` failed.', { cause: spawnFailure }));

    const result = await registerTargetServer(home, TARGETS['claude-code'], NAME, { claude });

    expect(claude.calls).toHaveLength(1);
    expect(result).toMatchObject({ changed: true, via: 'file', registered: true, current: true });
    expect(result.note).toContain('could not be started');
    expect(JSON.parse(await read(home, '.claude.json')).mcpServers[NAME]).toEqual({
      command: 'npx',
      args: ['-y', PKG, 'mcp', 'start'],
    });
  });

  it('still surfaces a claude CLI that ran and failed', async () => {
    const { home } = await makeHome();
    const exitFailure = Object.assign(new Error('Command failed'), { code: 1 });
    const claude = fakeClaude(true, new HarnessError('`claude mcp add-json` failed.', { cause: exitFailure }));

    await expect(registerTargetServer(home, TARGETS['claude-code'], NAME, { claude })).rejects.toThrow('add-json');
    await expect(read(home, '.claude.json')).rejects.toThrow();
  });
});

describe('finding the claude CLI', () => {
  async function pathWith(name: string): Promise<string> {
    const { home } = await makeHome();
    const dir = path.join(home, 'bin');
    await put(home, `bin/${name}`, '');
    await chmod(path.join(dir, name), 0o755);
    return dir;
  }

  it('on Windows counts only claude.exe: a .cmd shim cannot be run without a shell', async () => {
    const env = { PATH: await pathWith('claude.cmd') };
    expect(await defaultClaudeCli(env, { platform: 'win32' }).available()).toBe(false);
    const exe = { PATH: await pathWith('claude.exe') };
    expect(await defaultClaudeCli(exe, { platform: 'win32' }).available()).toBe(true);
  });

  it('on POSIX looks for claude', async () => {
    expect(await defaultClaudeCli({ PATH: await pathWith('claude') }, { platform: 'linux' }).available()).toBe(true);
    expect(await defaultClaudeCli({ PATH: await pathWith('claude.exe') }, { platform: 'linux' }).available()).toBe(
      false,
    );
  });
});

describe('Windows', () => {
  it('writes a cmd /c entry that counts as current on win32 only', async () => {
    const { home } = await makeHome();
    await registerTargetServer(home, TARGETS.cursor, NAME, { platform: 'win32' });

    expect(JSON.parse(await read(home, '.cursor/mcp.json')).mcpServers[NAME]).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', PKG, 'mcp', 'start'],
    });
    expect((await inspectTargetRegistration(home, TARGETS.cursor, NAME, { platform: 'win32' })).current).toBe(true);
    expect((await inspectTargetRegistration(home, TARGETS.cursor, NAME, { platform: 'linux' })).current).toBe(false);
  });

  it('writes the OpenCode and Codex launches wrapped too', async () => {
    const { home } = await makeHome();
    await registerTargetServer(home, TARGETS.opencode, NAME, { platform: 'win32' });
    await registerTargetServer(home, TARGETS.codex, NAME, { platform: 'win32' });

    expect(JSON.parse(await read(home, '.config/opencode/opencode.json')).mcp[NAME].command).toEqual([
      'cmd', '/c', 'npx', '-y', PKG, 'mcp', 'start',
    ]);
    expect(await read(home, '.codex/config.toml')).toContain(`command = "cmd"\nargs = ["/c", "npx", "-y", "${PKG}", "mcp", "start"]`);
  });
});

describe('registering several agents', () => {
  it('asks once per unregistered agent and records a decline', async () => {
    const { home } = await makeHome();
    const claude = fakeClaude(false);
    await registerTargetServer(home, TARGETS['claude-code'], NAME, { claude });

    const asked: string[] = [];
    const outcomes = await registerTargets(['claude-code', 'cursor'], {
      home,
      serverName: NAME,
      claude,
      confirm: async (target) => {
        asked.push(target.id);
        return false;
      },
    });

    expect(asked).toEqual(['cursor']);
    expect(outcomes.map((o) => [o.target, o.changed, o.declined ?? false])).toEqual([
      ['claude-code', false, false],
      ['cursor', false, true],
    ]);
    await expect(read(home, '.cursor/mcp.json')).rejects.toThrow();
  });

  it('registers confirmed agents and uses the injected CLI for Claude Code', async () => {
    const { home } = await makeHome();
    const claude = fakeClaude(true);

    const outcomes = await registerTargets(['claude-code', 'gemini'], {
      home,
      serverName: NAME,
      claude,
      confirm: async () => true,
    });

    expect(outcomes.map((o) => [o.target, o.changed])).toEqual([
      ['claude-code', true],
      ['gemini', true],
    ]);
    expect(claude.calls).toHaveLength(1);
  });
});

describe('one broken agent config among several', () => {
  it('is reported for that agent while the others are still registered', async () => {
    const { home } = await makeHome();
    await put(home, '.cursor/mcp.json', '{ nope');

    const outcomes = await registerTargets(['cursor', 'gemini'], {
      home,
      serverName: NAME,
      confirm: async () => true,
    });

    expect(outcomes[0]).toMatchObject({ target: 'cursor', changed: false, relativeFile: '~/.cursor/mcp.json' });
    expect(outcomes[0]!.error?.message).toContain('mcp.json');
    expect(outcomes[1]).toMatchObject({ target: 'gemini', changed: true, registered: true });
    expect(await read(home, '.cursor/mcp.json')).toBe('{ nope');
  });
});

describe('an unreadable agent config (not merely absent)', () => {
  // Only ENOENT means "no file yet"; any other read error must stop before a write.
  it.each(['cursor', 'claude-code', 'codex', 'opencode'] as const)('throws for %s and never writes', async (id) => {
    const { home } = await makeHome();
    const file = path.join(home, ...TARGETS[id].mcp.file.split('/'));
    await mkdir(file, { recursive: true });

    await expect(inspectTargetRegistration(home, TARGETS[id], NAME)).rejects.toMatchObject({
      name: 'HarnessError',
      message: expect.stringContaining(file),
    });
    await expect(registerTargetServer(home, TARGETS[id], NAME, { claude: fakeClaude(false) })).rejects.toMatchObject(
      { name: 'HarnessError' },
    );
    expect((await stat(file)).isDirectory()).toBe(true);
    expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);
  });
});
