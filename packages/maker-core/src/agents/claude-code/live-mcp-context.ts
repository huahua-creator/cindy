/**
 * Live Claude MCP context index. Keyed by business sessionId.
 * Stores the same object reference created in startSession / buildMcpServers.
 * Host mutate-in-place must hit this object; clones are forbidden.
 */

import type { McpProviderContext } from '../../interfaces/mcp-provider.js';

const liveClaudeMcpContexts = new Map<string, McpProviderContext>();

export function rememberLiveClaudeMcpContext(
  sessionId: string,
  context: McpProviderContext,
): void {
  liveClaudeMcpContexts.set(sessionId, context);
}

export function getLiveClaudeMcpContext(sessionId: string): McpProviderContext | undefined {
  return liveClaudeMcpContexts.get(sessionId);
}

export function forgetLiveClaudeMcpContext(sessionId: string): void {
  liveClaudeMcpContexts.delete(sessionId);
}

export function resetLiveClaudeMcpContextsForTest(): void {
  liveClaudeMcpContexts.clear();
}
