/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 * Messages are single JSON objects, each terminated by a `\0` byte.
 * Events (messages without an `id`) are ignored.
 */

export interface CdpConnection {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  readonly closed: Promise<void>;
  dispose(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

export function connectPipe(toBrowser: NodeJS.WritableStream, fromBrowser: NodeJS.ReadableStream): CdpConnection {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let isClosed = false;
  let buffer = '';
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const handleMessage = (raw: string): void => {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? 'DevTools error'));
    else entry.resolve(message.result);
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = buffer.indexOf('\0');
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (raw) handleMessage(raw);
      index = buffer.indexOf('\0');
    }
  };

  const onClose = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const entry of pending.values()) entry.reject(new Error('browser closed'));
    pending.clear();
    markClosed();
  };

  fromBrowser.on('data', onData);
  fromBrowser.on('end', onClose);
  fromBrowser.on('close', onClose);
  fromBrowser.on('error', onClose);
  // Writing to a dead pipe must not crash the process; `closed` reports it.
  toBrowser.on('error', onClose);

  return {
    send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (isClosed) return Promise.reject(new Error('browser closed'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        toBrowser.write(`${JSON.stringify({ id, method, params })}\0`);
      });
    },
    closed,
    dispose(): void {
      fromBrowser.off('data', onData);
      fromBrowser.off('end', onClose);
      fromBrowser.off('close', onClose);
      onClose();
    },
  };
}
