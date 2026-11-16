# @andygo.dev/hydra-onix-mcp

Hydra Onix MCP for **your coding agent**, with a one-time browser login.

The Hydra Projects MCP server authenticates with a web session. This package is
a small local proxy that your coding agent launches over stdio. It signs in
once through a dedicated Chrome window, keeps the session fresh in the
background, and relays every MCP request to Hydra with a valid Bearer token.

It replaces the cron job that scraped session cookies and rewrote
`~/.cursor/mcp.json`: you sign in once, and there is nothing to maintain.

It works with **Claude Code, Cursor, OpenAI Codex CLI, Gemini CLI and
OpenCode**. For each agent it writes one user-level MCP server entry
(`hydra-onix`), in that agent's own config format.

```
Coding agent ── stdio ──▶ hydra-onix-mcp mcp start ── HTTPS + Bearer ──▶ Hydra Projects MCP
                                  │
                                  └─ token expired? refresh from the stored session,
                                     or sign in again in the dedicated Chrome window
```

## Requirements

- Node.js **>= 22**
- A Chromium-family browser: Google Chrome, Chromium, Microsoft Edge or Brave
  (or use the manual login fallback, which needs no browser automation)
- macOS, Linux or Windows

No native modules, no Playwright or Puppeteer, no keychain library.

## Quick start

```bash
npx @andygo.dev/hydra-onix-mcp setup
```

`setup` detects the coding agents you use, asks before registering the MCP
server with each one, then opens a Chrome window so you can sign in to Hydra.
When it finishes, restart your agent (or reconnect the server) and the Hydra
tools are available.

Useful variations:

```bash
npx @andygo.dev/hydra-onix-mcp setup -y                       # no prompts
npx @andygo.dev/hydra-onix-mcp setup --target claude-code     # choose agents yourself
npx @andygo.dev/hydra-onix-mcp setup --no-login               # register only
```

Or install once and run the binary:

```bash
npm install -g @andygo.dev/hydra-onix-mcp
hydra-onix-mcp setup
```

## How login works

- The login runs in a **dedicated browser profile** at
  `~/.hydra-onix-mcp/browser-profile`. Your everyday browser profile is never
  read.
- A visible Chrome window opens on the Hydra sign-in page. You sign in as you
  normally would; the tool then reads the session cookies from that window
  and closes it.
- The session cookies are stored in `~/.hydra-onix-mcp/credentials.json`. The
  Hydra session lasts **7 days**.
- Access tokens are short-lived (about **1 hour**). They are renewed
  automatically from the stored session, a minute before they expire, with no
  window and no prompt.
- When the 7-day session expires, the tool first tries a **silent re-login**
  in the dedicated profile (headless, no window). Only if that fails does it
  show the visible window again.
- **No browser?** `auth login --manual` lets you paste the session cookies by
  hand instead.
- The browser is controlled over a pipe, so **no debugging port is opened**.

## Commands

| Command | What it does |
|---|---|
| `setup` | Detect agents, write config, register with each agent, sign in. Idempotent (`-y`, `--no-mcp`, `--no-login`, `--target <agent>`) |
| `auth login` | Sign in: silent attempt, then a visible window (`--manual` to paste cookies, `--force` to discard the stored session first) |
| `auth logout` | Remove the stored session and delete the dedicated browser profile (`--keep-profile`) |
| `auth status` | Who is signed in, credentials path, session and token expiry, browser found. Never prints cookies or tokens (`--json`) |
| `mcp start` | Run the stdio MCP proxy (your coding agent launches this) |
| `mcp status` | Registration per agent and login state (`--json`) |
| `targets list` | Coding agents, and whether each is set up and registered |
| `targets add <agent...>` | Set up other agents and register the server with them (`-y`, `--no-mcp`) |
| `targets remove <agent...>` | Stop setting up an agent (deletes nothing) |
| `targets install` | Register the MCP server with every configured agent (`-y`, `--target <agent>`) |
| `doctor` | Check setup health and list available commands (`--json`, `--online`) |

Valid agent ids for `--target` and `<agent>`: `claude-code` (Claude Code),
`cursor` (Cursor), `codex` (OpenAI Codex CLI), `gemini` (Gemini CLI) and
`opencode` (OpenCode). `--target` can be repeated.

Global flags: `--verbose` (diagnostics and stack traces), `-V, --version`,
`--help`. Every command is safe to run repeatedly.

## What gets created

```
~/.hydra-onix-mcp/
├── config.json           which agents you set up (no credentials)
├── credentials.json      the Hydra web session (see Security)
└── browser-profile/      dedicated Chrome profile used for sign-in
```

Then, only for the agents you approve, one `hydra-onix` entry in the user-level
config:

```
Claude Code       ~/.claude.json
Cursor            ~/.cursor/mcp.json
OpenAI Codex CLI  ~/.codex/config.toml
Gemini CLI        ~/.gemini/settings.json
OpenCode          ~/.config/opencode/opencode.json
```

Existing config files are merged into, never rewritten, and other servers are
never touched. An existing `hydra-onix` entry is left alone: `mcp status` and
`doctor` report it as "registered, not ours" and show the entry to use
(`targets list` marks it `not ours`). For Claude
Code, `claude mcp add-json --scope user` is used when the `claude` CLI is on
your `PATH`.

## Manual registration

