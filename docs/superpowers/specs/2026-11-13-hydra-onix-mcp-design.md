# hydra-onix-mcp: design

Date: 2026-11-13, revised 2026-11-16
Status: draft, awaiting approval

Revision history:
1. Per-project registration, OAuth with dynamic client registration.
2. Per-user install and registration; credentials in a plain JSON file
   (Google Drive MCP style).
3. Login through the Hydra web app session (next-auth cookies), captured
   from a dedicated Chrome window. OAuth/DCR removed. Windows supported.

## Intent

Onix's Hydra Projects exposes an MCP server at
`https://api.projects.onix.hydra-systems.net/mcp` (worklogs, timesheet
reports, project/ticket/user search). It accepts a Bearer access token. The
owner states that the only supported way to obtain one is the Hydra web
app's session, as in a workaround script shared internally (2026-07-03):

1. sign in to `https://projects.onix.hydra-systems.net` (next-auth; the only
   provider is `hydra_passport`);
2. take the session cookies `__Secure-next-auth.session-token.0` and `.1`;
3. `GET https://projects.onix.hydra-systems.net/api/auth/session` with them;
   the JSON response's `accessToken` is the Bearer token;
4. repeat step 3 before the token expires (the script runs every 30 minutes,
   which works all day).

Today people do this by hand: copy the cookies out of DevTools, run the
script from cron, and let it rewrite `~/.cursor/mcp.json`.

`@andygo.dev/hydra-onix-mcp` automates it for any coding agent: a local
stdio MCP server that relays everything to the Hydra MCP server, opens a
dedicated Chrome window for the user to sign in, captures the session
cookies itself, keeps the access token fresh, and attaches it to every
request.

Hydra access is personal, so everything is **per user**: the server is
registered once in each coding agent's user-level configuration and is then
available in every project on the machine.

## Goals

- `npx @andygo.dev/hydra-onix-mcp setup` (once per machine, from any
  directory): detects the coding agents installed for this user, registers
  the `hydra-onix` MCP server in each agent's **user-level** config, and runs
  the browser login.
- After that, every agent session in every project launches
  `npx -y @andygo.dev/hydra-onix-mcp mcp start` and every Hydra tool works
  with no cookie or token handling by the user, for as long as the web
  session can be kept alive.
- When the web session has expired, the next login is silent if the Passport
  session in the dedicated browser profile is still valid, and otherwise
  opens the Chrome window ("request creds via browser").
- Supported agents: Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI,
  OpenCode, with the same config dialects as `docs-harness`.
- Supported platforms: macOS, Linux, Windows.
- `doctor` explains what is wrong and how to fix it.

## Non-goals

- No Hydra-specific tools of our own. The proxy is transparent: tools,
  resources and prompts are whatever the Hydra server exposes.
- No OAuth, no dynamic client registration, no `localhost` callback. The
  server's advertised OAuth metadata is not used (owner's decision).
- No per-project registration and no project config.
- No OS keychain. Credentials are a plain JSON file, as the Google Drive MCP
  servers do.
- No reading cookies from the user's everyday browser profile (it means
  decrypting the browser's cookie store, prompts for the Keychain, and
  behaves like credential-stealing software).
- No bundled browser (no Playwright/Puppeteer download). An installed
  Chromium-family browser is used.
- No GUI, no daemon, no background refresh process.

## Anti-goals (would make it a failure even if it works)

- Writing a cookie, token or anything credential-like into an agent config
  file. Credentials live only in the credentials file and the dedicated
  browser profile.
- Writing anything other than JSON-RPC to stdout while `mcp start` runs.
- Rewriting or reformatting a user's agent config file, or touching another
  server's entry in it.
- Logging cookies or tokens, even with `--verbose`.
- Leaving a remote-debugging port open on the machine.
- Losing the login when the npx cache or a `node_modules` folder is cleared.

## Constraints

- Node.js `>=22` (`.nvmrc` `v22.15.0`). The bin shim does a plain
  major-version check.
