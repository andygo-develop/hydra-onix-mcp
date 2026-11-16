// Stand-in for a Chromium started with --remote-debugging-pipe, serving cookies
// from FAKE_CHROME_COOKIES (JSON) and exiting shortly after Browser.close.
// With FAKE_CHROME_MARKER set, writes its pid there once it is running.
import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';

if (process.env.FAKE_CHROME_MARKER) writeFileSync(process.env.FAKE_CHROME_MARKER, String(process.pid));

const input = new Socket({ fd: 3, readable: true, writable: false });
const output = new Socket({ fd: 4, readable: false, writable: true });
const cookies = JSON.parse(process.env.FAKE_CHROME_COOKIES ?? '[]');
let buffer = '';

input.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\0');
  while (index !== -1) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const send = (body) => output.write(`${JSON.stringify({ id: message.id, ...body })}\0`);
    if (message.method === 'Storage.getCookies') {
      send({ result: { cookies } });
    } else if (message.method === 'Browser.close') {
      send({ result: {} });
      setTimeout(() => process.exit(0), 20);
    } else {
      send({ error: { code: -32601, message: 'unknown method' } });
    }
    index = buffer.indexOf('\0');
  }
});
input.on('end', () => process.exit(0));
