# hydra-onix-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-user npm CLI + stdio MCP proxy that logs in to Hydra through a dedicated Chrome window, keeps the next-auth session's `accessToken` fresh, and relays every MCP message to `https://api.projects.onix.hydra-systems.net/mcp` with a Bearer token.

**Architecture:** `mcp start` relays JSON-RPC between the SDK's `StdioServerTransport` and `StreamableHTTPClientTransport`, whose `fetch` is wrapped to inject the token. A `TokenManager` gets the token from `credentials.json`, refreshes it via `GET <app>/api/auth/session` with the stored session cookies, and when the session is gone runs a browser login that drives Chrome over `--remote-debugging-pipe` and reads the cookies with `Storage.getCookies`. CLI shape, errors, logger and agent registration are ported from `docs-harness`, with user-level config paths.

**Tech Stack:** Node ≥22, TypeScript ~6.0.3 (ESM, `module: node16`), `@modelcontextprotocol/sdk` ^1.32.1, `commander`, `zod`, Vitest, ESLint.

**Spec:** `docs/superpowers/specs/2026-11-13-hydra-onix-mcp-design.md` (revision 3). Reference project (read-only): `/Users/andy/projects/@andygo-dev/docs-harness`.

## Global Constraints

- Node `>=22`; `.nvmrc` `v22.15.0`; TypeScript `~6.0.3`; `"types": ["node"]` in `tsconfig.json` (already done).
- Runtime dependencies are exactly `@modelcontextprotocol/sdk`, `commander`, `zod`. No Playwright/Puppeteer, no `open` package, no keychain library.
- Package `@andygo.dev/hydra-onix-mcp`, bin `hydra-onix-mcp`, MCP server name `hydra-onix`.
- MCP URL `https://api.projects.onix.hydra-systems.net/mcp` (env `HYDRA_ONIX_MCP_URL`); app URL `https://projects.onix.hydra-systems.net` (env `HYDRA_ONIX_MCP_APP_URL`); cookie prefix `__Secure-next-auth.session-token`.
- Home `os.homedir()` (env `HYDRA_ONIX_MCP_HOME`); config dir `<home>/.hydra-onix-mcp/`; credentials `<home>/.hydra-onix-mcp/credentials.json` (env `HYDRA_ONIX_MCP_CREDENTIALS_PATH`); profile `<home>/.hydra-onix-mcp/browser-profile/`; browser binary env `HYDRA_ONIX_MCP_BROWSER`.
- Timings: refresh margin 60 s; fallback token TTL 25 min; login timeout 5 min; silent login timeout 20 s; lock stale after 60 s; cookie poll 1 s.
- Credentials file: plain JSON keyed by app URL; dir `0700`, file `0600` on POSIX only; atomic write (temp + rename).
- Never write anything but JSON-RPC to stdout during `mcp start` (`logger.useStderr()` first). Never log cookie values or tokens, even with `--verbose`.
- Never open a remote-debugging port: pipe only. Never read the user's everyday browser profile.
- Agent config files: merge, never touch other servers, leave an existing `hydra-onix` entry alone.
- Tests: offline, no real browser, never touch the real home (`HYDRA_ONIX_MCP_HOME` → temp dir in every test).
- Login-required JSON-RPC error: `code: -32001`, message ``Hydra login required: run `npx @andygo.dev/hydra-onix-mcp auth login` ``.

## Review Focus

1. Agents spawn `mcp start` with a minimal `PATH`: browser discovery must find Chrome by absolute install path, not only via `PATH` (test in Task 4).
2. Cookies with the session prefix but for another host (e.g. `passport.onix.hydra-systems.net`) or with a leading-dot domain: only cookies that apply to the app host are captured (test in Task 5).
3. Hydra down or returning HTML/5xx from `/api/auth/session` must not count as "session expired" (which would discard cookies and pop a browser); it is a transient error and the cookies stay (test in Task 3).
4. A lock file left by a killed process must not block forever: it is taken over after 60 s (test in Task 7).
5. A corrupted or empty `credentials.json` gives an actionable error, and `auth logout` / `auth login --force` still recover from it (tests in Tasks 7 and 12).

---

### Task 1: Foundations (errors, logger, version, constants, paths)

**Files:**
- Create: `src/errors.ts`, `src/logger.ts`, `src/package-version.ts` (port from `docs-harness/src/` verbatim, rename `docs-harness` → `hydra-onix-mcp` in messages; drop `notAProject`/`notInitialised`)
- Create: `src/constants.ts`, `src/paths.ts`
- Delete: placeholder content of `src/index.ts` (replace with `export {};` until Task 13)
- Test: `src/tests/foundations.test.ts`, `src/tests/helpers.ts`

