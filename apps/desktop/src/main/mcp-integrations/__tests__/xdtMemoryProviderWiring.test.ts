/**
 * 段 1 结构性回归：createDesktopMcpProviders 注入 prepared session accessor，
 * Codex/Pi ALS 透传 frozen binding，deferOrdinaryGate 不得把 xdt/disabled 做成全局 enabled。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const providers = readFileSync(resolve(__dirname, '..', 'mcp-providers.ts'), 'utf8').replace(/\r\n?/g, '\n');
const codexEnv = readFileSync(resolve(__dirname, '..', 'codexEnvironment.ts'), 'utf8').replace(/\r\n?/g, '\n');
const piEnv = readFileSync(resolve(__dirname, '..', 'piEnvironment.ts'), 'utf8').replace(/\r\n?/g, '\n');
const host = readFileSync(resolve(__dirname, '..', '..', 'maker-host', 'index.ts'), 'utf8').replace(/\r\n?/g, '\n');

describe('desktop MCP providers carry frozen xdt binding', () => {
  it('injects getPreparedMemorySession into cindy_memory deps', () => {
    expect(providers).toContain('getPreparedMemorySession?: (preparedMemorySessionId: string)');
    expect(providers).toContain('getPreparedMemorySession: deps.getPreparedMemorySession');
    expect(host).toContain('getPreparedMemorySession,');
  });

  it('injects executeXdtFacadeWrite for Claude H-Bus and keeps Codex getWriteTarget undefined', () => {
    expect(providers).toContain('executeXdtFacadeWrite?: import(\'@cindy/mcps\').MemoryMcpDeps[\'executeXdtFacadeWrite\']');
    expect(providers).toContain('executeXdtFacadeWrite: deps.executeXdtFacadeWrite');
    expect(host).toContain('createHbusXdtFacadeWrite');
    expect(host).toContain('getWriteTarget: () => undefined');
  });

  it('copies frozen binding through Codex ALS and Pi liziCtx', () => {
    expect(codexEnv).toContain('...(active.memoryBinding ? { memoryBinding: active.memoryBinding } : {})');
    expect(codexEnv).toContain('preparedMemorySessionId: active.preparedMemorySessionId');
    expect(piEnv).toContain('...(sessionCtx?.memoryBinding ? { memoryBinding: sessionCtx.memoryBinding } : {})');
    expect(piEnv).toContain('preparedMemorySessionId: sessionCtx.preparedMemorySessionId');
  });

  it('does not defer ordinary plugin gate for xdt/disabled empty-workdir sessions', () => {
    expect(providers).toContain('&& !ctx.memoryBinding');
    expect(providers).toContain('&& !ctx.preparedMemorySessionId');
  });
});