`setup` asks before touching any config file. To register by hand, add this to
`~/.claude.json` (Claude Code), `~/.cursor/mcp.json` (Cursor) or
`~/.gemini/settings.json` (Gemini CLI):

```json
{
  "mcpServers": {
    "hydra-onix": {
      "command": "npx",
      "args": ["-y", "@andygo.dev/hydra-onix-mcp", "mcp", "start"]
    }
  }
}
```

On **Windows**, wrap `npx` in `cmd /c`:

```json
{
  "mcpServers": {
    "hydra-onix": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@andygo.dev/hydra-onix-mcp", "mcp", "start"]
    }
  }
}
```

In `~/.config/opencode/opencode.json` (OpenCode):

```json
{
  "mcp": {
    "hydra-onix": {
      "type": "local",
      "command": ["npx", "-y", "@andygo.dev/hydra-onix-mcp", "mcp", "start"],
      "enabled": true
    }
  }
}
```

On Windows use `["cmd", "/c", "npx", "-y", "@andygo.dev/hydra-onix-mcp", "mcp", "start"]`.

In `~/.codex/config.toml` (Codex CLI):

```toml
[mcp_servers.hydra-onix]
command = "npx"
args = ["-y", "@andygo.dev/hydra-onix-mcp", "mcp", "start"]
```

On Windows use `command = "cmd"` and `args = ["/c", "npx", "-y", "@andygo.dev/hydra-onix-mcp", "mcp", "start"]`.

Never put cookies or tokens in these files. Credentials live only in
`credentials.json` and the dedicated browser profile.

## Testing the server

Check the setup, and with `--online` also talk to the real server:

```bash
npx @andygo.dev/hydra-onix-mcp doctor            # local checks
npx @andygo.dev/hydra-onix-mcp doctor --online   # refresh the session, initialize, list tools
```

`--online` refreshes the session, runs `initialize` and `tools/list` through the
real Hydra server and reports the tool count. Each failure prints the command
that fixes it, and the exit code is non-zero, so `doctor` works as a CI gate.

To explore the tools interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx -y @andygo.dev/hydra-onix-mcp mcp start
```

## Security

- `credentials.json` holds a **full Hydra web session** as plain JSON, the same
  approach as the Google Drive MCP server. Anyone who can read the file can act
  as you in Hydra until the session expires. It is written atomically, with the
  directory at `0700` and the file at `0600` on POSIX systems (on Windows the
  user profile's ACLs apply).
- **Never commit it**, copy it into a chat, or sync it to shared storage.
- `auth logout` removes the stored session **and deletes the dedicated browser
  profile**, so the next login cannot silently sign the same user back in.
  `--keep-profile` keeps the profile.
- The browser is driven over a pipe: **no debugging port is opened**, and your
  everyday browser profile is never read.
- Cookies and tokens are never logged, even with `--verbose`, and never written
  into an agent config file.

## Known limits

- If both the web session and the sign-in session in the dedicated profile have
  expired, the first `initialize` after that has to wait for you to sign in, and
  your agent may time out before you finish. The login still completes and the
  session is stored, so **reconnect the server** (for example `/mcp` in Claude
  Code) and it works. `setup` signs in up front, so this is rare.
- If the Hydra MCP server forgets the MCP session the relay opened (for example
  after a server restart, answered with HTTP 404 for that session id), every
  later call fails until the agent reconnects. The relay does not re-initialize
  on its own: **reconnect the server** (`/mcp` in Claude Code, or restart the
  agent).

## Troubleshooting

**No browser found.** Install Chrome, Chromium, Edge or Brave, or point to one:

```bash
HYDRA_ONIX_MCP_BROWSER="/path/to/chrome" npx @andygo.dev/hydra-onix-mcp auth login
```

Or skip the browser and paste the cookies: `npx @andygo.dev/hydra-onix-mcp auth login --manual`.

**"Hydra login required".** Tool calls fail with a JSON-RPC error (code
`-32001`) when no valid session exists and the login did not complete. Run:

```bash
npx @andygo.dev/hydra-onix-mcp auth login
```

then reconnect the server in your agent. Use `auth login --force` to discard a
broken session, and `doctor` to see what else is wrong.

**Entry "registered, not ours".** An older `hydra-onix` entry already exists
(for example an HTTP entry with a hand-maintained `Authorization` header). It is
left alone (see `mcp status` or `doctor`); replace it with the snippet above.

Other environment overrides:

- `HYDRA_ONIX_MCP_HOME` replaces the home directory, for testing: it moves the
  state directory **and** the agent config paths (`<home>/.claude.json`,
  `<home>/.cursor/mcp.json`, ...), and it disables the `claude` CLI so the real
  `~/.claude.json` is never touched.
- `HYDRA_ONIX_MCP_CREDENTIALS_PATH` relocates only the credentials file. Set it
  in the agent's launch environment too, or `mcp start` looks in the default
  location: add `"env": { "HYDRA_ONIX_MCP_CREDENTIALS_PATH": "/path/to/credentials.json" }`
  to the MCP entry.
- `HYDRA_ONIX_MCP_URL` and `HYDRA_ONIX_MCP_APP_URL` override the endpoints.

## Development

```bash
npm install
npm run build
npm test          # fully offline: no real browser, no network, no real home directory
npm run typecheck
npm run lint
node ./bin/hydra-onix-mcp.js --help
```

## License

MIT, see [LICENSE](LICENSE).
