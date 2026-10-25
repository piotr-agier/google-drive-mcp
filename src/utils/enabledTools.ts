/**
 * Optional allowlist of the tools the server lists and runs.
 *
 * `--enable-tools=a,b` or `GOOGLE_DRIVE_MCP_ENABLED_TOOLS=a,b` (the flag wins).
 * Unset, every tool is offered, as before. Set, `tools/list` shows exactly the
 * named tools and a call to any other is refused, so a deployment can offer,
 * say, Docs and Sheets reads alone. An unknown name fails the server at start,
 * so a typo never silently drops a tool.
 */
export const ENABLED_TOOLS_ENV = 'GOOGLE_DRIVE_MCP_ENABLED_TOOLS';
const FLAG = '--enable-tools=';

function splitNames(raw: string, source: string): Set<string> {
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(`${source} is set but names no tool; unset it to offer every tool`);
  }
  return new Set(names);
}

/** The enabled tool names, or null when every tool is enabled. */
export function parseEnabledTools(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Set<string> | null {
  const flag = argv.filter((a) => a.startsWith(FLAG)).pop();
  if (flag !== undefined) return splitNames(flag.slice(FLAG.length), '--enable-tools');
  const raw = env[ENABLED_TOOLS_ENV]?.trim();
  if (!raw) return null;
  return splitNames(raw, ENABLED_TOOLS_ENV);
}

/** @throws Error naming every enabled tool the server does not define */
export function checkEnabledTools(enabled: Set<string> | null, known: Iterable<string>): void {
  if (!enabled) return;
  const knownSet = new Set(known);
  const unknown = [...enabled].filter((name) => !knownSet.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown tool(s) in the enabled list: ${unknown.join(', ')}`);
  }
}

export function isToolEnabled(enabled: Set<string> | null, name: string): boolean {
  return enabled === null || enabled.has(name);
}
