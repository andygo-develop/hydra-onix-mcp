import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { LoginRequiredError } from '../auth/token-manager.js';
import { authorizedFetch, startRelay, type TokenSource } from '../proxy/relay.js';
import { startFakeMcp } from './helpers.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeTokens extends TokenSource {
  current: string;
  /** When set, `getToken` rejects with it. */
  fail?: Error;
  /** When set, `getToken` waits for it first. */
  gate?: Promise<void>;
  getToken: ReturnType<typeof vi.fn<TokenSource['getToken']>>;
  onUnauthorized: ReturnType<typeof vi.fn<TokenSource['onUnauthorized']>>;
}

function fakeTokens(initial = 'token-1'): FakeTokens {
  const t: FakeTokens = {
    current: initial,
    getToken: vi.fn(async () => {
      if (t.gate) await t.gate;
      if (t.fail) throw t.fail;
      return t.current;
    }),
    onUnauthorized: vi.fn(async () => t.current),
  };
  return t;
}

interface Call {
  method: string;
  authorization: string | null;
  protocolVersion: string | null;
}

/** Real `fetch`, recording what each upstream request carried. */
function recordingFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const recording: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      protocolVersion: headers.get('mcp-protocol-version'),
    });
    return fetch(url, init);
  };
  return { fetch: recording, calls };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(o: { tokens?: FakeTokens; isValid?: (token: string) => boolean } = {}) {
  const tokens = o.tokens ?? fakeTokens();
  const server = { valid: 'token-1' };
  const fake = await startFakeMcp({ isValid: o.isValid ?? ((token) => token === server.valid) });
  const { fetch: recording, calls } = recordingFetch();
  const [agentSide, relaySide] = InMemoryTransport.createLinkedPair();
  const log = vi.fn<(m: string) => void>();
  const relay = await startRelay({ mcpUrl: fake.url, tokens, downstream: relaySide, fetch: recording, log });
  const client = new Client({ name: 'agent', version: '0.0.0' }, { capabilities: { roots: { listChanged: true } } });
  cleanups.push(fake.close, relay.close);

  /** Connects the agent and waits until the transport opened its GET stream. */
  const connect = async (): Promise<void> => {
    await client.connect(agentSide);
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'GET')).toBe(true));
  };
  return { tokens, server, fake, calls, agentSide, log, relay, client, connect };
}

const echoText = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

