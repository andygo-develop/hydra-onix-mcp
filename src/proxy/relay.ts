/**
 * The `mcp start` relay: the coding agent talks JSON-RPC over stdio, the relay
 * passes every message through unchanged to the Hydra MCP server over
 * Streamable HTTP, with `Authorization: Bearer <token>` from the TokenManager
 * on every upstream request.
 *
 * Transport-level on purpose: methods, notifications and capabilities pass
 * through without the relay knowing about them. The upstream connects on the
 * first downstream message so the agent's process starts instantly.
 * Downstream messages are dispatched strictly in arrival order (each request
 * leaves only after the one before it did, without waiting for its
 * response), so a login that runs for one message holds the rest, and when
 * that login fails, every message queued behind it shares the failure
 * instead of starting a login of its own.
 *
 * Never write to stdout here (it carries JSON-RPC) and never log tokens.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ErrorCode,
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type InitializeResult,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';

import { LOGIN_REQUIRED_CODE } from '../constants.js';
import { logger } from '../logger.js';
import { LoginRequiredError, type TokenManager } from '../auth/token-manager.js';

export type TokenSource = Pick<TokenManager, 'getToken' | 'onUnauthorized'>;

/**
 * A `fetch` that sets the Bearer token on every request and, on a 401, asks
 * for a new token and retries once. A second 401 is returned as is, and so is
 * a 401 for a streamed body (it cannot be sent twice). Token errors reject.
 */
export function authorizedFetch(
  tokens: TokenSource,
  base: typeof fetch = fetch,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const withToken = (url: string | URL, init: RequestInit | undefined, token: string): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return base(url, { ...init, headers });
  };

  return async (url, init) => {
    // GET is the transport's background SSE stream (and its reconnects): it
    // must never open a login window on its own.
    const interactive = (init?.method ?? 'GET').toUpperCase() !== 'GET';
    const token = await tokens.getToken({ interactive });
    const response = await withToken(url, init, token);
    if (response.status !== 401 || init?.body instanceof ReadableStream) return response;

    await response.body?.cancel().catch(() => undefined);
    const renewed = await tokens.onUnauthorized(token, { interactive });
    return withToken(url, init, renewed);
  };
}

export interface RelayOptions {
  mcpUrl: string;
  tokens: TokenSource;
  /** The agent side; defaults to stdio. */
  downstream?: Transport;
  /** Base fetch for upstream requests (the Bearer wrapper goes around it). */
  fetch?: typeof fetch;
  /** Where upstream errors are reported; defaults to stderr. */
  log?: (message: string) => void;
}

export interface Relay {
  close(): Promise<void>;
  /** Resolves once the relay has shut down, by `close()` or because the agent went away. */
  closed: Promise<void>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function startRelay(o: RelayOptions): Promise<Relay> {
  const log = o.log ?? ((m: string) => logger.error(m));
  const usesStdio = !o.downstream;
  const downstream = o.downstream ?? new StdioServerTransport();

  let upstream: StreamableHTTPClientTransport | undefined;
  let initializeId: RequestId | undefined;
  let chain: Promise<void> = Promise.resolve();
  /** Downstream messages received so far (each gets its arrival number). */
  let received = 0;
  /** The last failed login and the arrival number it covers. */
  let loginFailure: { through: number; error: LoginRequiredError } | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const toDownstream = (m: JSONRPCMessage): void => {
    downstream.send(m).catch((error: unknown) => {
      if (!closing) log(`Could not reply to the agent: ${message(error)}`);
    });
  };

  // Fires when a POST actually leaves (token in hand), so the queue can move on.
  let onDispatch: (() => void) | undefined;
  const base = o.fetch ?? fetch;
  const dispatching: typeof fetch = (url, init) => {
    if (init?.method === 'POST') onDispatch?.();
    return base(url, init);
  };

  const connectUpstream = async (): Promise<StreamableHTTPClientTransport> => {
    const transport = new StreamableHTTPClientTransport(new URL(o.mcpUrl), {
      fetch: authorizedFetch(o.tokens, dispatching),
    });
    transport.onmessage = (m) => {
      if (initializeId !== undefined && isJSONRPCResultResponse(m) && m.id === initializeId) {
        initializeId = undefined;
        const version = (m.result as InitializeResult).protocolVersion;
        if (version) transport.setProtocolVersion(version);
      }
      toDownstream(m);
    };
    transport.onerror = (error) => {
      if (!closing) log(`Hydra MCP: ${message(error)}`);
    };
    await transport.start();
    return transport;
  };

  /** A notification has no one to answer; a request gets a JSON-RPC error. */
  const answerError = (m: JSONRPCMessage, error: unknown): void => {
    if (!isJSONRPCRequest(m) || closing) return;
    const code = error instanceof LoginRequiredError ? LOGIN_REQUIRED_CODE : ErrorCode.InternalError;
    toDownstream({ jsonrpc: '2.0', id: m.id, error: { code, message: message(error) } });
  };

  const failed = (m: JSONRPCMessage, error: unknown): void => {
    // Everything that arrived while that login ran shares its failure.
    if (error instanceof LoginRequiredError) loginFailure = { through: received, error };
    answerError(m, error);
  };

  /**
   * Sends `m` upstream and returns once its request is on its way (or has
   * failed), not when the response is back: dispatch is strictly in order,
   * a slow call does not hold the ones after it. `initialize` is the
   * exception, since its response carries the session id later sends need.
   */
  const forward = async (m: JSONRPCMessage, seq: number): Promise<void> => {
    if (closing) return;
    if (loginFailure && seq <= loginFailure.through) {
      answerError(m, loginFailure.error);
      return;
    }
    let transport: StreamableHTTPClientTransport;
    try {
      transport = upstream ??= await connectUpstream();
    } catch (error) {
      log(`Hydra MCP: ${message(error)}`);
      answerError(m, error);
      return;
    }
    const isInitialize = isInitializeRequest(m) && isJSONRPCRequest(m);
    if (isInitialize) initializeId = m.id;
    const dispatched = new Promise<void>((resolve) => (onDispatch = resolve));
    // The transport already reported a send failure through `onerror`.
    const settled = transport.send(m).catch((error: unknown) => failed(m, error));
    await (isInitialize ? settled : Promise.race([dispatched, settled]));
    onDispatch = undefined;
  };

  const onStdinEnd = (): void => void close();

  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (usesStdio) {
        process.stdin.off('end', onStdinEnd);
        process.stdin.off('close', onStdinEnd);
      }
      await Promise.allSettled([upstream?.close(), downstream.close()]);
      resolveClosed();
    })();
    return closing;
  };

  downstream.onmessage = (m: JSONRPCMessage) => {
    const seq = ++received;
    chain = chain.then(() => forward(m, seq));
  };
  downstream.onerror = (error) => {
    if (!closing) log(`Agent connection: ${message(error)}`);
  };
  downstream.onclose = () => void close();
  if (usesStdio) {
    // The stdio transport does not notice when the agent closes our stdin.
    process.stdin.once('end', onStdinEnd);
    process.stdin.once('close', onStdinEnd);
  }
  await downstream.start();

  return { close, closed };
}
