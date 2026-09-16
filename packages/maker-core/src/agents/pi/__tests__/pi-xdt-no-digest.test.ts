/**
 * 第 2 路 fixture Pi 注入 FrozenIndexSnapshotV1.content，且不得注册 digest callback。
 * 第 1 路 Pi 仍不调用 getIndex()（origin/main 原语义，本刀不得改）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  onEvent: null as ((event: unknown) => void) | null,
}));

vi.mock('../transport.js', () => ({
  createPiStdioTransport: (opts: { onProcessSpawned?: (pid: number) => void | (() => void) }) => {
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock('../rpc-client.js', () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: { onEvent: (event: unknown) => void }) {
      captured.onEvent = opts.onEvent;
    }
    async request(cmd: { type: string }): Promise<{ success: boolean; data?: unknown }> {
      if (cmd.type === 'get_state') {
        return { success: true, data: { sessionFile: '/mock/s.jsonl', model: { contextWindow: 200000 } } };
      }
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      this.isClosed = true;
    }
  },
}));

import { PiAgent } from '../index.js';
import type { AgentDeps } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import { prepareMemorySession } from '../../../memory/xdt-prepare.js';
import type { XdtMemoryBindingV1 } from '../../../memory/xdt-binding.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function binding(): XdtMemoryBindingV1 {
  return {
    schemaVersion: 1,
    ownerScopeFingerprint: HEX_A,
    ownerEpoch: 'epoch-1',
    configGeneration: 'cfg-1',
    registryGeneration: 'reg-1',
    bindingDigest: HEX_A,
    enabled: true,
    provider: 'xdt',
    canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
    serverRegistrationId: '22222222-2222-4222-8222-222222222222',
    serverRegistrationGeneration: 'gen-1',
    serverRegistrationDigest: HEX_B,
  };
}

function emptyIndexSource() {
  const root = mkdtempSync(path.join(tmpdir(), 'cindy-xdt-pi-index-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  return {
    repoRoot: root,
    dataRoot: path.join(root, 'data'),
    workspace: '11111111-1111-4111-8111-111111111111',
  };
}

describe('PiAgent lane-2 fixture injects frozen index; lane-1 Pi still does not', () => {
  let agentHome = '';
  let cwd = '';
  let indexRoot = '';
  let writeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    captured.onEvent = null;
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-xdt-home-'));
    cwd = mkdtempSync(path.join(tmpdir(), 'pi-xdt-cwd-'));
    writeMock = vi.fn(async () => ({ ok: true, filename: 'digest_x.md' }));
  });
  afterEach(() => {
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (indexRoot) rmSync(indexRoot, { recursive: true, force: true });
  });

  it('does not write a compaction digest on xdt prepared sessions', async () => {
    const indexSource = emptyIndexSource();
    indexRoot = indexSource.repoRoot;
    const prepared = await prepareMemorySession({
      agentKind: 'pi',
      sessionInstanceId: '33333333-3333-4333-8333-333333333333',
      binding: binding(),
      isolatedStanzaPresent: true,
      nativeSetResult: { effective: 'immediate' },
      nativeObservedStatus: { enabled: false, source: 'host-runtime' },
      indexSource,
      xdtReadOnlyScope: cwd,
      makerMemory: { markXdtReadOnlyScope() {} },
    });
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9', makerMemoryEnabled: true },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{ id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
      makerMemory: { write: writeMock, resetDigests: vi.fn() } as never,
    };
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'xdt-pi',
      workingDir: cwd,
      model: 'm',
      makerMemoryEnabled: true,
      preparedMemorySession: prepared,
    });
    captured.onEvent!({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'should not persist on xdt', estimatedTokensAfter: 1 },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(writeMock).not.toHaveBeenCalled();
    await handle.close();
  });

  it('does not inject frozen index for lane-1 Pi (no preparedMemorySession, still no getIndex)', async () => {
    const getIndex = vi.fn(async () => {
      throw new Error('lane-1 Pi must not call getIndex');
    });
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 't', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { endpoint: 'http://127.0.0.1:9', makerMemoryEnabled: true },
      binaryPath: path.join(agentHome, 'pi'),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{ id: 'm', displayName: 'M', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiGatewayModelApi: () => 'openai-responses',
      resolvePiAgentHome: () => agentHome,
      makerMemory: {
        write: writeMock,
        resetDigests: vi.fn(),
        getStore: async () => ({ getIndex }),
      } as never,
    };
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'internal-pi',
      workingDir: cwd,
      model: 'm',
      makerMemoryEnabled: true,
    });
    expect(getIndex).not.toHaveBeenCalled();
    captured.onEvent!({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'lane-1 digest is allowed', estimatedTokensAfter: 1 },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(writeMock).toHaveBeenCalled();
    await handle.close();
  });
});
