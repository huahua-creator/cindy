/**
 * Codex xdt cindy_memory create/update：无 Host item.id slot 时在 handleRequest
 * 前拒绝；有 slot 才进 MCP。internal lane 仍可进 MCP。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  peekCodexCindyMemoryWriteSlot,
  rememberCodexCindyMemoryWriteSlot,
  resetCodexCindyMemoryWriteSlotsForTest,
  type Logger,
} from '@cindy/maker-core';

import { startCodexHttpBridge, type CodexHttpBridge } from '../codexHttpBridge.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const WRITE_ARGS = {
  type: 'project',
  name: 'codex-readonly-probe',
  title: 'probe',
  description: 'must not reach handleRequest on xdt',
  body: 'nope',
};
const SLOT_INSTANCE = '33333333-3333-4333-8333-333333333333';
const SLOT_SESSION = 'session-xdt';
const SLOT_ITEM = 'item-codex-1';

function mcpUrl(bridge: CodexHttpBridge, serverName: string, instanceId?: string): string {
  const base = bridge.url(serverName);
  return instanceId ? `${base}?instance=${encodeURIComponent(instanceId)}` : base;
}

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function xdtBinding() {
  return {
    schemaVersion: 1 as const,
    ownerScopeFingerprint: HEX_A,
    ownerEpoch: 'epoch-1',
    configGeneration: 'cfg-1',
    registryGeneration: 'reg-1',
    bindingDigest: HEX_A,
    enabled: true as const,
    provider: 'xdt' as const,
    canonicalWorkspaceId: WORKSPACE,
    serverRegistrationId: '22222222-2222-4222-8222-222222222222',
    serverRegistrationGeneration: 'gen-1',
    serverRegistrationDigest: HEX_B,
  };
}

async function readRpcResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const eventPayload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(eventPayload ?? text);
}

describe('Codex cindy_memory writes require a Host item.id slot', () => {
  let bridge: CodexHttpBridge | null = null;

  afterEach(async () => {
    resetCodexCindyMemoryWriteSlotsForTest();
    await bridge?.shutdown();
    bridge = null;
  });

  it('Codex 本刀预期只读：xdt memory_write create 在 handleRequest 前红且不进 MCP handler', async () => {
    const reached = vi.fn();
    bridge = await startCodexHttpBridge({
      serverFactories: {
        cindy_memory: () => {
          const server = new McpServer({ name: 'cindy_memory', version: '1.0.0' });
          server.tool(
            'call_tool',
            'spy',
            {
              name: z.string(),
              args: z.record(z.string(), z.unknown()),
            },
            async (args) => {
              reached(args);
              return { content: [{ type: 'text', text: JSON.stringify({ ok: true, leaked: true }) }] };
            },
          );
          return server;
        },
      },
      logger: noopLogger(),
    });
    const current = bridge;
    current.registerThreadContext('thread-xdt', {
      agentKind: 'codex',
      sessionId: 'session-xdt',
      sessionInstanceId: SLOT_INSTANCE,
      workingDir: '/tmp/xdt-fixture-repo',
      memoryBinding: xdtBinding(),
      preparedMemorySessionId: '44444444-4444-4444-8444-444444444444',
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${current.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const init = await fetch(current.url('cindy_memory'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'codex-readonly-test', version: '1' },
        },
      }),
    });
    expect(init.status).toBe(200);
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.text();

    const write = await fetch(current.url('cindy_memory'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: { name: 'memory_write', args: WRITE_ARGS },
          _meta: { threadId: 'thread-xdt' },
        },
      }),
    });
    expect(write.status).toBe(200);
    const payload = await readRpcResponse(write) as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain('MAKER_MEMORY_NOT_READY');
    expect(payload.result?.content?.[0]?.text).not.toContain('leaked');
    expect(reached).not.toHaveBeenCalled();
  });

  it('Codex 有 Host item.id slot 时 xdt memory_write create 进入 handleRequest', async () => {
    const reached = vi.fn();
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SLOT_SESSION,
      sessionInstanceId: SLOT_INSTANCE,
      item: {
        id: SLOT_ITEM,
        type: 'mcpToolCall',
        server: 'cindy_memory',
        tool: 'call_tool',
        arguments: { name: 'memory_write', args: { mode: 'create' } },
      },
    });
    expect(peekCodexCindyMemoryWriteSlot(SLOT_INSTANCE)?.itemId).toBe(SLOT_ITEM);
    bridge = await startCodexHttpBridge({
      serverFactories: {
        cindy_memory: () => {
          const server = new McpServer({ name: 'cindy_memory', version: '1.0.0' });
          server.tool(
            'call_tool',
            'spy',
            {
              name: z.string(),
              args: z.record(z.string(), z.unknown()),
            },
            async (args) => {
              reached(args);
              return { content: [{ type: 'text', text: JSON.stringify({ ok: true, slotted: true }) }] };
            },
          );
          return server;
        },
      },
      logger: noopLogger(),
    });
    const current = bridge;
    current.registerThreadContext('thread-xdt-slot', {
      agentKind: 'codex',
      sessionId: SLOT_SESSION,
      sessionInstanceId: SLOT_INSTANCE,
      workingDir: '/tmp/xdt-fixture-repo',
      memoryBinding: xdtBinding(),
      preparedMemorySessionId: '44444444-4444-4444-8444-444444444444',
    });
    const headers: Record<string, string> = {
      authorization: `Bearer ${current.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const init = await fetch(mcpUrl(current, 'cindy_memory', SLOT_INSTANCE), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'codex-slot-test', version: '1' },
        },
      }),
    });
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.text();
    const write = await fetch(mcpUrl(current, 'cindy_memory', SLOT_INSTANCE), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: { name: 'memory_write', args: WRITE_ARGS },
          _meta: { threadId: 'thread-xdt-slot' },
        },
      }),
    });
    expect(write.status).toBe(200);
    expect(await readRpcResponse(write)).toMatchObject({
      result: { content: [{ text: expect.stringContaining('"slotted":true') }] },
    });
    expect(reached).toHaveBeenCalled();
  });

  it('Codex 本刀预期只读：internal memory_write 仍进入 handleRequest', async () => {
    const reached = vi.fn();
    bridge = await startCodexHttpBridge({
      serverFactories: {
        cindy_memory: () => {
          const server = new McpServer({ name: 'cindy_memory', version: '1.0.0' });
          server.tool(
            'call_tool',
            'spy',
            {
              name: z.string(),
              args: z.record(z.string(), z.unknown()),
            },
            async (args) => {
              reached(args);
              return { content: [{ type: 'text', text: JSON.stringify({ ok: true, lane: 'internal' }) }] };
            },
          );
          return server;
        },
      },
      logger: noopLogger(),
    });
    const current = bridge;
    current.registerThreadContext('thread-internal', {
      agentKind: 'codex',
      sessionId: 'session-internal',
      workingDir: '/repo',
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${current.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const init = await fetch(current.url('cindy_memory'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'codex-internal-test', version: '1' },
        },
      }),
    });
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.text();

    const write = await fetch(current.url('cindy_memory'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: { name: 'memory_write', args: WRITE_ARGS },
          _meta: { threadId: 'thread-internal' },
        },
      }),
    });
    expect(write.status).toBe(200);
    expect(await readRpcResponse(write)).toMatchObject({
      result: { content: [{ text: expect.stringContaining('"lane":"internal"') }] },
    });
    expect(reached).toHaveBeenCalled();
  });
});