**Interfaces:**
- Produces:
  - `class HarnessError extends Error { hint?: string; exitCode: number }`, `commandHint(...cmds: string[]): string`, `isHarnessError(e): e is HarnessError` (as docs-harness)
  - `logger` (as docs-harness, incl. `useStderr()`), `packageVersion(): string`
  - `constants.ts`: `PACKAGE_NAME`, `SERVER_NAME`, `DEFAULT_MCP_URL`, `DEFAULT_APP_URL`, `SESSION_COOKIE_PREFIX`, `TOKEN_REFRESH_MARGIN_MS = 60_000`, `FALLBACK_TOKEN_TTL_MS = 1_500_000`, `LOGIN_TIMEOUT_MS = 300_000`, `SILENT_LOGIN_TIMEOUT_MS = 20_000`, `LOCK_STALE_MS = 60_000`, `COOKIE_POLL_MS = 1_000`, `LOGIN_REQUIRED_CODE = -32001`; `mcpUrl(env = process.env): string`, `appUrl(env = process.env): string` (trailing `/` stripped)
  - `paths.ts`: `interface HydraPaths { home; configDir; configFile; credentialsFile; lockFile; browserProfile }` (all absolute strings; `lockFile = credentialsFile + '.lock'`); `hydraPaths(env = process.env): HydraPaths`
  - `tests/helpers.ts`: `makeTempHome(): Promise<{ env: NodeJS.ProcessEnv; paths: HydraPaths }>` (temp dir, env with `HYDRA_ONIX_MCP_HOME`), `cleanupTempDirs()`

- [ ] **Step 1: Write failing tests** in `foundations.test.ts`:
  - `hydraPaths({ HYDRA_ONIX_MCP_HOME: '/h' })` → `configDir '/h/.hydra-onix-mcp'`, `credentialsFile '/h/.hydra-onix-mcp/credentials.json'`, `browserProfile '/h/.hydra-onix-mcp/browser-profile'`, `lockFile` ends `credentials.json.lock` (use `path.join` in expectations for Windows).
  - `HYDRA_ONIX_MCP_CREDENTIALS_PATH='/x/c.json'` overrides only `credentialsFile` and `lockFile`.
  - `appUrl({ HYDRA_ONIX_MCP_APP_URL: 'http://127.0.0.1:1/' })` → `'http://127.0.0.1:1'`; `appUrl({})` → `'https://projects.onix.hydra-systems.net'`; `mcpUrl({})` → the MCP URL.
  - `packageVersion()` equals `package.json` version.
  - `new HarnessError('m', { hint: 'h', exitCode: 2 })` keeps `hint`/`exitCode`.
- [ ] **Step 2:** `npx vitest run src/tests/foundations.test.ts` → FAIL (modules missing).
- [ ] **Step 3:** Implement the files above.
- [ ] **Step 4:** `npx vitest run src/tests/foundations.test.ts && npm run typecheck && npm run lint` → all pass.
- [ ] **Step 5: Commit** `feat: add foundations (errors, logger, constants, paths)`.

### Task 2: Ported docs files and the bin shim

