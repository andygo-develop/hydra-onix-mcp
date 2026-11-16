import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { connectPipe } from '../auth/browser/cdp-pipe.js';
import { fakeCdpPeer } from './helpers.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('connectPipe', () => {
  it('matches concurrent responses to their own requests when answered out of order', async () => {
    const peer = fakeCdpPeer(async (method) => {
      await delay(method === 'A.slow' ? 40 : 0);
      return { method };
    });
    const connection = connectPipe(peer.toBrowser, peer.fromBrowser);
    const [slow, fast] = await Promise.all([connection.send('A.slow'), connection.send('B.fast')]);
    expect(slow).toEqual({ method: 'A.slow' });
    expect(fast).toEqual({ method: 'B.fast' });
    peer.close();
  });

  it('parses a frame split across chunks and several frames in one chunk', async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = connectPipe(toBrowser, fromBrowser);
    const first = connection.send<string>('One');
    const second = connection.send<string>('Two');
    const frame1 = JSON.stringify({ id: 1, result: 'a' }) + '\0';
    const frame2 = JSON.stringify({ id: 2, result: 'b' }) + '\0';
    fromBrowser.write(frame1.slice(0, 5));
    await delay(5);
    fromBrowser.write(frame1.slice(5, 12));
    await delay(5);
    fromBrowser.write(frame1.slice(12));
    await expect(first).resolves.toBe('a');
    fromBrowser.write(frame2 + JSON.stringify({ method: 'Some.event', params: {} }) + '\0');
    await expect(second).resolves.toBe('b');
  });

  it('keeps multi-byte characters intact when split across chunks', async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = connectPipe(toBrowser, fromBrowser);
    const reply = connection.send<string>('Utf8');
    const bytes = Buffer.from(JSON.stringify({ id: 1, result: 'caf\u00e9 \u{1F600}' }) + '\0', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1;
    fromBrowser.write(bytes.subarray(0, cut));
    await delay(5);
    fromBrowser.write(bytes.subarray(cut));
    await expect(reply).resolves.toBe('caf\u00e9 \u{1F600}');
  });

  it('closes and rejects pending sends on a malformed frame', async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = connectPipe(toBrowser, fromBrowser);
    const pending = connection.send('Bad.reply');
    fromBrowser.write('not json\0');
    await expect(pending).rejects.toThrow('invalid frame');
    await expect(connection.closed).resolves.toBeUndefined();
  });

  it('rejects with the error message of an error response', async () => {
    const peer = fakeCdpPeer(() => {
      throw new Error('nope');
    });
    const connection = connectPipe(peer.toBrowser, peer.fromBrowser);
    await expect(connection.send('X.y')).rejects.toThrow('nope');
    peer.close();
  });

  it('rejects pending sends and resolves closed when the peer goes away', async () => {
    const peer = fakeCdpPeer(() => new Promise(() => undefined));
    const connection = connectPipe(peer.toBrowser, peer.fromBrowser);
    const pending = connection.send('Never.answers');
    peer.close();
    await expect(pending).rejects.toThrow('browser closed');
    await expect(connection.closed).resolves.toBeUndefined();
    await expect(connection.send('After.close')).rejects.toThrow('browser closed');
  });

  it('talks to a real child process over fds 3 and 4', async () => {
    const child = spawn(process.execPath, ['src/tests/fixtures/fake-chrome.mjs'], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const connection = connectPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    await expect(connection.send('Browser.getVersion')).resolves.toEqual({ product: 'FakeChrome/1' });
    await expect(connection.send('Nope.nothing')).rejects.toThrow('unknown method');
    await connection.send('Browser.close');
    await expect(exited).resolves.toBe(0);
    await connection.closed;
    connection.dispose();
  });
});
