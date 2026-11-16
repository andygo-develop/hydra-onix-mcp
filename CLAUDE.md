# CLAUDE.md

Guidance for Claude Code and other AI agents working in this repository.

## Project Overview

`@andygo.dev/hydra-onix-mcp` is a per-user Node.js/TypeScript CLI and stdio MCP
proxy for Hydra. Coding agents launch `hydra-onix-mcp mcp start`, which relays
stdio JSON-RPC to the Hydra Projects MCP server over Streamable HTTP, injecting
a Bearer access token.

The user logs in once through a dedicated Chrome window (driven over the
DevTools protocol on a pipe, no extra dependencies). The next-auth session
cookies are stored in `~/.hydra-onix-mcp/credentials.json`, and short-lived
access tokens are refreshed silently from them.

Supported coding agents ("targets"): Claude Code, Cursor, OpenAI Codex CLI,
Gemini CLI and OpenCode. For each one the tool only registers the MCP server
(name `hydra-onix`) in the user-level configuration.

## Runtime and Tooling

- Node.js: `>=22` (`.nvmrc` is `v22.15.0`). The bin shim does a plain
  major-version check.
- Package manager: npm, with `package-lock.json` committed.
- Module system: ESM (`"type": "module"`) with TypeScript `module: "node16"`.
- Tests: Vitest, fully offline by design.
- Linting: ESLint flat config with `typescript-eslint`.
- Runtime dependencies are exactly `@modelcontextprotocol/sdk`, `commander` and
  `zod`. No Playwright/Puppeteer, no `open` package, no keychain library.

## Common Commands

Run these from the repository root:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Useful development commands:

```bash
npm run test:watch
npm run lint:fix
node ./bin/hydra-onix-mcp.js --help
node ./bin/hydra-onix-mcp.js doctor --help
```

CLI commands: `setup`, `auth login|logout|status`, `mcp start|status`,
`targets list|add|remove|install`, `doctor`.

`hydra-onix-mcp doctor` is both the setup health check and the command
discovery entrypoint. Keep its command catalog (`DOCTOR_COMMANDS`) current
whenever adding, removing, or renaming CLI commands.

## Environment overrides

All optional. Functions take `env` explicitly; tests pass their own object.

- `HYDRA_ONIX_MCP_HOME` - replaces the home directory (state under
  `<home>/.hydra-onix-mcp/`, agent config paths). Tests always set it.
- `HYDRA_ONIX_MCP_CREDENTIALS_PATH` - relocates only the credentials file.
- `HYDRA_ONIX_MCP_URL` - Hydra MCP endpoint (default in `src/constants.ts`).
- `HYDRA_ONIX_MCP_APP_URL` - Hydra web app URL used for login and session.
- `HYDRA_ONIX_MCP_BROWSER` - path to the Chromium-family browser binary.

## Platform and protocol contracts

- Windows is supported: the registered entry is `cmd /c npx -y
  @andygo.dev/hydra-onix-mcp mcp start` (OpenCode takes the same line as one
  array); POSIX file modes are skipped there.
- Login-required contract: when no valid session exists and login fails, is
  cancelled or times out, `mcp start` answers each waiting request with a
  JSON-RPC error `code: -32001` (`LOGIN_REQUIRED_CODE`) and the message "Hydra
  login required: run `npx @andygo.dev/hydra-onix-mcp auth login`". The next
  request tries again. Never change this code without updating the README.

## Repository Layout

- `bin/hydra-onix-mcp.js` - executable CLI entrypoint: Node version check, then
  imports `dist/cli/index.js`.
- `src/index.ts` - programmatic exports.
- `src/errors.ts` - `HarnessError` plus hint helpers.
- `src/logger.ts` - logger (`useStderr` for `mcp start`).
- `src/package-version.ts` - package version lookup.
- `src/constants.ts` - URLs, cookie prefix, server name, timings.
- `src/paths.ts` - home, config dir, credentials path, browser profile dir.
- `src/cli/` - command registration and command implementations:
  - `index.ts` - entry point: runs `main` from `program.ts`.
  - `program.ts` - the commander program (`createProgram`), `reportError` and `main`.
  - `prompt.ts` - yes/no and hidden-input prompts.
  - `commands/setup.ts`, `commands/doctor.ts`.
  - `commands/auth/{login,logout,status}.ts`.
  - `commands/mcp/{start,status}.ts`.
  - `commands/targets/{list,add,remove,install}.ts`.