**Files:**
- Create: `bin/hydra-onix-mcp.js` (no sqlite check; check `process.versions.node` major `< 22` → stderr message naming `nvm install 22 && nvm use 22`, exit 1; then `await import('../dist/cli/index.js')`)
- Create: `CLAUDE.md` (structure of docs-harness's; content per this repo: layout from the spec, commands, guidelines incl. "never log cookies/tokens", "stdout is JSON-RPC in mcp start", "tests never launch a browser or touch the real home", "keep DOCTOR_COMMANDS current")
- Test: none (verified in Task 13)

- [ ] **Step 1:** Write both files.
- [ ] **Step 2:** `node -e "require('fs').accessSync('bin/hydra-onix-mcp.js')" && chmod +x bin/hydra-onix-mcp.js` → no output.
- [ ] **Step 3: Commit** `chore: add bin shim and CLAUDE.md`.

### Task 3: Session refresh (`src/auth/session.ts`)

**Files:**
- Create: `src/auth/session.ts`
- Modify: `src/tests/helpers.ts` (add `startFakeApp`)
- Test: `src/tests/session.test.ts`

**Interfaces:**
- Consumes: `SESSION_COOKIE_PREFIX`, `FALLBACK_TOKEN_TTL_MS`, `HarnessError`.
- Produces:
  - `interface StoredCookie { name: string; value: string; expires?: string /* ISO */ }`
  - `interface SessionUser { name?: string; email?: string }`
  - `interface SessionResult { accessToken: string; accessTokenExpires: string; sessionExpires?: string; user?: SessionUser; cookies: StoredCookie[] }`
  - `class SessionExpiredError extends HarnessError` (hint: run `hydra-onix-mcp auth login`)
  - `class HydraUnavailableError extends HarnessError`
  - `cookieHeader(cookies: StoredCookie[]): string`
  - `applySetCookies(cookies: StoredCookie[], setCookie: string[], now: Date): StoredCookie[]`
  - `tokenExpiry(accessToken: string, now: Date): string`
  - `refreshSession(appUrl: string, cookies: StoredCookie[], opts?: { fetch?: typeof fetch; now?: () => Date }): Promise<SessionResult>`
  - helpers: `startFakeApp(opts?): Promise<{ url: string; state: FakeAppState; close(): Promise<void> }>` where `FakeAppState = { validCookies: Map<string,string>; mode: 'ok' | 'expired' | 'error500'; tokenFormat: 'jwt' | 'opaque'; rotate: boolean; issued: string[] }`. `/api/auth/session` returns `{ user, expires, accessToken }` when every cookie in `validCookies` is sent; `{}` otherwise; `mode: 'error500'` → 500 HTML. With `rotate`, responds with `Set-Cookie` replacing `.0`/`.1` values and updates `validCookies`. JWT tokens are unsigned `header.payload.sig` with `exp = now + 1800`.

- [ ] **Step 1: Write failing tests**:
  - `cookieHeader([{name:'a',value:'1'},{name:'b',value:'2'}])` → `'a=1; b=2'`.
  - `applySetCookies`: replaces `__Secure-next-auth.session-token.0` value; adds new `.2`; removes `.1` on `Max-Age=0`; removes on past `Expires`; ignores cookies without the prefix (e.g. `next-auth.csrf-token`); sets `expires` from `Max-Age` relative to `now`.
  - `tokenExpiry(jwtWithExp(1_800_000_000), now)` → `new Date(1_800_000_000_000).toISOString()`; opaque token → `now + 25 min` ISO.
  - `refreshSession` against the fake app: ok → token, `user.email`, `sessionExpires`, cookies; with `rotate` → returned cookies carry the new values and a second call with them succeeds; `{}` → `SessionExpiredError`; 401 and a 302 redirect → `SessionExpiredError`; **500 HTML → `HydraUnavailableError` (not `SessionExpiredError`)** (Review Focus 3); network refused → `HydraUnavailableError`.
- [ ] **Step 2:** `npx vitest run src/tests/session.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `refreshSession` uses `redirect: 'manual'`, `headers.getSetCookie()`, parses JSON only when `content-type` is JSON; a JSON body without a non-empty string `accessToken` → expired. JWT `exp` read by base64url-decoding the middle segment; any decode failure → fallback TTL.
- [ ] **Step 4:** `npx vitest run src/tests/session.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: refresh the Hydra web session and rotate cookies`.

### Task 4: DevTools pipe client and browser discovery

**Files:**
- Create: `src/auth/browser/cdp-pipe.ts`, `src/auth/browser/find.ts`
- Modify: `src/tests/helpers.ts` (add `fakeCdpPeer`)
- Test: `src/tests/cdp-pipe.test.ts`, `src/tests/find-browser.test.ts`, fixture `src/tests/fixtures/fake-chrome.mjs`

**Interfaces:**
- Produces:
  - `interface CdpConnection { send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>; readonly closed: Promise<void>; dispose(): void }`
  - `connectPipe(toBrowser: NodeJS.WritableStream, fromBrowser: NodeJS.ReadableStream): CdpConnection` — messages are JSON objects terminated by `\0`; ids increment from 1; a response with `error` rejects with `Error(error.message)`; stream end/close resolves `closed` and rejects every pending `send` with `Error('browser closed')`.
  - `findBrowser(opts?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => Promise<boolean>; which?: (cmd: string) => Promise<string | undefined> }): Promise<string | undefined>`
  - helpers: `fakeCdpPeer(handler: (method: string, params: unknown) => unknown | Promise<unknown>): { toBrowser: PassThrough; fromBrowser: PassThrough; calls: string[]; close(): void }`

- [ ] **Step 1: Write failing tests**:
  - cdp-pipe: two concurrent `send`s resolve to their own results even if answered out of order; split frames (one message delivered in 3 chunks, two messages in one chunk) parse correctly; error response rejects with its message; closing the peer rejects pending and resolves `closed`.
  - cdp-pipe end-to-end: spawn `node src/tests/fixtures/fake-chrome.mjs` with `stdio: ['ignore','ignore','pipe','pipe','pipe']`, connect to `stdio[3]`/`stdio[4]`, `send('Browser.getVersion')` returns the fixture's `{ product: 'FakeChrome/1' }`, `send('Browser.close')` makes the child exit.
  - find: env `HYDRA_ONIX_MCP_BROWSER` wins when it exists; darwin with `exists` true only for `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and **`which` always undefined** → that path (Review Focus 1); darwin order Chrome > Chromium > Edge > Brave; win32 uses `%ProgramFiles%\Google\Chrome\Application\chrome.exe`, then `%ProgramFiles(x86)%`, then `%LocalAppData%`; linux tries `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge`, `brave-browser` via `which` in that order; nothing found → `undefined`.
- [ ] **Step 2:** `npx vitest run src/tests/cdp-pipe.test.ts src/tests/find-browser.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `find.ts` default `which` searches `env.PATH` entries itself (no shell), honouring `PATHEXT` on win32; macOS apps: `Google Chrome`, `Chromium`, `Microsoft Edge`, `Brave Browser`, each also under `<home>/Applications`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: DevTools pipe client and browser discovery`.

### Task 5: Capture the session from a dedicated browser window

**Files:**
- Create: `src/auth/browser/login.ts`
- Test: `src/tests/browser-login.test.ts`

