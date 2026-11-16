#!/usr/bin/env node
/**
 * Entry shim for the hydra-onix-mcp CLI.
 *
 * Node's `engines` field is advisory (npm only warns unless engine-strict is
 * set), so check the major version here. Without this, running on an old Node
 * fails deep inside an import with an error the user cannot act on.
 */
const major = Number.parseInt(process.versions.node.split('.')[0], 10);

if (major < 22) {
  process.stderr.write(
    '✖ hydra-onix-mcp requires Node.js 22 or newer.\n\n' +
      `You are running Node.js ${process.versions.node}.\n\n` +
      'Upgrade Node, for example:\n\n' +
      '  nvm install 22 && nvm use 22\n',
  );
  process.exit(1);
}

await import('../dist/cli/index.js');
