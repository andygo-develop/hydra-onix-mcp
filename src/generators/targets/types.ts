/**
 * What a "target" is: one coding agent the server can be registered with.
 *
 * A target is a description of that agent's user-level conventions rather than
 * a separate implementation: adding an agent means adding a definition here and
 * teaching the MCP writer its dialect.
 */

export const TARGET_IDS = ['claude-code', 'cursor', 'codex', 'gemini', 'opencode'] as const;

export type TargetId = (typeof TARGET_IDS)[number];

/**
 * How a target's MCP configuration file is shaped.
 *
 * - `mcpServers` — a JSON object keyed by server name, holding `command`/`args`.
 * - `opencode`   — JSON, servers under `mcp` with a `command` argv array plus
 *   `type: "local"`.
 * - `codex-toml` — a TOML `[mcp_servers.<name>]` table.
 */
export type McpStyle = 'mcpServers' | 'opencode' | 'codex-toml';

export interface TargetMcp {
  /** Home-relative configuration file (forward slashes). */
  file: string;
  style: McpStyle;
  /** Extra guidance printed after registering, when the tool needs it. */
  note?: string;
}

export interface TargetDefinition {
  id: TargetId;
  label: string;
  mcp: TargetMcp;
  /** Home-relative paths whose presence means this tool is probably in use. */
  markers: readonly string[];
}