describe('startRelay', () => {
  it('relays tools/list and tools/call with the Bearer token on every upstream request', async () => {
    const { client, connect, calls, tokens } = await setup();
    await connect();

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(echoText(await client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('hi');

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.authorization === 'Bearer token-1')).toBe(true);
    expect(tokens.getToken).toHaveBeenCalledWith({ interactive: true });
  });

  it('does not contact the server before the first downstream message', async () => {
    const { fake, calls, tokens } = await setup();
    await tick(50);

    expect(fake.requests).toBe(0);
    expect(calls).toEqual([]);
    expect(tokens.getToken).not.toHaveBeenCalled();
  });

  it('retries once with a new token when the server starts rejecting the current one', async () => {
    const tokens = fakeTokens();
    const { client, connect, calls, server } = await setup({ tokens });
    await connect();

    server.valid = 'token-2';
    tokens.onUnauthorized.mockImplementation(async () => {
      tokens.current = 'token-2';
      return tokens.current;
    });
    const before = calls.length;

    expect(echoText(await client.callTool({ name: 'echo', arguments: { text: 'again' } }))).toBe('again');
    expect(tokens.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(tokens.onUnauthorized).toHaveBeenCalledWith('token-1', { interactive: true });
    expect(calls.slice(before).map((c) => c.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('answers a request with -32001 when login is required, and tries again on the next one', async () => {
    const tokens = fakeTokens();
    const { client, connect } = await setup({ tokens });
    await connect();

    tokens.fail = new LoginRequiredError();
    await expect(client.callTool({ name: 'echo', arguments: { text: 'x' } })).rejects.toMatchObject({
      code: -32001,
      message: expect.stringContaining('auth login'),
    });

    tokens.fail = undefined;
    const before = tokens.getToken.mock.calls.length;
    expect(echoText(await client.callTool({ name: 'echo', arguments: { text: 'y' } }))).toBe('y');
    expect(tokens.getToken.mock.calls.length).toBeGreaterThan(before);
  });

  it('answers a request with -32603 and the error message for other upstream failures', async () => {
    const tokens = fakeTokens();
    const { client, connect, log } = await setup({ tokens });
    await connect();

    tokens.fail = new Error('Hydra is unreachable');
    await expect(client.callTool({ name: 'echo', arguments: { text: 'x' } })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining('Hydra is unreachable'),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Hydra is unreachable'));
  });

  it('holds messages while a token is pending and forwards them in order afterwards', async () => {
    const tokens = fakeTokens();
    const { client, connect } = await setup({ tokens });
    await connect();

    let release!: () => void;
    tokens.gate = new Promise<void>((resolve) => (release = resolve));
    const before = tokens.getToken.mock.calls.length;
    const order: string[] = [];
    const pending = ['a', 'b', 'c'].map((text) =>
      client.callTool({ name: 'echo', arguments: { text } }).then((r) => order.push(echoText(r))),
    );
    await tick(50);

    expect(order).toEqual([]);
    // Strict ordering: the second message is not sent before the first settled.
    expect(tokens.getToken.mock.calls.length - before).toBe(1);

    release();
    await Promise.all(pending);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('drops a notification that fails upstream without answering or crashing', async () => {
    const tokens = fakeTokens();
    const { client, connect, agentSide, log } = await setup({ tokens });
    await connect();

    const received: JSONRPCMessage[] = [];
    const original = agentSide.onmessage;
    agentSide.onmessage = (message, extra) => {
      received.push(message);
      original?.(message, extra);
    };

    tokens.fail = new Error('boom');
    await client.sendRootsListChanged();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('boom')));
    await tick(20);
    expect(received).toEqual([]);

    tokens.fail = undefined;
    expect(echoText(await client.callTool({ name: 'echo', arguments: { text: 'still here' } }))).toBe('still here');
  });

  it('sets the negotiated protocol version on the upstream transport after initialize', async () => {
    const spy = vi.spyOn(StreamableHTTPClientTransport.prototype, 'setProtocolVersion');
    const { client, connect, calls } = await setup();
    await connect();

    expect(spy).toHaveBeenCalledWith(LATEST_PROTOCOL_VERSION);
    const before = calls.length;
    await client.listTools();
    expect(calls.slice(before).map((c) => c.protocolVersion)).toEqual([LATEST_PROTOCOL_VERSION]);
  });

  it('close() closes both transports and resolves closed', async () => {
    const spy = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const { client, connect, relay } = await setup();
    await connect();
    const agentClosed = new Promise<void>((resolve) => (client.onclose = resolve));

    await relay.close();

    await expect(relay.closed).resolves.toBeUndefined();
    await agentClosed;
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('closes upstream and resolves closed when the agent disconnects', async () => {
    const spy = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const { client, connect, relay, log } = await setup();
    await connect();

    await client.close();

    await expect(relay.closed).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('closes once when the downstream calls onclose synchronously from close() (as stdio does)', async () => {
    let closes = 0;
    const downstream: Transport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => {
        closes += 1;
        if (closes > 50) throw new Error('close() recursed');
        downstream.onclose?.();
      },
    };
    const relay = await startRelay({ mcpUrl: 'http://127.0.0.1:9/mcp', tokens: fakeTokens(), downstream });

    await relay.close();

    await expect(relay.closed).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });
});

describe('authorizedFetch', () => {
  const URL_ = 'http://127.0.0.1:1/mcp';
  const respond = (status: number): Response => new Response(status === 200 ? '{}' : 'nope', { status });

  it('sets the Bearer header on a copy of the request headers', async () => {
    const tokens = fakeTokens('abc');
    const base = vi.fn<typeof fetch>(async () => respond(200));
    const headers = new Headers({ accept: 'application/json' });

    const response = await authorizedFetch(tokens, base)(URL_, { method: 'POST', headers, body: '{}' });

    expect(response.status).toBe(200);
    const sent = new Headers(base.mock.calls[0]?.[1]?.headers);
    expect(sent.get('authorization')).toBe('Bearer abc');
    expect(sent.get('accept')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(tokens.getToken).toHaveBeenCalledWith({ interactive: true });
  });

  it('retries once with the token from onUnauthorized after a 401', async () => {
    const tokens = fakeTokens('old');
    tokens.onUnauthorized.mockResolvedValue('new');
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(401)).mockResolvedValueOnce(respond(200));

    const response = await authorizedFetch(tokens, base)(URL_, { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(tokens.onUnauthorized).toHaveBeenCalledWith('old', { interactive: true });
    expect(base.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual([
      'Bearer old',
      'Bearer new',
    ]);
  });

  it('returns the second 401 without retrying again', async () => {
    const tokens = fakeTokens('old');
    tokens.onUnauthorized.mockResolvedValue('new');
    const base = vi.fn<typeof fetch>(async () => respond(401));

    const response = await authorizedFetch(tokens, base)(URL_, { method: 'POST', body: '{}' });

    expect(response.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(2);
    expect(tokens.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not retry a request whose body is a stream', async () => {
    const tokens = fakeTokens('old');
    const base = vi.fn<typeof fetch>(async () => respond(401));
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });

    const response = await authorizedFetch(tokens, base)(URL_, { method: 'POST', body, duplex: 'half' } as RequestInit);

    expect(response.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
    expect(tokens.onUnauthorized).not.toHaveBeenCalled();
  });

  it('propagates a getToken failure without calling fetch', async () => {
    const tokens = fakeTokens();
    tokens.fail = new LoginRequiredError();
    const base = vi.fn<typeof fetch>(async () => respond(200));

    await expect(authorizedFetch(tokens, base)(URL_, { method: 'GET' })).rejects.toBeInstanceOf(LoginRequiredError);
    expect(base).not.toHaveBeenCalled();
  });
});
