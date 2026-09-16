/**
 * cindy_memory 三路分流：第 1 路无 binding 仍走 manager；第 2 路 frozen；
 * 第 3 路 disabled；假切流（accessor undefined / 空 workdir / xdt write）必须红。
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_MEMORY_INDEX,
  EMPTY_MEMORY_INDEX_DIGEST,
  prepareMemorySession,
  type PreparedMemorySession,
  type XdtMemoryBindingV1,
} from '@cindy/maker-core';

import { createLiziMcpProviders } from '../providers.js';
import { classifyMemoryLane } from '../memory/resolve-store.js';
import { resolveLiziMcpSessionContext, runWithLiziMcpSessionContext } from '../session-context.js';
import type { LiziMcpSessionContext } from '../types.js';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const REGISTRATION = '22222222-2222-4222-8222-222222222222';
const SESSION_INSTANCE = '33333333-3333-4333-8333-333333333333';
const PREPARED_ID = '44444444-4444-4444-8444-444444444444';

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content[0];
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function tools(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    }
  )._registeredTools;
}

function fixtureBinding(): XdtMemoryBindingV1 {
  return {
    schemaVersion: 1,
    ownerScopeFingerprint: HEX_A,
    ownerEpoch: 'epoch-1',
    configGeneration: 'cfg-1',
    registryGeneration: 'reg-1',
    bindingDigest: HEX_A,
    enabled: true,
    provider: 'xdt',
    canonicalWorkspaceId: WORKSPACE,
    serverRegistrationId: REGISTRATION,
    serverRegistrationGeneration: 'gen-1',
    serverRegistrationDigest: HEX_B,
  };
}

function markedMemory() {
  return {
    markXdtReadOnlyScope() {},
  };
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureIndexSource(seed = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-xdt-lanes-'));
  temps.push(root);
  const dataRoot = path.join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  if (seed) {
    const id = 'fixture';
    const directory = path.join(dataRoot, 'records', WORKSPACE, id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${id}.json`),
      `${JSON.stringify({
        schema_version: 2,
        id,
        key: `${WORKSPACE}/${id}`,
        title: 'Fixture',
        description: 'isolated fixture record',
        content: 'fixture body',
        kind: 'project',
        scope: 'workspace',
        workspace: WORKSPACE,
        tags: [],
        source_harness: 'cindy',
        source_ref: null,
        archived: false,
        archive_reason: null,
        updated_at: '2026-09-16T00:00:00.000Z',
        device: 'fixture',
        parent_revision: null,
        operation_id: randomUUID(),
        request_digest: HEX_B,
      }, null, 2)}\n`,
      'utf8',
    );
  }
  return { repoRoot: root, dataRoot, workspace: WORKSPACE };
}

async function preparedSession(seed = true): Promise<PreparedMemorySession> {
  return prepareMemorySession({
    agentKind: 'claude-code',
    sessionInstanceId: SESSION_INSTANCE,
    binding: fixtureBinding(),
    isolatedStanzaPresent: true,
    preparedMemorySessionId: PREPARED_ID,
    nativeSetResult: { effective: 'immediate' },
    nativeObservedStatus: { enabled: false, source: 'host-runtime' },
    indexSource: await fixtureIndexSource(seed),
    xdtReadOnlyScope: '/tmp/xdt-fixture-repo',
    makerMemory: markedMemory(),
  });
}

describe('classifyMemoryLane', () => {
  it('treats ctx without memoryBinding as internal, not disabled', () => {
    expect(classifyMemoryLane({ agentKind: 'claude-code', workingDir: '/repo' })).toBe('internal');
    expect(classifyMemoryLane(undefined)).toBe('internal');
  });

  it('treats requested xdt without UUID / incomplete binding as disabled', () => {
    expect(
      classifyMemoryLane({
        agentKind: 'claude-code',
        workingDir: '/repo',
        memoryProviderRequested: 'xdt',
      }),
    ).toBe('disabled');
  });

  it('treats preparedMemorySessionId without a complete Xdt binding as disabled, not xdt', () => {
    expect(
      classifyMemoryLane({
        agentKind: 'claude-code',
        workingDir: '/tmp/xdt-fixture-repo',
        preparedMemorySessionId: PREPARED_ID,
      }),
    ).toBe('disabled');
    expect(
      classifyMemoryLane({
        agentKind: 'claude-code',
        workingDir: '/tmp/xdt-fixture-repo',
        preparedMemorySessionId: PREPARED_ID,
        memoryBinding: { provider: 'xdt' } as never,
      }),
    ).toBe('disabled');
  });
});

describe('cindy_memory three lanes', () => {
  it('keeps internal cindy_memory working when ctx has no binding field', async () => {
    const getStore = vi.fn(async () => ({ list: async () => [] }));
    const provider = createLiziMcpProviders({
      memory: { getManager: () => ({ isEnabled: () => true, getStore }) as never },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory missing');

    const cfg = provider.toClaudeSdkConfig({
      agentKind: 'claude-code',
      workingDir: '/claude-repo',
      vendorOptions: {},
    }) as { instance: unknown };

    const result = await tools(cfg.instance).call_tool.handler({ name: 'memory_list', args: {} });
    expect(parse(result as never)).toMatchObject({ ok: true, data: [] });
    expect(getStore).toHaveBeenCalled();
  });

  it('reads the frozen snapshot on xdt binding and forbids write/review', async () => {
    const prepared = await preparedSession();
    const getStore = vi.fn(async () => {
      throw new Error('internal store must not be used on xdt lane');
    });
    const provider = createLiziMcpProviders({
      memory: {
        getManager: () => ({ isEnabled: () => true, getStore }) as never,
        getPreparedMemorySession: (id) => (id === PREPARED_ID ? prepared : undefined),
      },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory missing');

    const ctx: LiziMcpSessionContext = {
      agentKind: 'claude-code',
      workingDir: '/tmp/xdt-fixture-repo',
      vendorOptions: {},
      memoryBinding: prepared.binding,
      preparedMemorySessionId: PREPARED_ID,
    };
    const cfg = provider.toClaudeSdkConfig(ctx) as { instance: unknown };
    const listed = await tools(cfg.instance).call_tool.handler({ name: 'memory_list', args: {} });
    expect(parse(listed as never)).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ filename: 'project_fixture.md' })],
    });
    expect(getStore).not.toHaveBeenCalled();

    const written = await tools(cfg.instance).call_tool.handler({
      name: 'memory_write',
      args: {
        type: 'project',
        name: 'should-fail',
        title: 'no',
        description: 'must not land on internal store',
        body: 'nope',
      },
    });
    expect(parse(written as never)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });

    const reviewed = await tools(cfg.instance).call_tool.handler({ name: 'memory_review', args: {} });
    expect(parse(reviewed as never)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
  });

  it('returns MAKER_MEMORY_NOT_READY when xdt accessor is undefined', async () => {
    const getStore = vi.fn(async () => ({ list: async () => [] }));
    const provider = createLiziMcpProviders({
      memory: {
        getManager: () => ({ isEnabled: () => true, getStore }) as never,
        getPreparedMemorySession: () => undefined,
      },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory missing');
    const ctx: LiziMcpSessionContext = {
      agentKind: 'codex',
      workingDir: '/tmp/xdt-fixture-repo',
      vendorOptions: {},
      memoryBinding: fixtureBinding(),
      preparedMemorySessionId: PREPARED_ID,
    };
    const cfg = provider.toClaudeSdkConfig(ctx) as { instance: unknown };
    const result = await tools(cfg.instance).call_tool.handler({ name: 'memory_list', args: {} });
    expect(parse(result as never)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
    expect(getStore).not.toHaveBeenCalled();
  });

  it('returns MAKER_MEMORY_NOT_READY when xdt workdir is empty (no deps.workdir fallback)', async () => {
    const prepared = await preparedSession();
    const getStore = vi.fn(async () => ({ list: async () => [] }));
    const provider = createLiziMcpProviders({
      memory: {
        getManager: () => ({ isEnabled: () => true, getStore }) as never,
        getPreparedMemorySession: () => prepared,
      },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider) throw new Error('cindy_memory missing');
    const factoryCtx: LiziMcpSessionContext = {
      agentKind: 'codex',
      workingDir: '',
      vendorOptions: {},
    };
    const cfg = provider.toClaudeSdkConfig(factoryCtx) as { instance: unknown };
    const result = await runWithLiziMcpSessionContext(
      {
        agentKind: 'codex',
        workingDir: '',
        vendorOptions: {},
        memoryBinding: prepared.binding,
        preparedMemorySessionId: PREPARED_ID,
      },
      () => tools(cfg.instance).call_tool.handler({ name: 'memory_list', args: {} }),
    );
    expect(parse(result as never)).toMatchObject({ ok: false, code: 'MAKER_MEMORY_NOT_READY' });
    expect(getStore).not.toHaveBeenCalled();
  });

  it('strips frozen binding when the authoritative accessor cannot resolve a session', () => {
    const captured: LiziMcpSessionContext = {
      agentKind: 'codex',
      workingDir: '/tmp/xdt-fixture-repo',
      sessionId: 'captured-session',
      memoryBinding: fixtureBinding(),
      preparedMemorySessionId: PREPARED_ID,
      memoryProviderRequested: 'xdt',
      getSessionContext: () => undefined,
    };
    const stripped = resolveLiziMcpSessionContext(captured);
    expect(stripped.workingDir).toBe('');
    expect(stripped.memoryBinding).toBeUndefined();
    expect(stripped.preparedMemorySessionId).toBeUndefined();
    expect(stripped.memoryProviderRequested).toBeUndefined();
  });

  it('does not enable cindy_memory for disabled / requested-xdt-without-uuid sessions', () => {
    const provider = createLiziMcpProviders({
      memory: { getManager: () => ({ isEnabled: () => true }) as never },
    }).find((p) => p.name === 'cindy_memory');
    if (!provider?.isEnabled) throw new Error('cindy_memory missing');
    expect(
      provider.isEnabled({
        agentKind: 'claude-code',
        workingDir: '/repo',
        memoryProviderRequested: 'xdt',
      }),
    ).toBe(false);
  });
});

describe('empty golden digest is not rebuilt from search/get', () => {
  it('keeps the Host empty join digest', () => {
    expect(createHash('sha256').update(EMPTY_MEMORY_INDEX, 'utf8').digest('hex')).toBe(
      EMPTY_MEMORY_INDEX_DIGEST,
    );
  });
});
