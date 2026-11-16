/**
 * `hydra-onix-mcp mcp status`: registration per configured coding agent, plus
 * the login state. Per agent, because one can be registered and another not,
 * and a single yes/no would hide exactly that.
 */
import { loadConfig } from '../../../config/config.js';
import { appUrl, mcpUrl, SERVER_NAME } from '../../../constants.js';
import { inspectRegistrations } from '../../../generators/targets/mcp.js';
import { TARGETS } from '../../../generators/targets/registry.js';
import type { TargetId } from '../../../generators/targets/types.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';
import { printAuthStatus, runAuthStatus, type AuthStatus } from '../auth/status.js';
import { manualEntry } from '../targets/install.js';

export interface McpStatusReport {
  serverName: string;
  mcpUrl: string;
  appUrl: string;
  configured: boolean;
  targets: Array<{
    target: TargetId;
    label: string;
    registered: boolean;
    current: boolean;
    configFile: string;
  }>;
  login: AuthStatus;
}

export interface McpStatusOptions {
  env?: NodeJS.ProcessEnv;
  find?: () => Promise<string | undefined>;
}

export async function runMcpStatus(o: McpStatusOptions = {}): Promise<McpStatusReport> {
  const env = o.env ?? process.env;
  const paths = hydraPaths(env);
  const config = await loadConfig(paths);
  const states = await inspectRegistrations(paths.home, config?.targets ?? [], SERVER_NAME);

  return {
    serverName: SERVER_NAME,
    mcpUrl: mcpUrl(env),
    appUrl: appUrl(env),
    configured: config !== undefined,
    targets: states.map((s) => ({
      target: s.target,
      label: s.label,
      registered: s.registered,
      current: s.current,
      configFile: s.relativeFile,
    })),
    login: await runAuthStatus({ env, find: o.find }),
  };
}

export async function mcpStatusCommand(o: McpStatusOptions & { json?: boolean } = {}): Promise<void> {
  const report = await runMcpStatus(o);
  if (o.json) {
    logger.print(JSON.stringify(report, null, 2));
    return;
  }

  logger.print(`Server name:  ${report.serverName}`);
  logger.print(`Hydra MCP:    ${report.mcpUrl}`);
  logger.print();

  if (!report.configured) {
    logger.warn('No coding agents set up yet');
    logger.print();
    logger.print('Run:');
    logger.print('  npx @andygo.dev/hydra-onix-mcp setup');
  }
  for (const t of report.targets) {
    if (!t.registered) {
      logger.warn(`Not registered with ${t.label}`);
    } else if (t.current) {
      logger.success(`Registered with ${t.label} in ${t.configFile}`);
    } else {
      logger.warn(`Registered with ${t.label} in ${t.configFile}, not ours (left alone)`);
      logger.print('    To use this package, replace that entry with:');
      for (const line of manualEntry(TARGETS[t.target]).split('\n')) logger.print(`      ${line}`);
    }
  }
  if (report.targets.some((t) => !t.registered)) {
    logger.print();
    logger.print('Run:');
    logger.print('  npx @andygo.dev/hydra-onix-mcp targets install');
  }

  logger.print();
  printAuthStatus(report.login);
}