- `src/config/{schema,config}.ts` - user config (`~/.hydra-onix-mcp/config.json`).
- `src/auth/store.ts` - credentials file and cross-process lock.
- `src/auth/session.ts` - cookies -> `/api/auth/session` -> `accessToken`;
  cookie rotation.
- `src/auth/token-manager.ts` - current token, expiry, refresh, login
  escalation.
- `src/auth/browser/find.ts` - locate Chrome / Chromium / Edge / Brave per OS.
- `src/auth/browser/cdp-pipe.ts` - DevTools protocol client over
  `--remote-debugging-pipe`.
- `src/auth/browser/login.ts` - capture session cookies from the dedicated
  window.
- `src/auth/manual-login.ts` - fallback: paste cookies.
- `src/proxy/relay.ts` - stdio <-> Streamable HTTP relay with Bearer injection.
- `src/generators/mcp-entry.ts` - the one description of the
  `npx -y @andygo.dev/hydra-onix-mcp mcp start` launch command.
- `src/generators/targets/{types,registry,mcp,install}.ts` - the registry of
  coding agents and the MCP registration writer for each agent's dialect
  (ported from docs-harness, with user-level paths).
- `src/tests/` - Vitest test suite.
- `dist/` - generated build output. Do not edit by hand.

## Development Guidelines

- Prefer changing TypeScript sources in `src/`; regenerate `dist/` with
  `npm run build` when build artifacts need to be updated.
- Keep CLI commands idempotent. Existing commands are designed to be safe to run
  repeatedly.
- Follow the existing error style: throw `HarnessError` with an actionable hint,
  printed without stack traces.
- Never log cookies or tokens, even with `--verbose`.
- Never write anything but JSON-RPC to stdout during `mcp start`. Call
  `logger.useStderr()` first.
- Never write a cookie, token or anything credential-like into an agent config
  file. Credentials live only in the credentials file and the dedicated browser
  profile.
- Never open a remote-debugging port: pipe only. Never read the user's everyday
  browser profile.
- The credentials file is plain JSON keyed by app URL, written atomically (temp
  file + rename), dir `0700` and file `0600` on POSIX.
- Do not lose the login when the npx cache or a `node_modules` folder is
  cleared: state lives under `~/.hydra-onix-mcp/`.
- Agent configuration files (`~/.claude.json`, `~/.cursor/mcp.json`,
  `~/.codex/config.toml`, `~/.gemini/settings.json`, opencode config) belong
  to the user. Merge into them, never rewrite or reformat them wholesale, never
  touch another server's entry, and leave an existing `hydra-onix` entry alone
  even if it differs; report it as "registered, not ours" with a hint.
- Claude Code rewrites `~/.claude.json` while running, so prefer
  `claude mcp add-json --scope user` when the `claude` CLI is on `PATH`, and
  fall back to the merge-and-atomic-rename write only when it is not.
- Adding a coding agent means adding a `TargetDefinition` in
  `src/generators/targets/registry.ts` and teaching `targets/mcp.ts` its
  dialect if it is a new one.
- Keep tests offline: no request may leave the machine, no real browser is
  launched, and the real home directory is never read or written. Loopback
  servers started by the test itself are fine.
- Every test sets `HYDRA_ONIX_MCP_HOME` to a temp dir (use `makeTempHome()`
  from `src/tests/helpers.ts`) and points the URL overrides at loopback fakes.
- Tests never invoke the real `claude` CLI. `defaultClaudeCli().available()` is
  false whenever `HYDRA_ONIX_MCP_HOME` is set.

## Testing Expectations

For behavior changes, run the narrowest relevant Vitest tests first, then run
the full verification set when practical:

```bash
npm test
npm run typecheck
npm run lint
```

Add or update tests in `src/tests/` for changes that affect:

- CLI command behavior or output
- credentials store, session refresh, token manager
- browser login and the DevTools pipe client
- relay behavior (round trip, 401 retry, login-required errors)
- per-target MCP registration dialects
- config defaults, validation, or migration behavior

## Release Notes

The npm release script only runs from a clean, up-to-date `main` branch and then
publishes with public access. Do not run `npm run release` unless explicitly
asked.
