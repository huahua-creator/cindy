import { afterEach, describe, expect, it } from 'vitest';

import type { McpProviderContext } from '../../../interfaces/mcp-provider.js';
import {
  forgetLiveClaudeMcpContext,
  getLiveClaudeMcpContext,
  rememberLiveClaudeMcpContext,
  resetLiveClaudeMcpContextsForTest,
} from '../live-mcp-context.js';

afterEach(() => {
  resetLiveClaudeMcpContextsForTest();
});

describe('live Claude MCP context index', () => {
  it('returns the same object reference and does not clone', () => {
    const context = {
      agentKind: 'claude-code',
      workingDir: '/tmp/xdt-fixture-repo',
      sessionId: 'session-live',
    } as McpProviderContext;
    rememberLiveClaudeMcpContext('session-live', context);
    expect(getLiveClaudeMcpContext('session-live')).toBe(context);
    context.preparedMemorySessionId = '44444444-4444-4444-8444-444444444444';
    expect(getLiveClaudeMcpContext('session-live')?.preparedMemorySessionId).toBe(
      '44444444-4444-4444-8444-444444444444',
    );
  });

  it('forgets on close and does not invent a replacement context', () => {
    const context = {
      agentKind: 'claude-code',
      workingDir: '/tmp/xdt-fixture-repo',
      sessionId: 'session-closed',
    } as McpProviderContext;
    rememberLiveClaudeMcpContext('session-closed', context);
    forgetLiveClaudeMcpContext('session-closed');
    expect(getLiveClaudeMcpContext('session-closed')).toBeUndefined();
  });
});