- ESM, TypeScript `~6.0.3` (owner's choice; `typescript-eslint` 8.x supports
  `<6.1.0`), `module: node16`, strict, `"types": ["node"]` (TypeScript 6 no
  longer loads `@types/node` implicitly). ESLint flat config and Vitest as in
  `docs-harness`.
- Already in place: `package.json`, `package-lock.json`, `tsconfig.json`,
  `eslint.config.mjs`, `vitest.config.ts`, `.nvmrc`, `.gitignore`,
  `.claude/skills/{release,sync-pr}`, `.agents/skills/release`.
  `src/index.ts` is a placeholder to replace.
- Dependencies: `@modelcontextprotocol/sdk` `^1.32.1` (installed 1.32.2),
  `commander`, `zod`. Nothing else at runtime: Chrome is driven with the
  DevTools protocol over a pipe using only `child_process`.
- Tests are offline: no request may leave the machine, no real browser is
  launched, and the real home directory is never read or written. Loopback
  servers started by the test itself are allowed and expected.

## Approaches considered

Relay: thin preset over `mcp-remote` (no control, OAuth only); each agent's
native remote-MCP OAuth (`/mcp` Authenticate in Claude Code; OAuth only);
**custom relay on the MCP SDK (chosen)**, since the login is not OAuth and
the owner wants the project shaped like `docs-harness`.

Getting the cookies out of the browser:

- **A. Dedicated Chrome window driven by the package (chosen by the owner).**
  Own profile, user signs in there, the package reads the cookies through the
  DevTools protocol and closes the window. No dependency; the profile stays
  signed in to Passport, so later logins can be silent.
- **B. Copy and paste from DevTools.** Works everywhere, clumsy. Kept as the
  fallback (`auth login --manual`) for machines without a Chromium-family
  browser (builder's call: the owner chose A, and B costs one prompt).
- **C. Read the everyday browser profile's cookie store.** Rejected (see
  non-goals).

Credential storage: OS keychain, OS CLI tools and a plain JSON file were
considered; **plain JSON file chosen by the owner**.

## Decided by the owner

- Wrap the Hydra MCP server as an npm package that logs in via the browser.
- Project structure modelled on `/Users/andy/projects/@andygo-dev/docs-harness`.
- Per-user install and registration.
- Secrets in a plain JSON file, like the Google Drive MCP servers, with an
  environment variable to move it.
- Login only through the web app session, as in that workaround script.
- Cookies captured with a dedicated Chrome window (approach A).

## Design

### Package

- Name `@andygo.dev/hydra-onix-mcp`, bin `hydra-onix-mcp`
  → `bin/hydra-onix-mcp.js` → `dist/cli/index.js`.
- Agents launch it through `npx -y @andygo.dev/hydra-onix-mcp mcp start`, not
  a global binary: a global install is tied to one Node version under nvm and
  disappears on a version switch, while `npx` always resolves.
- `CLAUDE.md`, `README.md` modelled on `docs-harness`, with docs-harness
  specifics (sqlite, indexing, hybrid search, project detection) removed.

### Layout

```
bin/hydra-onix-mcp.js            node version check, then import dist/cli/index.js
src/index.ts                     programmatic exports
src/errors.ts                    HarnessError + hint helpers (as docs-harness)
src/logger.ts                    as docs-harness (useStderr for mcp start)
src/package-version.ts           as docs-harness
src/constants.ts                 URLs, cookie prefix, server name, timings
src/paths.ts                     home, config dir, credentials path, profile dir
src/cli/index.ts                 commander program
src/cli/prompt.ts                yes/no + hidden input prompts
src/cli/commands/setup.ts
src/cli/commands/doctor.ts
src/cli/commands/auth/{login,logout,status}.ts
src/cli/commands/mcp/{start,status}.ts
src/cli/commands/targets/{list,add,remove,install}.ts
src/config/{schema,config}.ts    user config (~/.hydra-onix-mcp/config.json)
src/auth/store.ts                credentials file + cross-process lock
src/auth/session.ts              cookies -> /api/auth/session -> accessToken; cookie rotation
src/auth/token-manager.ts        current token, expiry, refresh, login escalation
src/auth/browser/find.ts         locate Chrome / Chromium / Edge / Brave per OS
src/auth/browser/cdp-pipe.ts     DevTools protocol client over --remote-debugging-pipe
src/auth/browser/login.ts        capture session cookies from the dedicated window
src/auth/manual-login.ts         fallback B: paste cookies
src/proxy/relay.ts               stdio <-> Streamable HTTP relay with Bearer injection
src/generators/mcp-entry.ts      launch command (npx -y <pkg> mcp start)
src/generators/targets/{types,registry,mcp,install}.ts   ported from docs-harness
src/tests/...                    Vitest
```

