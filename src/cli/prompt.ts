/**
 * Minimal interactive prompts.
 *
 * `confirm` defaults to "no" whenever the session is not interactive, so CI
 * runs never hang waiting for input. `askSecret` has no safe default, so it
 * refuses outright without a TTY.
 */
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { HarnessError } from '../errors.js';

export async function confirm(question: string, options: { assumeYes?: boolean } = {}): Promise<boolean> {
  if (options.assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Reads one line with echo muted. Rejects when stdin is not a terminal. */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new HarnessError('Manual login needs an interactive terminal.', {
      hint: 'Run this command in a terminal, or use the browser login without --manual.',
    });
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk);
      }
      callback();
    },
  });
  // terminal: true keeps stdin in raw mode, avoiding the ~1 KB canonical-mode
  // line limit that would truncate long pasted cookie values.
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const pending = rl.question(question);
    muted = true;
    return await pending;
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}
