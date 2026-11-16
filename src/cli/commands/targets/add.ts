/**
 * `hydra-onix-mcp targets add <agent...>`: set up another coding agent.
 *
 * Records the agent in the config and registers the server with it straight
 * away (asking first unless `-y`), so it is usable when the command finishes.
 */
import { ensureConfig, saveConfig } from '../../../config/config.js';
import type { ClaudeCli } from '../../../generators/claude-cli.js';
import type { TargetMcpOutcome } from '../../../generators/targets/install.js';
import { parseTargetIds, TARGETS } from '../../../generators/targets/registry.js';
import type { TargetId } from '../../../generators/targets/types.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';
import { exitNonZeroOnFailures, registerTargetsInteractively } from './install.js';

export interface TargetsAddOptions {
  agents: readonly string[];
  yes?: boolean;
  /** `false` skips the MCP registration. */
  mcp?: boolean;
  env?: NodeJS.ProcessEnv;
  claude?: ClaudeCli;
}

export interface TargetsAddResult {
  added: TargetId[];
  already: TargetId[];
  registrations: TargetMcpOutcome[];
}

export async function runTargetsAdd(o: TargetsAddOptions): Promise<TargetsAddResult> {
  const env = o.env ?? process.env;
  const paths = hydraPaths(env);
  const requested = parseTargetIds(o.agents);

  const { config, created } = await ensureConfig(paths, { targets: requested });
  const added = created ? requested : requested.filter((id) => !config.targets.includes(id));
  const already = created ? [] : requested.filter((id) => config.targets.includes(id));
  if (!created && added.length > 0) {
    await saveConfig(paths, { ...config, targets: [...config.targets, ...added] });
  }

  for (const id of already) logger.info(`${TARGETS[id].label} is already set up`);
  if (added.length > 0) {
    logger.success(`Added ${added.map((id) => TARGETS[id].label).join(', ')} to the configuration`);
  }

  const registrations =
    o.mcp === false ? [] : await registerTargetsInteractively(requested, { yes: o.yes, env, claude: o.claude });
  return { added, already, registrations };
}

export async function targetsAddCommand(o: TargetsAddOptions): Promise<void> {
  exitNonZeroOnFailures((await runTargetsAdd(o)).registrations);
}
