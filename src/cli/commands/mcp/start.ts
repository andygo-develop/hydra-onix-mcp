/**
 * `hydra-onix-mcp mcp start`: the stdio relay, launched by coding agents.
 *
 * stdout carries JSON-RPC, so human-facing output is moved to stderr before
 * anything else happens. Resolves once the relay has shut down: the agent
 * closed stdin, or SIGINT/SIGTERM arrived.
 */
import { createTokenManager } from '../../../auth/token-manager.js';
import { appUrl, mcpUrl } from '../../../constants.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';
import { startRelay } from '../../../proxy/relay.js';

export interface McpStartOptions {
  env?: NodeJS.ProcessEnv;
}

export async function mcpStartCommand(o: McpStartOptions = {}): Promise<void> {
  logger.useStderr();
  const env = o.env ?? process.env;

  const relay = await startRelay({
    mcpUrl: mcpUrl(env),
    tokens: createTokenManager(hydraPaths(env), appUrl(env), env),
  });

  const stop = (): void => void relay.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await relay.closed;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
