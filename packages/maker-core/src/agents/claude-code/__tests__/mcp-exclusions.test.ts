import { describe, expect, it, vi } from 'vitest';
import { mergeClaudeMcpDisallowedTools, snapshotClaudeMcpExclusions } from '../mcp-exclusions.js';
import { ClaudeCodeAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';

describe('fresh diagnostic MCP exclusions', () => {
  it('keeps absent overrides inert and accepts an explicit empty fresh profile', () => {
    expect(snapshotClaudeMcpExclusions({})).toEqual([]);
    expect(snapshotClaudeMcpExclusions({ resumeSessionId: 'existing' })).toEqual([]);
    expect(snapshotClaudeMcpExclusions({ vendorOptions: { claudeExcludedMcpServers: [] } })).toEqual([]);
  });

  it('snapshots exact server names without sharing caller-owned mutable state', () => {
    const names = ['wwise-mcp', 'wwise-mcp', 'probe_keep'];
    const snapshot = snapshotClaudeMcpExclusions({ vendorOptions: { claudeExcludedMcpServers: names } });
    names.splice(0, names.length, 'different');
    expect(snapshot).toEqual(['wwise-mcp', 'probe_keep']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(mergeClaudeMcpDisallowedTools(snapshot, ['Bash', 'mcp__wwise-mcp__*']))
      .toEqual(['Bash', 'mcp__wwise-mcp__*', 'mcp__probe_keep__*']);
  });

  it.each([null, 'wwise-mcp', [''], ['*'], ['a__b'], [' leading'], ['a/b'], [1], Array(1), ['a'.repeat(65)], Array(33).fill('a')])('rejects malformed exclusions before touching agent dependencies: %j', async value => {
      const touched = vi.fn(() => { throw new Error('dependency touched'); });
      const deps = new Proxy({}, { get: touched }) as AgentDeps;
      // Constructor reads dependencies; arm the trap only for startSession.
      const agent = new ClaudeCodeAgent({ auth: {}, runtimeConfig: {}, logger: {}, binaryPath: process.execPath } as AgentDeps);
      Object.assign(agent, { deps });
      await expect(agent.startSession({ model: 'test', workingDir: '.', vendorOptions: { claudeExcludedMcpServers: value } }))
        .rejects.toThrow('claudeExcludedMcpServers');
      expect(touched).not.toHaveBeenCalled();
    });

  it.each([{ remoteHostId: 'remote' }, { botRuntimeProfile: {} }, { reviewMode: true }, { resumeSessionId: 'old' }])('rejects unsupported contexts: %j', context => {
      expect(() => snapshotClaudeMcpExclusions({ ...context, vendorOptions: { claudeExcludedMcpServers: ['wwise-mcp'] } }))
        .toThrow('fresh local ordinary');
      expect(() => snapshotClaudeMcpExclusions({ ...context, vendorOptions: { claudeExcludedMcpServers: [] } }))
        .toThrow('fresh local ordinary');
    });
});
