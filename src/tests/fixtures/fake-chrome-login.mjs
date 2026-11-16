// Stand-in for a Chromium started with --remote-debugging-pipe, serving cookies
// from FAKE_CHROME_COOKIES (JSON) and exiting shortly after Browser.close.
// With FAKE_CHROME_MARKER set, appends its pid (one line per launch) there once
// it is running. With FAKE_CHROME_STUBBORN set, it outlives its pipe (and its
// parent) and only goes away when killed.
import { appendFileSync } from 'node:fs';
import { Socket } from 'node:net';

if (process.env.FAKE_CHROME_MARKER) appendFileSync(process.env.FAKE_CHROME_MARKER, `${process.pid}\n`);
const stubborn = Boolean(process.env.FAKE_CHROME_STUBBORN);
if (stubborn) setInterval(() => undefined, 1_000);

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
input.on('error', () => undefined);
output.on('error', () => undefined);
input.on('end', () => {
  if (!stubborn) process.exit(0);
});