**Interfaces:**
- Consumes: `CdpConnection`, `connectPipe`, `findBrowser`, `refreshSession`, `SessionResult`, `StoredCookie`, timing constants.
- Produces:
  - `chromeArgs(profileDir: string, url: string, headless: boolean): string[]` → `['--user-data-dir=<profileDir>', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), '--new-window', url]` (never `--enable-automation`, never `--remote-debugging-port`)
  - `type BrowserLauncher = (a: { executable: string; profileDir: string; url: string; headless: boolean }) => Promise<{ cdp: CdpConnection; kill(): void }>`
  - `launchChrome: BrowserLauncher` (spawn, stdio `['ignore','ignore','pipe','pipe','pipe']`, `connectPipe(stdio[3], stdio[4])`)
  - `appCookies(cdpCookies: Array<{ name: string; value: string; domain: string; expires: number }>, appUrl: string): StoredCookie[]`
  - `class LoginCancelledError extends HarnessError`, `class LoginTimeoutError extends HarnessError`, `class NoBrowserError extends HarnessError` (hint names `auth login --manual` and `HYDRA_ONIX_MCP_BROWSER`)
  - `captureSession(o: { appUrl: string; executable: string; profileDir: string; headless: boolean; timeoutMs: number; pollMs?: number; launch?: BrowserLauncher; validate?: (c: StoredCookie[]) => Promise<SessionResult> }): Promise<SessionResult>`
  - `browserLogin(o: { appUrl: string; profileDir: string; interactive: boolean; executable?: string; launch?: BrowserLauncher; validate?: (c: StoredCookie[]) => Promise<SessionResult>; silentTimeoutMs?: number; timeoutMs?: number; log?: (m: string) => void }): Promise<SessionResult>`

- [ ] **Step 1: Write failing tests** (fake launcher built on `fakeCdpPeer`; `validate` defaults to `refreshSession` against `startFakeApp`):
  - `chromeArgs` exact array for headless and visible; contains no `--remote-debugging-port` / `--enable-automation`.
  - `appCookies`: keeps `projects.onix.hydra-systems.net` and `.projects.onix.hydra-systems.net` cookies with the prefix; drops the same names on `passport.onix.hydra-systems.net` and `onix.hydra-systems.net`-unrelated hosts; drops non-prefix names; `expires: -1` → no `expires`, seconds → ISO (Review Focus 2).
  - `captureSession`: cookies appear on poll 3 → resolves with the token, `Browser.close` was sent; cookies present but `validate` throws `SessionExpiredError` → keeps polling; peer closes → `LoginCancelledError`; nothing within `timeoutMs` → `LoginTimeoutError` and the browser is killed.
  - `browserLogin`: silent capture succeeds → only one launch, `headless: true`; silent times out and `interactive: true` → second launch with `headless: false`, `log` called with a message containing the profile path; silent fails and `interactive: false` → rejects `LoginTimeoutError` with one launch; no executable found → `NoBrowserError`.
