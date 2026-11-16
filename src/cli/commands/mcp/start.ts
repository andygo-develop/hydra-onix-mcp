/**
 * `hydra-onix-mcp mcp start`: the stdio relay, launched by coding agents.
 *
 * stdout carries JSON-RPC, so human-facing output is moved to stderr before
 * anything else happens.
 *
 * Shutdown (the agent closed stdin, or SIGINT/SIGTERM) closes the relay,
 * kills any login browser this process launched, and exits. The exit is
 * explicit: a browser login in flight would otherwise keep the process (its
 * window, and the credentials lock) alive for up to the 5-minute login timeout.
 * Locks held at that moment are released by the store's exit handler.
 */
import { killActiveBrowsers } from '../../../auth/browser/login.js';
import { createTokenManager } from '../../../auth/token-manager.js';
import { appUrl, mcpUrl } from '../../../constants.js';
import { logger } from '../../../logger.js';
import { hydraPaths } from '../../../paths.js';
import { startRelay, type Relay, type RelayOptions } from '../../../proxy/relay.js';

export interface McpStartOptions {
  env?: NodeJS.ProcessEnv;
  /** Ends the process; defaults to exiting once stdout has drained. Injected by tests. */
  exit?: (code: number) => void;
  /** Starts the relay; injected by tests. */
  start?: (o: RelayOptions) => Promise<Relay>;
}

/** How long to wait for stdout to drain before exiting anyway. */
const EXIT_FALLBACK_MS = 2_000;

/**
 * Exits once everything already written to stdout (JSON-RPC replies) is
 * flushed, or after a short fallback if the agent stopped reading it.
 */
function exitAfterDrain(code: number): void {
  setTimeout(() => process.exit(code), EXIT_FALLBACK_MS).unref();
  process.stdout.write('', () => process.exit(code));
}

export async function mcpStartCommand(o: McpStartOptions = {}): Promise<void> {
  logger.useStderr();
  const env = o.env ?? process.env;
  const exit = o.exit ?? exitAfterDrain;

  const relay = await (o.start ?? startRelay)({
    mcpUrl: mcpUrl(env),
    tokens: createTokenManager(hydraPaths(env), appUrl(env), env),
  });

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (stopping ??= (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await relay.close();
      killActiveBrowsers();
      exit(0);
    })());
  const onSignal = (): void => void shutdown();

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await relay.closed;
  await shutdown();
}
