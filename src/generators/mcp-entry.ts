/**
 * The one description of how a coding agent should launch this MCP server.
 *
 * Every target writes the same command in its own configuration dialect.
 * `npx` resolves the package (not the binary name) from a local install, a
 * global install or a cold cache alike. On Windows `npx` is a `.cmd` shim that
 * agents cannot spawn directly, so it is wrapped in `cmd /c`.
 */
import { PACKAGE_NAME } from '../constants.js';

export function mcpLaunch(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  const npx = ['npx', '-y', PACKAGE_NAME, 'mcp', 'start'];
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', ...npx] }
    : { command: 'npx', args: npx.slice(1) };
}

/** The launch command as a single argv array, for configs that want one list. */
export function mcpCommandLine(platform: NodeJS.Platform = process.platform): string[] {
  const { command, args } = mcpLaunch(platform);
  return [command, ...args];
}