- [ ] **Step 2:** `npx vitest run src/tests/browser-login.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Poll `Storage.getCookies` (browser target, no params) every `pollMs` (default `COOKIE_POLL_MS`); try `validate` only when the cookie set changed since the last attempt; always kill the process in `finally`.
- [ ] **Step 4:** Same command → PASS; `npm run typecheck && npm run lint` → pass.
- [ ] **Step 5: Commit** `feat: capture the Hydra session from a dedicated browser window`.

### Task 6: Spike against production (gate)

**Files:**
- Create: `scripts/spike-login.mjs` (not published: `files` lists only `bin`, `dist`, `README.md`)

**Interfaces:**
- Consumes: `browserLogin`, `hydraPaths`, `appUrl` from `dist/`.

- [ ] **Step 1:** Write the script: `npm run build` output is imported; it runs `browserLogin({ appUrl: appUrl(), profileDir: <temp dir>, interactive: true, log: console.error })` and prints **only** cookie names, each cookie's `expires`, `sessionExpires`, `accessTokenExpires`, whether the token is a JWT, and `user.email` if present. No values.
- [ ] **Step 2:** `npm run build && node scripts/spike-login.mjs` with the owner present; the owner signs in in the window that opens.
- [ ] **Step 3: Gate.** Report the printed output to the owner. Continue only if the window let them sign in and a token came back. If the sign-in failed in the controlled window, **stop**: report what happened; the owner decides whether `auth login --manual` becomes the main path. Record the observed token lifetime and session expiry in the spec's "Risks" section.
- [ ] **Step 4:** Delete the temp profile. Commit the script: `chore: add production login spike script`.

### Task 7: Credentials store and lock (`src/auth/store.ts`)

**Files:**
- Create: `src/auth/store.ts`
- Test: `src/tests/store.test.ts`

**Interfaces:**
- Consumes: `StoredCookie`, `SessionUser`, `SessionResult`, `HydraPaths`, `LOCK_STALE_MS`, `LOGIN_TIMEOUT_MS`, `HarnessError`.
- Produces:
  - `interface AppCredentials { cookies: StoredCookie[]; sessionExpires?: string; accessToken?: string; accessTokenExpires?: string; user?: SessionUser; updatedAt: string }`
  - `toCredentials(r: SessionResult, now: Date): AppCredentials`
  - `class CorruptCredentialsError extends HarnessError` (hint: run `hydra-onix-mcp auth logout` or `auth login --force`)
  - `class CredentialStore { constructor(paths: Pick<HydraPaths, 'credentialsFile' | 'lockFile'>, appUrl: string, opts?: { platform?: NodeJS.Platform }); read(): Promise<AppCredentials | undefined>; write(c: AppCredentials): Promise<void>; remove(): Promise<void>; withLock<T>(fn: () => Promise<T>, o?: { staleMs?: number; waitMs?: number; pollMs?: number }): Promise<T> }`

- [ ] **Step 1: Write failing tests**:
  - write then read round trip; file JSON is `{ [appUrl]: {...} }`; writing for app B keeps app A's entry; `remove()` deletes only this app's key and deletes the file when it becomes empty.
  - POSIX: file mode `0o600`, dir `0o700` (skip on win32); with `platform: 'win32'` no `chmod` happens (spy on `fs.chmod`).
  - atomic: no `*.tmp` left behind after write.
  - read with missing file → `undefined`; with `''` or `'{not json'` → `CorruptCredentialsError`; `remove()` on a corrupt file deletes it instead of throwing (Review Focus 5).
  - `withLock`: two concurrent `withLock` calls run their functions one after the other (record start/end order); lock file removed after `fn` throws; a lock file with `mtime` 61 s in the past is taken over immediately (Review Focus 4); a fresh foreign lock with `waitMs: 200` → `HarnessError` mentioning the lock path.
- [ ] **Step 2:** `npx vitest run src/tests/store.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Lock = `open(lockFile, 'wx')` writing `{pid, at}`; on `EEXIST` check `mtime` against `staleMs`, else wait `pollMs` (default 100) up to `waitMs` (default `LOGIN_TIMEOUT_MS + 30_000`). Write = `mkdir -p` (mode 0700) → write `<file>.<pid>.tmp` → `chmod 0600` (POSIX) → `rename`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: credentials file store with cross-process lock`.

### Task 8: Token manager

**Files:**
- Create: `src/auth/token-manager.ts`
- Test: `src/tests/token-manager.test.ts`

**Interfaces:**
- Consumes: `CredentialStore`, `toCredentials`, `refreshSession`, `SessionExpiredError`, `HydraUnavailableError`, `browserLogin`, `TOKEN_REFRESH_MARGIN_MS`.
- Produces:
  - `class LoginRequiredError extends HarnessError` (message: the Global Constraints login-required text; `cause` = the underlying login error)
  - `interface TokenManagerOptions { store: CredentialStore; appUrl: string; refresh?: (appUrl: string, cookies: StoredCookie[]) => Promise<SessionResult>; login: (o: { interactive: boolean }) => Promise<SessionResult>; now?: () => Date }`
  - `class TokenManager { constructor(o: TokenManagerOptions); getToken(o: { interactive: boolean }): Promise<string>; onUnauthorized(usedToken: string, o: { interactive: boolean }): Promise<string> }`
  - `createTokenManager(paths: HydraPaths, appUrl: string, env?: NodeJS.ProcessEnv): TokenManager` (wires `browserLogin` with `paths.browserProfile` and `HYDRA_ONIX_MCP_BROWSER`, logging to `logger.info`)

- [ ] **Step 1: Write failing tests** (real `CredentialStore` in a temp home, fake `refresh`/`login` counters):
  - stored token expiring in 10 min → returned, `refresh` not called.
  - stored token expiring in 30 s → `refresh` called once, new token saved and returned.
  - no credentials → `login({ interactive })` called, result saved, token returned.
  - `refresh` throws `SessionExpiredError` → `login` called; `login` throws → `LoginRequiredError` with that `cause`; nothing saved.
  - `refresh` throws `HydraUnavailableError` → rethrown as is; `login` **not** called; stored cookies unchanged.
  - `onUnauthorized(oldToken)` when the store already holds a different, valid token (another process refreshed) → returns it without calling `refresh`; when the store holds `oldToken` → forces `refresh`.
  - 5 concurrent `getToken` calls with an expired token → `refresh` called exactly once (single flight + lock).
  - two `TokenManager` instances on the same files refreshing concurrently → `refresh` called once (the second re-reads under the lock and reuses).
- [ ] **Step 2:** `npx vitest run src/tests/token-manager.test.ts` → FAIL.
- [ ] **Step 3:** Implement: one in-process pending promise; inside `store.withLock` re-read, decide reuse/refresh/login, write `toCredentials(result, now())`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: token manager with refresh and login escalation`.

### Task 9: Manual login fallback

**Files:**
- Create: `src/auth/open-url.ts`, `src/auth/manual-login.ts`
- Create: `src/cli/prompt.ts` (port `confirm` from docs-harness; add `askSecret(question: string): Promise<string>` that mutes echo on a TTY and rejects with `HarnessError` when stdin is not a TTY)
- Test: `src/tests/manual-login.test.ts`

