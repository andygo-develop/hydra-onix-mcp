/**
 * The `mcp start` relay: the coding agent talks JSON-RPC over stdio, the relay
 * passes every message through unchanged to the Hydra MCP server over
 * Streamable HTTP, with `Authorization: Bearer <token>` from the TokenManager
 * on every upstream request.
 *
 * Transport-level on purpose: methods, notifications and capabilities pass
 * through without the relay knowing about them. The upstream connects on the
 * first downstream message so the agent's process starts instantly, and
 * downstream messages are sent strictly one after another, so a login that
 * runs for the first one holds the rest until it is done.
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
    const token = await tokens.getToken({ interactive: true });
    const response = await withToken(url, init, token);
    if (response.status !== 401 || init?.body instanceof ReadableStream) return response;

    await response.body?.cancel().catch(() => undefined);
    const renewed = await tokens.onUnauthorized(token, { interactive: true });
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
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const toDownstream = (m: JSONRPCMessage): void => {
    downstream.send(m).catch((error: unknown) => {
      if (!closing) log(`Could not reply to the agent: ${message(error)}`);
    });
  };

  const connectUpstream = async (): Promise<StreamableHTTPClientTransport> => {
    const transport = new StreamableHTTPClientTransport(new URL(o.mcpUrl), {
      fetch: authorizedFetch(o.tokens, o.fetch),
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

  const forward = async (m: JSONRPCMessage): Promise<void> => {
    if (closing) return;
    try {
      upstream ??= await connectUpstream();
      if (isInitializeRequest(m) && isJSONRPCRequest(m)) initializeId = m.id;
      await upstream.send(m);
    } catch (error) {
      // The transport already reported the error through `onerror`. A
      // notification has no one to answer; a request gets a JSON-RPC error.
      if (isJSONRPCRequest(m) && !closing) {
        const code = error instanceof LoginRequiredError ? LOGIN_REQUIRED_CODE : ErrorCode.InternalError;
        toDownstream({ jsonrpc: '2.0', id: m.id, error: { code, message: message(error) } });
      }
    }
  };

  const onStdinEnd = (): void => void close();

  const close = (): Promise<void> => {
    // Deferred so `closing` is set before `downstream.close()` runs: the stdio
    // transport calls `onclose` (which calls this again) synchronously.
    closing ??= Promise.resolve().then(async () => {
      if (usesStdio) {
        process.stdin.off('end', onStdinEnd);
        process.stdin.off('close', onStdinEnd);
      }
      await Promise.allSettled([upstream?.close(), downstream.close()]);
      resolveClosed();
    });
    return closing;
  };

  downstream.onmessage = (m: JSONRPCMessage) => {
    chain = chain.then(() => forward(m));
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
