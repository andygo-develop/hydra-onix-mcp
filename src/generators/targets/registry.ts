/**
 * The supported coding agents, and how to recognise one under the user's home.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { HarnessError, commandHint } from '../../errors.js';
import { TARGET_IDS, type TargetDefinition, type TargetId } from './types.js';

export const TARGETS: Record<TargetId, TargetDefinition> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    mcp: { file: '.claude.json', style: 'mcpServers' },
    markers: ['.claude', '.claude.json'],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    mcp: { file: '.cursor/mcp.json', style: 'mcpServers' },
    markers: ['.cursor'],
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    mcp: { file: '.codex/config.toml', style: 'codex-toml' },
    markers: ['.codex'],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    mcp: { file: '.gemini/settings.json', style: 'mcpServers' },
    markers: ['.gemini'],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    mcp: { file: '.config/opencode/opencode.json', style: 'opencode' },
    markers: ['.config/opencode'],
  },
};

export const ALL_TARGETS: readonly TargetDefinition[] = TARGET_IDS.map((id) => TARGETS[id]);

export function isTargetId(value: string): value is TargetId {
  return (TARGET_IDS as readonly string[]).includes(value);
}

/** Resolves an id, or throws listing the ids that do exist. */
export function requireTarget(id: string): TargetDefinition {
  if (!isTargetId(id)) {
    throw new HarnessError(`Unknown coding agent "${id}".`, {
      hint:
        `Supported agents:\n\n${ALL_TARGETS.map((target) => `  ${target.id.padEnd(12)} ${target.label}`).join('\n')}` +
        `\n\n${commandHint('npx @andygo.dev/hydra-onix-mcp targets list')}`,
    });
  }
  return TARGETS[id];
}

/**
 * Parses `--target` values, accepting repeated flags and comma-separated lists,
 * preserving the order given and dropping duplicates.
 */
export function parseTargetIds(values: readonly string[]): TargetId[] {
  const ids: TargetId[] = [];
  for (const value of values.flatMap((entry) => entry.split(','))) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const target = requireTarget(trimmed);
    if (!ids.includes(target.id)) ids.push(target.id);
  }
  return ids;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which agents the user already shows signs of using. Markers are checked under
 * `home` only; only consulted when writing a fresh config.
 */
export async function detectTargets(home: string): Promise<TargetId[]> {
  const detected: TargetId[] = [];
  for (const target of ALL_TARGETS) {
    const found = await Promise.all(target.markers.map((marker) => exists(path.join(home, marker))));
    if (found.some(Boolean)) detected.push(target.id);
  }
  return detected;
}
