/**
 * `hydra-onix-mcp targets list`: every supported coding agent, whether it is
 * set up (in the config), detected under the home directory, and registered,
 * and whether the registered entry is ours.
 */
import { loadConfig } from '../../../config/config.js';
import { SERVER_NAME } from '../../../constants.js';
import { inspectTargetRegistration } from '../../../generators/targets/mcp.js';
import { ALL_TARGETS, detectTargets } from '../../../generators/targets/registry.js';
import type { TargetId } from '../../../generators/targets/types.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';

export interface TargetListEntry {
  id: TargetId;
  label: string;
  /** Listed in `~/.hydra-onix-mcp/config.json`. */
  enabled: boolean;
  /** The home directory shows signs of this agent. */
  detected: boolean;
  /** An entry named `hydra-onix` exists. */
  registered: boolean;
  /** That entry launches this package's `mcp start`. */
  current: boolean;
  configFile: string;
}

export interface TargetListReport {
  serverName: string;
  configured: boolean;
  targets: TargetListEntry[];
}

export async function runTargetsList(o: { env?: NodeJS.ProcessEnv } = {}): Promise<TargetListReport> {
  const paths = hydraPaths(o.env ?? process.env);
  const config = await loadConfig(paths);
  const enabled = config?.targets ?? [];
  const detected = await detectTargets(paths.home);

  const targets: TargetListEntry[] = [];
  for (const target of ALL_TARGETS) {
    const state = await inspectTargetRegistration(paths.home, target, SERVER_NAME);
    targets.push({
      id: target.id,
      label: target.label,
      enabled: enabled.includes(target.id),
      detected: detected.includes(target.id),
      registered: state.registered,
      current: state.current,
      configFile: state.relativeFile,
    });
  }
  return { serverName: SERVER_NAME, configured: config !== undefined, targets };
}

export async function targetsListCommand(o: { env?: NodeJS.ProcessEnv; json?: boolean } = {}): Promise<void> {
  const report = await runTargetsList(o);
  if (o.json) {
    logger.print(JSON.stringify(report, null, 2));
    return;
  }

  const mark = (value: boolean): string => (value ? 'yes' : '-');
  const mcp = (e: TargetListEntry): string => (!e.registered ? '-' : e.current ? 'yes' : 'not ours');
  logger.print(`${'Agent'.padEnd(12)} ${'Set up'.padEnd(8)} ${'Detected'.padEnd(10)} ${'MCP'.padEnd(9)} Config file`);
  for (const e of report.targets) {
    logger.print(
      `${e.id.padEnd(12)} ${mark(e.enabled).padEnd(8)} ${mark(e.detected).padEnd(10)} ${mcp(e).padEnd(9)} ${e.configFile}`,
    );
  }

  const missing = report.targets.filter((e) => e.detected && !e.enabled);
  if (missing.length > 0) {
    logger.print();
    logger.info(`Detected but not set up: ${missing.map((e) => e.id).join(', ')}`);
    logger.print();
    logger.print('Run:');
    logger.print(`  hydra-onix-mcp targets add ${missing.map((e) => e.id).join(' ')}`);
  }
  if (report.targets.some((e) => e.registered && !e.current)) {
    logger.print();
    logger.info('"not ours": an existing "hydra-onix" entry was left alone; `mcp status` shows the entry to use.');
  }
}
