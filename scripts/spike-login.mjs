#!/usr/bin/env node
/**
 * Production login spike (plan Task 6). Not published.
 *
 * Opens a dedicated browser profile in a temp directory, lets the owner sign
 * in to Hydra, and prints only metadata: cookie names and expiries, session
 * and token expiry, whether the token is a JWT, the signed-in email, and the
 * HTTP status the MCP server returns for an `initialize` with that token.
 * No cookie value or token is ever printed. The temp profile is deleted.
 *
 * Run after `npm run build`:  node scripts/spike-login.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { browserLogin } = await import('../dist/auth/browser/login.js');
const { appUrl, mcpUrl } = await import('../dist/constants.js');

const profileDir = await mkdtemp(path.join(os.tmpdir(), 'hydra-spike-profile-'));

try {
  const result = await browserLogin({
    appUrl: appUrl(),
    profileDir,
    interactive: true,
    silentTimeoutMs: 5_000,
    log: (m) => console.error(m),
  });

  const isJwt = result.accessToken.split('.').length === 3;
  console.log('cookies:');
  for (const c of result.cookies) console.log(`  ${c.name}  expires=${c.expires ?? '(session)'}`);
  console.log(`sessionExpires:     ${result.sessionExpires ?? '(none)'}`);
  console.log(`accessTokenExpires: ${result.accessTokenExpires}`);
  console.log(`token is JWT:       ${isJwt}  length=${result.accessToken.length}`);
  console.log(`user.email:         ${result.user?.email ?? '(none)'}`);

  const res = await fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${result.accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hydra-onix-mcp-spike', version: '0' } },
    }),
    redirect: 'manual',
  });
  console.log(`MCP initialize:     HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`);
  const session = res.headers.get('mcp-session-id');
  if (session) {
    await fetch(mcpUrl(), { method: 'DELETE', headers: { authorization: `Bearer ${result.accessToken}`, 'mcp-session-id': session } }).catch(() => undefined);
  }
} catch (error) {
  console.error(`spike failed: ${error?.name}: ${error?.message}`);
  if (error?.hint) console.error(error.hint);
  process.exitCode = 1;
} finally {
  await rm(profileDir, { recursive: true, force: true });
}
