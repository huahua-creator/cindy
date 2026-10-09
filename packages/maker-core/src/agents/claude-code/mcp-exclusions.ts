/** Opt-in, non-persistent MCP profile for fresh local diagnostic sessions. */
export function snapshotClaudeMcpExclusions(opts: {
  vendorOptions?: Record<string, unknown>;
  remoteHostId?: string | null;
  botRuntimeProfile?: unknown;
  reviewMode?: boolean;
  resumeSessionId?: string;
}): readonly string[] {
  const value = opts.vendorOptions?.claudeExcludedMcpServers;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32 || [...value].some(name =>
    typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.includes('__'))) {
    throw new Error('claudeExcludedMcpServers requires at most 32 exact MCP server names (letters, digits, hyphens or single underscores)');
  }
  if (opts.remoteHostId || opts.botRuntimeProfile || opts.reviewMode || opts.resumeSessionId) {
    throw new Error('claudeExcludedMcpServers supports only fresh local ordinary sessions');
  }
  return Object.freeze([...new Set(value as string[])]);
}

export function mergeClaudeMcpDisallowedTools(
  excludedServers: readonly string[],
  existing: readonly string[] = [],
): string[] {
  return [...new Set([...existing, ...excludedServers.map(name => `mcp__${name}__*`)])];
}
