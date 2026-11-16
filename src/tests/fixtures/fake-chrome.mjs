// Minimal stand-in for a Chromium started with --remote-debugging-pipe.
import { Socket } from 'node:net';

const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });
let buffer = '';

input.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\0');
  while (index !== -1) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const send = (body) => output.write(`${JSON.stringify({ id: message.id, ...body })}\0`);
    if (message.method === 'Browser.getVersion') {
      send({ result: { product: 'FakeChrome/1' } });
    } else if (message.method === 'Browser.close') {
      output.write(`${JSON.stringify({ id: message.id, result: {} })}\0`);
      setTimeout(() => process.exit(0), 20);
    } else {
      send({ error: { code: -32601, message: 'unknown method' } });
    }
    index = buffer.indexOf('\0');
  }
});
input.on('end', () => process.exit(0));
