/**
 * Setting up coding agents: registering the server with each one.
 *
 * Registration touches a file the user might have opinions about, so it asks
 * first — once per agent that is not already registered. Idempotent.
 */
import path from 'node:path';

import type { ClaudeCli } from '../claude-cli.js';
import {
  inspectTargetRegistration,
  registerTargetServer,
  type TargetRegisterResult,
  type TargetRegistrationState,
} from './mcp.js';
import { TARGETS } from './registry.js';
import type { TargetDefinition, TargetId } from './types.js';

export interface TargetMcpOutcome extends TargetRegisterResult {
  /** The user declined, or the session was not interactive. */
  declined?: boolean;
  /** Registering failed for this target (e.g. its file is not valid JSON); the others still ran. */
  error?: Error;
}

export interface RegisterTargetsOptions {
  home: string;
  serverName: string;
  /** Asked once per target that is not already registered. */
  confirm: (target: TargetDefinition, state: TargetRegistrationState) => Promise<boolean>;
  platform?: NodeJS.Platform;
  claude?: ClaudeCli;
  env?: NodeJS.ProcessEnv;
}

export async function registerTargets(
  targets: readonly TargetId[],
  options: RegisterTargetsOptions,
): Promise<TargetMcpOutcome[]> {
  const { home, serverName, platform, claude, env } = options;
  const outcomes: TargetMcpOutcome[] = [];

  // Sequential on purpose: one confirmation prompt at a time.
  for (const id of targets) {
    const target = TARGETS[id];
    try {
      const state = await inspectTargetRegistration(home, target, serverName, { platform });

      if (state.registered) {
        outcomes.push({ ...state, changed: false });
        continue;
      }

      if (!(await options.confirm(target, state))) {
        outcomes.push({ ...state, changed: false, declined: true });
        continue;
      }

      outcomes.push(await registerTargetServer(home, target, serverName, { platform, claude, env }));
    } catch (error) {
      // One unreadable or unparsable file must not stop the other agents.
      outcomes.push({ ...failedState(home, target), error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  return outcomes;
}

function failedState(home: string, target: TargetDefinition): TargetRegisterResult {
  return {
    target: target.id,
    label: target.label,
    configFile: path.join(home, ...target.mcp.file.split('/')),
    relativeFile: `~/${target.mcp.file}`,
    fileExists: true,
    registered: false,
    current: false,
    otherServers: [],
    changed: false,
  };
}