**Interfaces:**
- Produces:
  - `openUrl(url: string, o?: { platform?: NodeJS.Platform; spawn?: typeof import('node:child_process').spawn }): void` (darwin `open`, win32 `cmd /c start "" <url>`, else `xdg-open`; detached, ignore errors)
  - `parseCookieInput(input: string): StoredCookie[]`
  - `manualLogin(o: { appUrl: string; ask: (q: string) => Promise<string>; open?: (url: string) => void; validate?: (c: StoredCookie[]) => Promise<SessionResult>; print?: (m: string) => void }): Promise<SessionResult>`

- [ ] **Step 1: Write failing tests**:
  - `parseCookieInput('Cookie: a=1; __Secure-next-auth.session-token.0=AA; __Secure-next-auth.session-token.1=BB')` → the two prefixed cookies only; a bare `name=value` per line works; a bare value with no `=` → `[{ name: '__Secure-next-auth.session-token', value }]`; surrounding quotes and whitespace stripped; empty input → `[]`.
  - `manualLogin`: calls `open(appUrl + '/')`, asks once, validates, returns the result; empty parse → asks again (max 3 tries, then `HarnessError`); `validate` throws `SessionExpiredError` → error message says the cookies were not accepted.
  - `openUrl` with a spy `spawn`: darwin → `('open', [url])`; win32 → `('cmd', ['/c', 'start', '""', url])`; linux → `('xdg-open', [url])`.
- [ ] **Step 2:** `npx vitest run src/tests/manual-login.test.ts` → FAIL.
- [ ] **Step 3:** Implement; instructions printed via `print` tell the user DevTools → Application → Cookies → `projects.onix.hydra-systems.net`, or Network → any request → copy the `Cookie` request header.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: manual cookie login fallback`.

### Task 10: Relay

**Files:**
- Create: `src/proxy/relay.ts`
- Modify: `src/tests/helpers.ts` (add `startFakeMcp`)
- Test: `src/tests/relay.test.ts`

**Interfaces:**
- Consumes: `TokenManager` (`getToken`, `onUnauthorized`), `LoginRequiredError`, `LOGIN_REQUIRED_CODE`.
- Produces:
  - `type TokenSource = Pick<TokenManager, 'getToken' | 'onUnauthorized'>`
  - `authorizedFetch(tokens: TokenSource, base?: typeof fetch): (url: string | URL, init?: RequestInit) => Promise<Response>`
  - `startRelay(o: { mcpUrl: string; tokens: TokenSource; downstream?: Transport; fetch?: typeof fetch; log?: (m: string) => void }): Promise<{ close(): Promise<void>; closed: Promise<void> }>` (default downstream: `new StdioServerTransport()`)
  - helpers: `startFakeMcp(o: { isValid: (token: string) => boolean }): Promise<{ url: string; requests: number; close(): Promise<void> }>` — SDK `McpServer` with tool `echo({ text })`, served by `StreamableHTTPServerTransport` behind a check that answers 401 when the Bearer token is not valid; a linked in-memory transport pair (`InMemoryTransport.createLinkedPair()` from the SDK) plays the downstream agent with an SDK `Client`.

- [ ] **Step 1: Write failing tests** (downstream = SDK `Client` over `InMemoryTransport`):
  - `client.connect` + `listTools()` returns `echo`; `callTool('echo', {text:'hi'})` returns `hi`; every upstream request carried `Authorization: Bearer <token>`.
  - no upstream request happens before the first downstream message (lazy connect).
  - fake server starts rejecting the current token mid-session → the next `callTool` succeeds after exactly one `onUnauthorized` and one retry.
  - `getToken` rejects with `LoginRequiredError` → `callTool` rejects with an MCP error whose `code` is `-32001` and message contains `auth login`; the following call tries `getToken` again.
  - three `callTool`s sent while `getToken` is pending (deferred promise) all resolve, in send order, after it resolves.
  - a downstream notification that fails upstream produces no response message and no crash.
  - after `initialize`, the upstream transport's `setProtocolVersion` was called with the negotiated version (spy).
  - `close()` closes both transports; `closed` resolves.
- [ ] **Step 2:** `npx vitest run src/tests/relay.test.ts` → FAIL.
- [ ] **Step 3:** Implement: downstream `onmessage` pushes onto a promise chain (strict order); first message creates `new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: authorizedFetch(tokens, o.fetch) })`, wires `onmessage` (track pending `initialize` id → `setProtocolVersion(result.protocolVersion)` before forwarding), `onerror` → `log`, then `start()`. A failed `send` for a request → downstream error response `{ jsonrpc: '2.0', id, error: { code: err instanceof LoginRequiredError ? -32001 : -32603, message } }`. `authorizedFetch` sets the header on a copy of `init.headers`, retries once on 401 with `onUnauthorized(token, { interactive: true })`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: stdio to Streamable HTTP relay with Bearer injection`.

### Task 11: Agent targets at user level

