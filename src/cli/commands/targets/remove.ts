/**
 * `hydra-onix-mcp targets remove <agent...>`: stop setting up a coding agent.
 *
 * Only the config changes. The agent's own config file, possibly edited by
 * the user since, is left as it is; the command says what was left behind.
 */
import { loadConfig, saveConfig } from '../../../config/config.js';
import { SERVER_NAME } from '../../../constants.js';
import { HarnessError, commandHint } from '../../../errors.js';
import { parseTargetIds, TARGETS } from '../../../generators/targets/registry.js';
import type { TargetId } from '../../../generators/targets/types.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';

export interface TargetsRemoveOptions {
  agents: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface TargetsRemoveResult {
  removed: TargetId[];
  remaining: TargetId[];
}

export async function runTargetsRemove(o: TargetsRemoveOptions): Promise<TargetsRemoveResult> {
  const paths = hydraPaths(o.env ?? process.env);
  const requested = parseTargetIds(o.agents);
  const config = await loadConfig(paths);
  if (!config) {
    throw new HarnessError('No coding agents are set up yet.', { hint: commandHint('hydra-onix-mcp setup') });
  }

  const removed = config.targets.filter((id) => requested.includes(id));
  const remaining = config.targets.filter((id) => !requested.includes(id));
  if (removed.length === 0) return { removed, remaining };
  if (remaining.length === 0) {
    throw new HarnessError('That would leave no coding agent set up at all.', {
      hint: `Keep at least one, or add another first.\n\n${commandHint('hydra-onix-mcp targets add <agent>')}`,
    });
  }

  await saveConfig(paths, { ...config, targets: remaining });
  return { removed, remaining };
}

export async function targetsRemoveCommand(o: TargetsRemoveOptions): Promise<void> {
  const result = await runTargetsRemove(o);
  if (result.removed.length === 0) {
    const names = parseTargetIds(o.agents).map((id) => TARGETS[id].label);
    logger.info(`Not set up for ${names.join(', ')}; nothing to do`);
    return;
  }
  for (const id of result.removed) {
    logger.success(`No longer set up for ${TARGETS[id].label}`);
    logger.print(`    ~/${TARGETS[id].mcp.file} (the "${SERVER_NAME}" entry)`);
  }
  logger.print();
  logger.info('That entry was left in place; delete it yourself if you want it gone.');
}