### Constants and paths

- `HYDRA_MCP_URL = 'https://api.projects.onix.hydra-systems.net/mcp'`,
  env override `HYDRA_ONIX_MCP_URL`.
- `HYDRA_APP_URL = 'https://projects.onix.hydra-systems.net'`, env override
  `HYDRA_ONIX_MCP_APP_URL`. Session endpoint `<app>/api/auth/session`; the
  login window opens `<app>/` (the app redirects to its sign-in).
- `SESSION_COOKIE_PREFIX = '__Secure-next-auth.session-token'`. next-auth
  splits a large session into chunks `.0`, `.1`, ... and uses the bare name
  when it fits in one cookie; all matching cookies are captured and sent.
- `SERVER_NAME = 'hydra-onix'`, the key written into agent configs.
- `TOKEN_REFRESH_MARGIN = 60 s`, `FALLBACK_TOKEN_TTL = 25 min` (used when the
  access token's lifetime cannot be read), `LOGIN_TIMEOUT = 5 min`,
  `SILENT_LOGIN_TIMEOUT = 20 s`.
- Home: `os.homedir()`, env override `HYDRA_ONIX_MCP_HOME` (tests; it also
  relocates the agent config paths, so tests never touch the real `~`).
- Config dir `<home>/.hydra-onix-mcp/`; credentials file
  `<home>/.hydra-onix-mcp/credentials.json` (env override
  `HYDRA_ONIX_MCP_CREDENTIALS_PATH`, the `GDRIVE_CREDENTIALS_PATH`
  equivalent); browser profile `<home>/.hydra-onix-mcp/browser-profile/`.
- Browser binary: env override `HYDRA_ONIX_MCP_BROWSER`.

### User config

`~/.hydra-onix-mcp/config.json`:

```json
{ "version": 1, "targets": ["claude-code", "cursor"] }
```

Records which agents the user set up. No credentials.

### Credentials file (Google Drive MCP style)

One plain JSON file, keyed by app URL so a staging override does not
overwrite the production login:

```json
{
  "https://projects.onix.hydra-systems.net": {
    "cookies": [
      { "name": "__Secure-next-auth.session-token.0", "value": "...", "expires": "2026-12-16T10:00:00.000Z" },
      { "name": "__Secure-next-auth.session-token.1", "value": "...", "expires": "2026-12-16T10:00:00.000Z" }
    ],
    "sessionExpires": "2026-12-16T10:00:00.000Z",
    "accessToken": "...",
    "accessTokenExpires": "2026-11-16T10:30:00.000Z",
    "user": { "name": "...", "email": "..." },
    "updatedAt": "2026-11-16T10:00:00.000Z"
  }
}
```

Differences from the Google Drive servers, all deliberate: default location
under `~/.hydra-onix-mcp/` rather than next to `node_modules` (so clearing
the npx cache does not log out); directory `0700`, file `0600` on POSIX
(skipped on Windows, where the user profile's ACLs apply); atomic writes
(temp file + rename). The session cookies are a full Hydra web login, which
the README states plainly.

**Concurrent processes.** Several `mcp start` processes (Claude Code +
Cursor, several sessions) share the file. A cross-process lock
(`credentials.json.lock`, `O_EXCL` create, stale after 60 s) is held around
every session refresh, cookie update and login. Each refresh re-reads the
file under the lock first and reuses a token another process saved if it is
still fresh. A process that needs a login while another is logging in waits
on the lock and then reuses the result; this also keeps two processes from
launching Chrome on the same profile.

### Session refresh (`src/auth/session.ts`)

`refreshSession(cookies)`:

- `GET <app>/api/auth/session` with `Cookie: <all captured cookies>`,
  `redirect: 'manual'`.
- Response JSON with a non-empty `accessToken`: success. Read `expires`
  (session expiry) and `user` if present.
- Apply every `Set-Cookie` from the response (`headers.getSetCookie()`):
  next-auth slides the session and may re-chunk it. Matching cookies are
  replaced, new chunks added, and cookies cleared with `Max-Age=0` or a past
  `Expires` removed. The updated set is saved.
- `{}`, no `accessToken`, 401/403 or a redirect: the web session is gone
  (`SessionExpired`).
- Access-token expiry: if the token is a JWT, its `exp` claim; otherwise
  `now + FALLBACK_TOKEN_TTL`. Never derived from the session `expires`.

### Token manager (`src/auth/token-manager.ts`)

`getToken({ interactive })` returns a valid access token:

1. Stored token valid for longer than `TOKEN_REFRESH_MARGIN`: return it.
2. Else, under the lock, `refreshSession`; save; return the new token.
3. On `SessionExpired`: run the browser login (silent first, then visible if
   `interactive`), then step 2.

`onUnauthorized()`: a 401 from the MCP server forces step 2 even if the
stored token looks valid, once per request.

### Browser login (`src/auth/browser/*`)

**Finding a browser** (`find.ts`), in order: `HYDRA_ONIX_MCP_BROWSER`;
Google Chrome, Chromium, Microsoft Edge, Brave at their standard install
paths (macOS `/Applications/<App>.app/Contents/MacOS/<binary>`; Windows
`%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LocalAppData%`; Linux
`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`,
`microsoft-edge`, `brave-browser` on `PATH`). None found: `HarnessError`
whose hint names `auth login --manual` and `HYDRA_ONIX_MCP_BROWSER`.

**Launching** with `child_process.spawn` and
`--user-data-dir=<profile> --remote-debugging-pipe --no-first-run
--no-default-browser-check --new-window <app>/`, stdio
`['ignore', 'ignore', 'pipe', 'pipe', 'pipe']`. The DevTools protocol runs
over fds 3 (to the browser) and 4 (from the browser) as NUL-delimited JSON,
so no debugging port is ever opened. No `--enable-automation` flag, so the
window is an ordinary browser window for the sign-in pages. A dedicated
profile is required anyway: recent Chrome refuses remote debugging on the
default profile.

**Capturing** (`login.ts`): every second, `Storage.getCookies` (browser
target); filter cookies whose domain matches the app host and whose name
starts with `SESSION_COOKIE_PREFIX`. When some exist, call `refreshSession`
with them; when it returns an access token, save, send `Browser.close`, and
resolve. Closing the window early (pipe closes) rejects with "login
cancelled". Timeout rejects with a hint to rerun.

**Silent first.** Before showing a window, the same capture runs with
`--headless=new` for up to `SILENT_LOGIN_TIMEOUT`. If the Passport session in
the profile is still valid, the app signs in by redirect with no user action.
Only if that fails, and `interactive` is set, the visible window opens.

Messages go to stderr: "Opening Chrome to sign in to Hydra..." with the
profile path, and "Signed in as <name>" when the session carries a user.

### Manual fallback (`src/auth/manual-login.ts`)

`auth login --manual`, also offered by `auth login` when no browser is found
and stdin is a TTY: opens `<app>/` in the default browser (`open`,
`xdg-open`, `start`), explains where the cookies are in DevTools
(Application → Cookies), and asks with hidden input for either the full
`Cookie` request header copied from the Network tab or each session-token
chunk value. Validates with `refreshSession` and saves. Not available inside
`mcp start` (its stdin is the MCP channel).

### Relay (`src/proxy/relay.ts`)

Transport-level relay, so every method, notification and capability passes
through unchanged.

- Downstream: SDK `StdioServerTransport`.
- Upstream: SDK `StreamableHTTPClientTransport(new URL(HYDRA_MCP_URL),
  { fetch })`, where `fetch` is a wrapper that sets
  `Authorization: Bearer <tokenManager.getToken({ interactive: true })>` on
  every request, and on a 401 calls `onUnauthorized()` and retries the
  request once with the new token. No `authProvider` (no OAuth).
- Upstream connects lazily, on the first downstream message, so `mcp start`
  answers instantly.
- Downstream messages are forwarded strictly in order. While a login is
  running they wait (single-flight: one login for all of them).
- If the login fails, is cancelled or times out, each waiting request gets a
  JSON-RPC error (`code: -32001`, "Hydra login required: run `npx
  @andygo.dev/hydra-onix-mcp auth login`"); the next request tries again.
- After relaying `initialize`, call `setProtocolVersion` on the upstream
  transport with the negotiated version.
- Other upstream errors are logged to stderr and returned as JSON-RPC errors
  for the request that triggered them.
- Shutdown on stdin close / SIGINT / SIGTERM: close upstream and exit.

Known limit, in the README: an agent may time out the very first
`initialize` while the user is signing in. `setup` logs in up front, so in
practice `mcp start` only needs a visible window after both the web session
and the Passport session have expired; reconnecting the server in the agent
afterwards (e.g. `/mcp` in Claude Code) works because the cookies are now
stored.

### Agent registration (per user)

Ported from `docs-harness/src/generators/targets/`, with user-level paths:

| Target | User config file | Dialect | Detected by |
|---|---|---|---|
| claude-code | `~/.claude.json` (top-level `mcpServers`) | `mcpServers` | `~/.claude/` or `~/.claude.json` |
| cursor | `~/.cursor/mcp.json` | `mcpServers` | `~/.cursor/` |
| codex | `~/.codex/config.toml` | `codex-toml` (append-only) | `~/.codex/` |
| gemini | `~/.gemini/settings.json` | `mcpServers` | `~/.gemini/` |
| opencode | `~/.config/opencode/opencode.json` | `opencode` | `~/.config/opencode/` |

Claude Code rewrites `~/.claude.json` while it runs, so prefer `claude mcp
add-json --scope user hydra-onix '<entry>'` when the `claude` CLI is on
`PATH`, and fall back to the merge-and-atomic-rename write only when it is
not (saying so in the output).

Entry: `{ "command": "npx", "args": ["-y", "@andygo.dev/hydra-onix-mcp",
"mcp", "start"] }`; on Windows `{ "command": "cmd", "args": ["/c", "npx",
"-y", ...] }`; OpenCode `{ type: "local", command: [...], enabled: true }`.
Same policy as `docs-harness`: merge, never touch other servers, leave an
existing `hydra-onix` entry alone even if it differs (for example the
owner's current `"type": "http"` + `oauth` entry, or a cron-maintained
`headers.Authorization` entry); `targets list`, `mcp status` and `doctor`
report it as "registered, not ours" with a hint showing the entry to put in
its place.

### CLI commands

| Command | Does |
|---|---|
| `setup [-y] [--no-mcp] [--no-login] [--target ...]` | Detect agents → write config → register with each agent (asks per agent unless `-y`) → `auth login` if there is no working session. Idempotent. |
| `auth login [--manual] [--force]` | Browser login (silent, then visible window), or the paste fallback. `--force` discards the stored session first. |
| `auth logout [--keep-profile]` | Removes this app's entry from the credentials file and deletes the dedicated browser profile (otherwise the next login would silently sign the same user back in). |
| `auth status [--json]` | Signed in as whom, credentials path, session expiry, access-token expiry, browser found. Never prints cookies or tokens. |
| `mcp start` | The relay. Launched by agents. |
| `mcp status [--json]` | Registration per configured agent + login state. |
| `targets list/add/remove/install` | As `docs-harness`, against the user-level files. |
| `doctor [--json] [--online]` | Node version, config valid, registration per target, browser found, credentials file present (and `0600` on POSIX), session not expired. `--online`: refresh the session, then `initialize` + `tools/list` through the real server, reporting the tool count. Keeps a `DOCTOR_COMMANDS` catalog like `docs-harness`. |

Global flags as `docs-harness`: `--verbose`, `-V/--version`. Errors through
`HarnessError` with hints, printed without stack traces.

### Testing (offline)

Every test sets `HYDRA_ONIX_MCP_HOME` to a temp dir and the URL overrides to
loopback fakes:

- a fake Hydra app: `/api/auth/session` that accepts known cookie chunks,
  returns `accessToken` (JWT with `exp`, or opaque), rotates and re-chunks
  cookies via `Set-Cookie`, and can be switched to "session expired";
- a fake MCP server (SDK `McpServer` + `StreamableHTTPServerTransport`) that
  requires a currently valid Bearer token and exposes one echo tool;
- a fake browser: the browser launcher is injected; the fake speaks the same
  NUL-delimited DevTools protocol over a pipe pair, answers
  `Storage.getCookies` with cookies after N polls (or never), and records
  `Browser.close`. One test spawns a tiny Node script as the "browser" with
  real fds 3/4 to cover `cdp-pipe.ts` end to end.

Covered: store (atomic write, `0600`, keyed by URL, env override, lock);
session (chunked and unchunked cookies, `Set-Cookie` rotation and removal,
expired session, JWT and opaque expiry); token manager (fresh token reused,
refresh near expiry, 401 forces refresh, two processes refreshing at once);
browser login (silent success, silent failure then visible, user closes the
window, timeout, no browser found); manual login parsing; relay (round
trip, 401 mid-session retried once, requests during login complete in
order, failed login returns JSON-RPC errors); targets (five dialects at user
paths, Windows entry, merge policy, foreign entry left alone, `claude` CLI vs
file fallback); CLI (`setup -y --no-login`, `auth status --json`,
`doctor --json`).

### Risks to verify first

Not yet verified:

- that Passport's sign-in pages (and any SSO they hand off to) work in a
  browser started with `--remote-debugging-pipe` and a fresh profile;
- that `Storage.getCookies` returns the `HttpOnly`, `__Secure-` session
  cookies (expected, since the protocol sees all cookies);
- the real `accessToken` format and lifetime, and how long the next-auth
  session and the Passport session last (this decides how often a visible
  window appears).

**Verified 2026-11-16 (spike, `scripts/spike-login.mjs`):** sign-in through
Passport works in a Chrome window started with `--remote-debugging-pipe` and a
fresh profile; `Storage.getCookies` returns the two `HttpOnly` chunks
`__Secure-next-auth.session-token.0`/`.1`; the session lasts 7 days (cookie
and `expires` agree); the `accessToken` is a JWT (~800 chars) with a 1-hour
`exp`; the Hydra MCP server answers `initialize` with HTTP 200 for that
token. Not yet observed: how long the Passport session in the profile lasts
(decides whether the 7-day re-login is silent).

The first implementation step is a spike: `find.ts` + `cdp-pipe.ts` +
`login.ts` + `session.ts` run once against production with the owner
signing in, printing only cookie names, expiries and the token's expiry. If
the sign-in fails in the controlled window, stop and report before building
the rest; the manual fallback then becomes the main path.

## Left to the builder

- Exact wording of messages, hints and prompts.
- Internal helper names and how the ported `docs-harness` modules are split.
- Polling interval and the exact silent-login heuristics, within the limits
  above.
- Test file organisation.