**Files:**
- Create: `src/generators/mcp-entry.ts`, `src/generators/claude-cli.ts`, `src/generators/targets/{types,registry,mcp,install}.ts` (port from docs-harness; `root` parameter becomes `home`)
- Create: `src/config/schema.ts`, `src/config/config.ts`
- Test: `src/tests/targets.test.ts` (port docs-harness's, adapted), `src/tests/config.test.ts`

**Interfaces:**
- Consumes: `PACKAGE_NAME`, `SERVER_NAME`, `HydraPaths`, `HarnessError`.
- Produces:
  - `mcpLaunch(platform?: NodeJS.Platform): { command: string; args: string[] }` → posix `{ command: 'npx', args: ['-y', PACKAGE_NAME, 'mcp', 'start'] }`; win32 `{ command: 'cmd', args: ['/c', 'npx', '-y', PACKAGE_NAME, 'mcp', 'start'] }`; `mcpCommandLine(platform?): string[]`
  - `TARGET_IDS = ['claude-code', 'cursor', 'codex', 'gemini', 'opencode']`; `TargetDefinition { id; label; mcp: { file: string /* home-relative */; style: McpStyle; note?: string }; markers: string[] /* home-relative */ }` with the spec's table: `.claude.json` / `.cursor/mcp.json` / `.codex/config.toml` / `.gemini/settings.json` / `.config/opencode/opencode.json`; markers `.claude`, `.claude.json` / `.cursor` / `.codex` / `.gemini` / `.config/opencode`
  - `detectTargets(home)`, `parseTargetIds`, `requireTarget`, `TARGETS`, `ALL_TARGETS` (as docs-harness)
  - `inspectTargetRegistration(home, target, serverName, o?: { platform? })`, `registerTargetServer(home, target, serverName, o?: { platform?; claude?: ClaudeCli })`, `registerTargets(targets, { home, serverName, confirm, platform?, claude? })`, `TargetRegistrationState` (as docs-harness; `relativeFile` shown as `~/<file>`)
  - `interface ClaudeCli { available(): Promise<boolean>; addUserServer(name: string, entry: object): Promise<void> }`; `defaultClaudeCli(): ClaudeCli` (runs `claude mcp add-json --scope user <name> <json>` with `execFile`)
  - config: `configSchema` (zod: `{ version: z.literal(1), targets: z.array(z.enum(TARGET_IDS)) }`), `loadConfig(paths): Promise<UserConfig | undefined>`, `saveConfig(paths, c)`, `ensureConfig(paths, o?: { targets?: TargetId[] }): Promise<{ config: UserConfig; created: boolean }>` (new config uses `o.targets ?? detectTargets(paths.home)`, falling back to `['claude-code']` when nothing is detected)

- [ ] **Step 1: Port the docs-harness target tests** with `home` from `makeTempHome()` and add:
  - claude-code with a fake `ClaudeCli` available → `addUserServer('hydra-onix', { command: 'npx', args: [...] })` called and no file written by us; unavailable → `~/.claude.json` merged (other top-level keys like `projects` and `numStartups` preserved, other servers preserved).
  - an existing `hydra-onix` entry `{ type: 'http', url: '...', oauth: {...} }` → left unchanged, `registered: true`, `current: false`.
  - `platform: 'win32'` → written entry is `{ command: 'cmd', args: ['/c', 'npx', ...] }` and counts as `current` on win32 only.
  - opencode path is `~/.config/opencode/opencode.json` with `$schema` on creation.
  - config: invalid JSON or schema → `HarnessError` with the file path in the hint; `ensureConfig` is idempotent.
- [ ] **Step 2:** `npx vitest run src/tests/targets.test.ts src/tests/config.test.ts` → FAIL.
- [ ] **Step 3:** Implement the port.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat: register the server in user-level agent configs`.

### Task 12: CLI commands

**Files:**
- Create: `src/cli/index.ts`, `src/cli/commands/setup.ts`, `src/cli/commands/doctor.ts`, `src/cli/commands/auth/{login,logout,status}.ts`, `src/cli/commands/mcp/{start,status}.ts`, `src/cli/commands/targets/{list,add,remove,install}.ts`
- Test: `src/tests/cli.test.ts`, `src/tests/doctor.test.ts`

**Interfaces:**
- Consumes: everything above. Each command module exports `<name>Command(options)` plus a `run<Name>(options & { env?: NodeJS.ProcessEnv })` that returns data (for tests and `--json`), as docs-harness does.
- Produces (behaviour per the spec's CLI table):
  - `runAuthLogin({ manual?: boolean; force?: boolean; env?: NodeJS.ProcessEnv; login?: (o: { interactive: boolean }) => Promise<SessionResult> })` → `{ user?: SessionUser; sessionExpires?: string }`; non-TTY + no browser → `NoBrowserError`; TTY + no browser → falls back to `manualLogin`. `--force`: `store.remove()` first (works on a corrupt file).
  - `runAuthLogout({ keepProfile?, env? })` → removes credentials entry, and `rm -rf paths.browserProfile` unless `keepProfile`.
  - `runAuthStatus({ env? })` → `{ loggedIn: boolean; user?; credentialsFile; sessionExpires?; accessTokenExpires?; browser?: string }` — no cookie/token fields.
  - `mcpStartCommand({ env? })` → `logger.useStderr()` first, then `startRelay({ mcpUrl: mcpUrl(env), tokens: createTokenManager(...) })`, resolve on close/SIGINT/SIGTERM.
  - `runDoctor({ env?, online?, connect? })` → `DoctorReport` (`checks: { id; label; status: 'pass'|'warn'|'fail'|'skip'; hint? }[]`, `commands: DOCTOR_COMMANDS`, `ok`). Check ids: `node`, `config`, `registration:<target>`, `browser`, `credentials`, `credentials-permissions` (POSIX), `session`; with `online`: `session-refresh`, `mcp-tools` (label includes tool count).
  - `DOCTOR_COMMANDS` lists every command registered in `cli/index.ts`.

- [ ] **Step 1: Write failing tests** (temp home, fake app/MCP servers via env URLs, injected fake login):
  - `setup -y --no-login` on a home with `~/.cursor/` → config `targets: ['cursor']`, `~/.cursor/mcp.json` has the entry; second run changes nothing.
  - `runAuthStatus` after a fake login → `loggedIn: true`, `user.email`; `JSON.stringify(result)` contains no cookie value and no token.
  - `runAuthLogin({ force: true })` with `credentials.json` = `'{not json'` → succeeds (Review Focus 5); `runAuthLogout` on the same corrupt file → succeeds and the file is gone.
  - `runAuthLogout()` removes the profile dir; `{ keepProfile: true }` keeps it.
  - doctor: fresh home → `config` fail with hint `hydra-onix-mcp setup`; after setup + login → `ok: true`; credentials file mode `0644` → `credentials-permissions` warn (POSIX only); `online` with fake servers → `mcp-tools` pass, label contains `1 tool`.
  - `targets list --json` and `mcp status --json` after setup report `cursor` as `registered: true, current: true` and the login state; `targets add gemini -y` adds the entry and the config target; `targets remove gemini` drops the config target and leaves `~/.gemini/settings.json` untouched.
  - every `DOCTOR_COMMANDS` entry's command path exists in the commander program (walk `program.commands`).
  - spawn `node bin/hydra-onix-mcp.js mcp start` (after `npm run build`, test skipped if `dist/` missing) with env pointing at fakes; write an `initialize` line to stdin; **every stdout line parses as JSON-RPC**.
- [ ] **Step 2:** `npx vitest run src/tests/cli.test.ts src/tests/doctor.test.ts` → FAIL.
- [ ] **Step 3:** Implement the commands and `cli/index.ts` (structure and `reportError` from docs-harness; commands: `setup`, `doctor [--json] [--online]`, `auth login [--manual] [--force]`, `auth logout [--keep-profile]`, `auth status [--json]`, `mcp start`, `mcp status [--json]`, `targets list|add|remove|install`).
- [ ] **Step 4:** `npm run build && npx vitest run src/tests/cli.test.ts src/tests/doctor.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: CLI commands (setup, doctor, auth, mcp, targets)`.

### Task 13: Public exports, README, full verification

**Files:**
- Modify: `src/index.ts` (export the public pieces: `hydraPaths`, `appUrl`, `mcpUrl`, constants, `refreshSession`, `CredentialStore`, `TokenManager`, `createTokenManager`, `browserLogin`, `manualLogin`, `startRelay`, targets API, `runDoctor`, `HarnessError`, `isHarnessError`)
- Create: `README.md` (sections modelled on docs-harness: what it is, requirements (Node 22, a Chromium-family browser), quick start `npx @andygo.dev/hydra-onix-mcp setup`, how login works (dedicated profile, silent re-login, manual fallback), commands, what gets created (`~/.hydra-onix-mcp/…`, agent files), manual registration snippets per agent incl. Windows `cmd /c`, security (credentials file is a full Hydra web session; `0600`; logout deletes the profile), known limit (first `initialize` timeout → reconnect via `/mcp`), development, license)
- Test: `src/tests/exports.test.ts`

- [ ] **Step 1:** Write `exports.test.ts`: importing `../index.js` exposes each name above as defined.
- [ ] **Step 2:** `npx vitest run src/tests/exports.test.ts` → FAIL; implement; → PASS.
- [ ] **Step 3:** Full verification: `npm run clean && npm run build && npm test && npm run typecheck && npm run lint && node bin/hydra-onix-mcp.js --help && node bin/hydra-onix-mcp.js doctor --json` → all succeed; `--help` lists every command; `npm pack --dry-run` lists only `bin/`, `dist/`, `README.md`, `package.json`.
- [ ] **Step 4:** With the owner: `node bin/hydra-onix-mcp.js setup` on the real machine (owner confirms each agent prompt and signs in), then `doctor --online` → `mcp-tools` pass. Report the result.
- [ ] **Step 5: Commit** `docs: README and public exports`.
