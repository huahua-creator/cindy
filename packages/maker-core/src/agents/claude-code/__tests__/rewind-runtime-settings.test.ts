/**
 * Rewind 窗口期运行时切换（setModel / setEffort / setFastMode / setPermissionMode /
 * setPlanMode）回归测试。
 *
 * 背景（2026-07-07 release 实踩）：commitRewindFiles 会 close 旧 SDK Query 并设
 * pendingRewindTo，新 Query 延迟到下一次 send 才重建。这个窗口里旧实现直接对已
 * close 的 q 发 control request，SDK 抛 "ProcessTransport is not ready for writing"，
 * renderer 端表现为"设置切换失败,未生效" toast——用户 rewind 后切模型/切来源必现。
 *
 * 覆盖:
 *  - rewind 窗口内 setModel / setEffort / setFastMode / setPermissionMode 不碰旧 q、
 *    不抛错，只更新闭包状态
 *  - 下一次 send 重建 Query 时，新 model / permissionMode 自然带上（buildQuery 读闭包最新值）
 *  - rewind 窗口内 setPlanMode 武装计划模式同样不抛，重建后以 plan 档起步
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { ModelDescriptor } from '../../../types/capabilities.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

const imageResizerMock = vi.hoisted(() => ({
  process: vi.fn(async (p: string) => p),
  validateBuffer: vi.fn(async () => true),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('../../shared/image-resizer.js', () => ({
  getDefaultImageResizer: () => imageResizerMock,
}));

import { ClaudeCodeAgent, setClaudeSupportedModelsListener } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;

const TEST_MODELS: ModelDescriptor[] = [
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
  },
];

const PROVIDER_372K: ModelDescriptor = {
  id: 'gpt-5.6-terra',
  displayName: 'GPT 5.6 Terra',
  contextWindow: 372_000,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
};

const PROVIDER_272K: ModelDescriptor = {
  id: 'gpt-5.6-luna',
  displayName: 'GPT 5.6 Luna',
  contextWindow: 272_000,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
};

type TestPreToolUseHook = (...args: never[]) => Promise<unknown>;
type TestHookSet = {
  PreToolUse?: Array<{ hooks: TestPreToolUseHook[] }>;
};

async function findDenyingPreToolUseHook(
  hooks: TestHookSet | undefined,
  input: Record<string, unknown>,
): Promise<{ hook: TestPreToolUseHook; result: unknown }> {
  for (const matcher of hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const result = await hook(
        input as never,
        undefined as never,
        { signal: new AbortController().signal } as never,
      );
      if (
        (result as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision === 'deny'
      ) return { hook, result };
    }
  }
  throw new Error('expected a denying PreToolUse hook');
}

async function anyPreToolUseHookDenies(
  hooks: TestHookSet | undefined,
  input: Record<string, unknown>,
): Promise<boolean> {
  for (const matcher of hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const result = await hook(
        input as never,
        undefined as never,
        { signal: new AbortController().signal } as never,
      );
      if (
        (result as { hookSpecificOutput?: { permissionDecision?: string } })
          .hookSpecificOutput?.permissionDecision === 'deny'
      ) return true;
    }
  }
  return false;
}

function createNoopLogger(onInfo?: (message: string) => void): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info(message: string) {
      onInfo?.(message);
    },
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(
  runtimeConfig: AgentDeps['runtimeConfig'] = {},
  onInfo?: (message: string) => void,
): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };

  return {
    auth,
    runtimeConfig,
    binaryPath: process.execPath,
    logger: createNoopLogger(onInfo),
  };
}

/** 可控挂起流：默认不吐消息；测试可按需 emit SDK 消息喂给 forward loop。 */
function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  let pendingError: unknown;
  let ended = false;

  function pump(): void {
    if (!waiter) return;
    if (pendingError !== undefined) {
      const w = waiter;
      waiter = null;
      const err = pendingError;
      pendingError = undefined;
      w.reject(err);
      return;
    }
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
      return;
    }
    if (ended) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: true, value: undefined });
    }
  }

  return {
    emit(msg: unknown): void {
      items.push(msg);
      pump();
    },
    fail(error: unknown): void {
      pendingError = error;
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

/**
 * 模拟真实 SDK transport 语义的 fake Query：close() 之后任何 control request
 * 都抛 "ProcessTransport is not ready for writing"——这正是线上事故的报错形态。
 */
function createFakeQuery(stream = createControlledStream()) {
  let closed = false;
  const assertWritable = () => {
    if (closed) throw new Error('ProcessTransport is not ready for writing');
  };
  return {
    stream,
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => assertWritable()),
    setModel: vi.fn(async (_model: string) => assertWritable()),
    applyFlagSettings: vi.fn(async () => assertWritable()),
    supportedAgents: vi.fn(async () => [
      { name: 'general-purpose', description: 'inherits the parent model' },
      { name: 'inherited-worker', description: 'explicit inherit', model: 'inherit' },
      { name: 'Explore', description: 'native built-in', model: 'haiku' },
      { name: 'Plan', description: 'native built-in', model: 'sonnet' },
    ]),
    supportedModels: vi.fn(async () => []),
    interrupt: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(() => {
      closed = true;
    }),
    rewindFiles: vi.fn(async () => ({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-rewind-'));
  tempDirs.push(dir);
  return dir;
}

async function startRewindableSession(
  options: {
    autoCompactThresholdPct?: number;
    idleTimeoutMs?: number;
    remoteHostId?: string;
    model?: string;
    subagentModel?: string;
    systemPrompt?: string;
    additionalModels?: ModelDescriptor[];
    localQueries?: ReturnType<typeof createFakeQuery>[];
    remoteQueries?: ReturnType<typeof createFakeQuery>[];
    resolveVerifiedContextWindow?: (
      providerId: string | null | undefined,
      modelId: string,
    ) => number | null;
    shouldHandoffAfterContextAssessment?: (tokens: number, window: number) => boolean;
  } = {},
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  // 默认关掉 upstream-idle watchdog, 避免测试进程挂 30min 定时器; 单个用例可覆盖成短阈值。
  process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = String(options.idleTimeoutMs ?? 0);
  const workingDir = await makeTempDir();

  const firstQuery = options.remoteQueries?.[0] ?? options.localQueries?.[0] ?? createFakeQuery();
  let localQueryIndex = 0;
  sdkMock.query.mockImplementation(() => options.localQueries?.[localQueryIndex++] ?? firstQuery);
  const remoteStartParams: Array<Record<string, unknown>> = [];
  let remoteQueryIndex = 0;
  const remoteCcQueryFactory = options.remoteHostId
    ? (async (opts: { startParams: Record<string, unknown> }) => {
        remoteStartParams.push(opts.startParams);
        return (options.remoteQueries?.[remoteQueryIndex++] ?? firstQuery) as never;
      })
    : undefined;
  const infoCalls: string[] = [];

  const agent = new ClaudeCodeAgent({
    ...createDeps(
      {
        autoCompactThresholdPct: options.autoCompactThresholdPct,
        shouldHandoffAfterContextAssessment: options.shouldHandoffAfterContextAssessment,
        subagentModel: options.subagentModel,
        systemPrompt: options.systemPrompt,
      },
      (message) => {
        infoCalls.push(message);
      },
    ),
    capabilityAdditions: {
      availableModels: [...TEST_MODELS, ...(options.additionalModels ?? [])],
    },
    ...(options.resolveVerifiedContextWindow
      ? { resolveVerifiedContextWindow: options.resolveVerifiedContextWindow }
      : {}),
    ...(remoteCcQueryFactory ? { remoteCcQueryFactory } : {}),
  });
  const handle = await agent.startSession({
    sessionId: 'session-rewind',
    model: options.model ?? 'claude-opus-4-6',
    workingDir,
    permissionMode: 'acceptEdits',
    ...(options.remoteHostId ? { remoteHostId: options.remoteHostId } : {}),
  });

  return { agent, handle, firstQuery, infoCalls, remoteStartParams };
}

afterEach(async () => {
  setClaudeSupportedModelsListener(null);
  vi.useRealTimers();
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  imageResizerMock.process.mockReset();
  imageResizerMock.process.mockImplementation(async (p: string) => p);
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  if (originalIdleTimeout === undefined) {
    delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
  } else {
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('ClaudeCodeAgent runtime settings during rewind window', () => {
  it('keeps the selected and catalog Claude wire models available for a live model switch', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { settings?: { availableModels?: string[] } };
    };
    expect(startArgs.options.settings?.availableModels).toEqual([
      'claude-opus-4-6[1m]',
      'claude-sonnet-5',
    ]);

    await handle.setModel?.('claude-sonnet-5');
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledWith({
      availableModels: ['claude-opus-4-6[1m]', 'claude-sonnet-5'],
    });
    expect(firstQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(firstQuery.applyFlagSettings.mock.invocationCallOrder[0]).toBeLessThan(
      firstQuery.setModel.mock.invocationCallOrder[0],
    );

    await handle.close();
  });

  it('sets the current verified provider window on the initial Query env', async () => {
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K],
    });

    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { env?: Record<string, string> };
    };
    expect(startArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    expect(handle.getUsageSnapshot().contextWindow).toBe(372_000);
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it.each([
    ['provider/glm-5.2[1m]', 'provider/glm-5.2[1m]', '0', 1_000_000],
    ['provider/glm-5.2', 'provider/glm-5.2', '0', 200_000],
  ] as const)(
    'keeps exact catalog product %s isolated from its suffix sibling',
    async (model, expectedWire, expectedEnv, expectedWindow) => {
      const base: ModelDescriptor = {
        id: 'provider/glm-5.2',
        displayName: 'GLM base',
        contextWindow: 200_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      };
      const oneMillion: ModelDescriptor = {
        ...base,
        id: 'provider/glm-5.2[1m]',
        displayName: 'GLM 1M product',
        contextWindow: 1_000_000,
      };
      const { handle } = await startRewindableSession({
        model,
        additionalModels: [base, oneMillion],
        resolveVerifiedContextWindow: (_providerId, modelId) => {
          if (modelId === oneMillion.id) return oneMillion.contextWindow;
          if (modelId === base.id) return base.contextWindow;
          return null;
        },
      });
      const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
        options: { model?: string; env?: Record<string, string> };
      };
      expect(startArgs.options.model).toBe(expectedWire);
      expect(startArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(expectedEnv);
      expect(handle.getUsageSnapshot().contextWindow).toBe(expectedWindow);
      await handle.close();
    },
  );

  it.each([null, 500_000] as const)(
    'rejects an exact [1m] main product whose provider window is %s',
    async (exactWindow) => {
      const exactProduct: ModelDescriptor = {
        id: 'provider/exact-product[1m]',
        displayName: 'Exact 1M product',
        contextWindow: 1_000_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      };
      await expect(startRewindableSession({
        model: exactProduct.id,
        additionalModels: [exactProduct],
        resolveVerifiedContextWindow: (_providerId, modelId) =>
          modelId === exactProduct.id ? exactWindow : null,
      })).rejects.toThrow('[CLAUDE_CONTEXT_WINDOW_MODEL_UNSAFE]');
      expect(sdkMock.query).not.toHaveBeenCalled();
    },
  );

  it.each([null, 500_000] as const)(
    'rejects switching to an exact [1m] product whose provider window is %s',
    async (exactWindow) => {
      const exactProduct: ModelDescriptor = {
        id: 'provider/exact-switch[1m]',
        displayName: 'Exact switch product',
        contextWindow: 1_000_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      };
      const { handle, firstQuery } = await startRewindableSession({
        model: PROVIDER_372K.id,
        additionalModels: [PROVIDER_372K, exactProduct],
        resolveVerifiedContextWindow: (_providerId, modelId) => {
          if (modelId === PROVIDER_372K.id) return PROVIDER_372K.contextWindow;
          if (modelId === exactProduct.id) return exactWindow;
          return null;
        },
      });
      await expect(handle.setModel?.(exactProduct.id)).rejects.toThrow(
        '[CLAUDE_CONTEXT_WINDOW_MODEL_UNSAFE]',
      );
      expect(handle.model).toBe(PROVIDER_372K.id);
      expect(firstQuery.setModel).not.toHaveBeenCalled();
      await handle.close();
    },
  );

  it('denies an unverified exact [1m] subagent product without routing to its sibling', async () => {
    const exactProduct: ModelDescriptor = {
      id: 'provider/exact-worker[1m]',
      displayName: 'Exact worker product',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    };
    const first = createFakeQuery();
    first.supportedAgents.mockResolvedValue([
      { name: 'exact-worker', description: 'exact product', model: exactProduct.id },
    ]);
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K, exactProduct],
      localQueries: [first],
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === PROVIDER_372K.id ? PROVIDER_372K.contextWindow : null,
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { settings?: { availableModels?: string[] }; hooks?: TestHookSet };
    };
    expect(startArgs.options.settings?.availableModels).toContain(exactProduct.id);
    expect(startArgs.options.settings?.availableModels).not.toContain('provider/exact-worker');
    expect(await anyPreToolUseHookDenies(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'exact-worker' },
    })).toBe(true);
    await handle.close();
  });

  it('rebuilds before input when supportedAgents exposes a smaller provider model', async () => {
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const inventory = [
      { name: 'general-purpose', description: 'inherits' },
      { name: 'small-plugin', description: 'plugin worker', model: 'provider/small' },
    ];
    first.supportedAgents.mockResolvedValue(inventory);
    replacement.supportedAgents.mockResolvedValue(inventory);

    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      systemPrompt: 'stable prefix across inventory correction',
      additionalModels: [
        PROVIDER_372K,
        {
          id: 'provider/small',
          displayName: 'Small provider model',
          contextWindow: 128_000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
        },
      ],
      localQueries: [first, replacement],
    });

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.send).not.toHaveBeenCalled();
    expect(replacement.send).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const initialArgs = sdkMock.query.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect((initialArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('372000');
    expect((replacementArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('128000');
    expect(replacementArgs.options.systemPrompt).toEqual(initialArgs.options.systemPrompt);
    expect(handle.getUsageSnapshot().contextWindow).toBe(128_000);

    await handle.close();
  });

  it('preserves a provisional candidate after close rejection and retires it before retry build', async () => {
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const inventory = [
      { name: 'general-purpose', description: 'inherits' },
      { name: 'small-plugin', description: 'plugin worker', model: 'provider/small' },
    ];
    first.supportedAgents.mockResolvedValue(inventory);
    replacement.supportedAgents.mockResolvedValue(inventory);
    first.close.mockRejectedValueOnce(new Error('provisional close not acknowledged'));

    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [
        PROVIDER_372K,
        {
          id: 'provider/small',
          displayName: 'Small provider model',
          contextWindow: 128_000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
        },
      ],
      localQueries: [first, replacement],
    });

    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    const provisionalArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    expect(provisionalArgs.prompt.pending).toBe(0);

    await handle.send({ type: 'user', content: 'explicit retry after provisional close' });
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: { env?: Record<string, string> };
    };
    expect(replacementArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
    expect(replacementArgs.prompt.pending).toBe(1);
    const promptIter = replacementArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content)
      .toBe('explicit retry after provisional close');

    await handle.close();
  });

  it('keeps an initial provisional retirement tombstone when desired profile reverts during close failure', async () => {
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    let workerWindow = 128_000;
    const inventory = [
      { name: 'dynamic-worker', description: 'dynamic provider worker', model: 'provider/dynamic-worker' },
    ];
    first.supportedAgents.mockResolvedValue(inventory);
    replacement.supportedAgents.mockResolvedValue(inventory);
    first.close.mockImplementationOnce(async () => {
      workerWindow = 500_000;
      throw new Error('initial provisional close ACK lost');
    });

    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K],
      localQueries: [first, replacement],
      resolveVerifiedContextWindow: (_providerId, modelId) => {
        if (modelId === PROVIDER_372K.id) return PROVIDER_372K.contextWindow;
        if (modelId === 'provider/dynamic-worker') return workerWindow;
        return null;
      },
    });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    await handle.send({ type: 'user', content: 'retry reverted initial profile' });
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: { env?: Record<string, string> };
    };
    expect(replacementArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    expect(replacementArgs.prompt.pending).toBe(1);
    await handle.close();
  });

  it('checks supportedAgents even when a native 1m main model provisionally uses env zero', async () => {
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const inventory = [
      { name: 'general-purpose', description: 'inherits' },
      { name: 'small-plugin', description: 'plugin worker', model: 'provider/small' },
    ];
    first.supportedAgents.mockResolvedValue(inventory);
    replacement.supportedAgents.mockResolvedValue(inventory);

    const { handle } = await startRewindableSession({
      additionalModels: [{
        id: 'provider/small',
        displayName: 'Small provider model',
        contextWindow: 128_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      }],
      localQueries: [first, replacement],
    });

    expect(first.supportedAgents).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.send).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const initialArgs = sdkMock.query.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect((initialArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('0');
    expect((replacementArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('128000');
    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);

    await handle.close();
  });

  it.each(['provider/not-in-catalog', 'provider/not-in-catalog[1m]', 'gpt-5.5', 'deepseek-v4'])(
    'keeps the main Query usable but denies an unverified custom agent model %s',
    async (unsafeModel) => {
    const first = createFakeQuery();
    first.supportedAgents.mockResolvedValue([
      { name: 'unknown-plugin', description: 'unknown', model: unsafeModel },
    ]);

    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K],
      localQueries: [first],
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: {
        env?: Record<string, string>;
        hooks?: TestHookSet;
      };
    };
    const { result } = await findDenyingPreToolUseHook(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'unknown-plugin' },
    });
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(startArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    expect(first.close).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('denies a native-shaped custom agent whose verified provider window is below the CLI floor', async () => {
    const first = createFakeQuery();
    first.supportedAgents.mockResolvedValue([
      { name: 'claude-shaped-plugin', description: 'custom provider', model: 'claude-custom' },
    ]);
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [
        PROVIDER_372K,
        {
          id: 'claude-custom',
          displayName: 'Custom Claude-shaped model',
          contextWindow: 128_000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
        },
      ],
      localQueries: [first],
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { hooks?: TestHookSet };
    };
    const { result } = await findDenyingPreToolUseHook(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'claude-shaped-plugin' },
    });
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(first.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it('denies provider-aware custom Claude agent definitions when the base id is unverified', async () => {
    const first = createFakeQuery();
    first.supportedAgents.mockResolvedValue([
      { name: 'custom-claude', description: 'provider definition', model: 'claude-custom' },
    ]);
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K],
      localQueries: [first],
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === PROVIDER_372K.id ? PROVIDER_372K.contextWindow : null,
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { hooks?: TestHookSet };
    };
    expect(await anyPreToolUseHookDenies(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'custom-claude' },
    })).toBe(true);
    await handle.close();
  });

  it('denies a provider-aware forced custom Claude model when its base id is unverified', async () => {
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: 'claude-custom',
      additionalModels: [PROVIDER_372K],
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === PROVIDER_372K.id ? PROVIDER_372K.contextWindow : null,
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { hooks?: TestHookSet };
    };
    expect(await anyPreToolUseHookDenies(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose' },
    })).toBe(true);
    await handle.close();
  });

  it.each([
    ['inventory', 1_000_000, false],
    ['inventory', 500_000, true],
    ['forced', 1_000_000, false],
    ['forced', 500_000, true],
  ] as const)(
    '%s [1m] subagent uses the verified base-id window %i (denied=%s)',
    async (source, verifiedSubagentWindow, denied) => {
      const declaredModel = 'provider/declared[1m]';
      const first = createFakeQuery();
      if (source === 'inventory') {
        first.supportedAgents.mockResolvedValue([
          { name: 'declared-worker', description: 'wire-suffixed definition', model: declaredModel },
        ]);
      }
      const { handle } = await startRewindableSession({
        model: PROVIDER_372K.id,
        ...(source === 'forced' ? { subagentModel: declaredModel } : {}),
        additionalModels: [PROVIDER_372K],
        localQueries: [first],
        resolveVerifiedContextWindow: (_providerId, modelId) => {
          if (modelId === PROVIDER_372K.id) return PROVIDER_372K.contextWindow;
          if (modelId === 'provider/declared') return verifiedSubagentWindow;
          return null;
        },
      });
      const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
        options: { env?: Record<string, string>; hooks?: TestHookSet };
      };
      expect(await anyPreToolUseHookDenies(startArgs.options.hooks, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: source === 'forced' ? 'general-purpose' : 'declared-worker' },
      })).toBe(denied);
      expect(startArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
      await handle.close();
    },
  );

  it('rejects a native-shaped main model whose provider window is below the CLI floor', async () => {
    await expect(startRewindableSession({
      model: 'claude-custom',
      additionalModels: [{
        id: 'claude-custom',
        displayName: 'Custom Claude-shaped model',
        contextWindow: 128_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      }],
    })).rejects.toThrow('[CLAUDE_CONTEXT_WINDOW_MODEL_UNSAFE]');
    expect(sdkMock.query).not.toHaveBeenCalled();
  });

  it('uses the intrinsic 200k usage window for an unsuffixed Claude-shaped 372k provider model', async () => {
    const claudeCustom: ModelDescriptor = {
      id: 'claude-custom',
      displayName: 'Custom Claude-shaped model',
      contextWindow: 372_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    };
    const { handle } = await startRewindableSession({
      model: claudeCustom.id,
      additionalModels: [claudeCustom],
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === claudeCustom.id ? claudeCustom.contextWindow : null,
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { env?: Record<string, string>; model?: string };
    };
    expect(startArgs.options.model).toBe(claudeCustom.id);
    expect(startArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('0');
    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);
    await handle.close();
  });

  it.each(['provider/not-in-catalog', 'provider/not-in-catalog[1m]'])(
    'keeps the main Query usable but denies all subagents for unverified forced model %s',
    async (forcedModel) => {
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: forcedModel,
      additionalModels: [PROVIDER_372K],
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: {
        env?: Record<string, string>;
        hooks?: TestHookSet;
      };
    };
    const { result } = await findDenyingPreToolUseHook(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'anything', model: 'sonnet' },
    });
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(startArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('keeps the main Query usable but denies all subagents when supportedAgents is unavailable', async () => {
    const first = createFakeQuery();
    first.supportedAgents.mockRejectedValue(new Error('supportedAgents unavailable'));

    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K],
      localQueries: [first],
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { hooks?: TestHookSet };
    };
    const { result } = await findDenyingPreToolUseHook(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { model: 'sonnet' },
    });
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(first.close).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('times out a stuck supportedAgents inventory and keeps only the main Query usable', async () => {
    vi.useFakeTimers();
    const first = createFakeQuery();
    first.supportedAgents.mockImplementation(() => new Promise(() => {}));

    const starting = startRewindableSession({
      model: PROVIDER_372K.id,
      additionalModels: [PROVIDER_372K],
      localQueries: [first],
    });
    await vi.waitFor(() => expect(first.supportedAgents).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5_000);
    const { handle } = await starting;

    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { hooks?: TestHookSet };
    };
    const { result } = await findDenyingPreToolUseHook(startArgs.options.hooks, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose' },
    });
    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(sdkMock.query).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps subagents denied while a newly verified forced model needs a profile rebuild', async () => {
    let forcedWindow: number | null = null;
    const forcedModel = 'provider/dynamic-subagent';
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: forcedModel,
      additionalModels: [PROVIDER_372K],
      localQueries: [first, replacement],
      resolveVerifiedContextWindow: (_providerId, modelId) => {
        if (modelId === PROVIDER_372K.id) return 372_000;
        if (modelId === forcedModel) return forcedWindow;
        return null;
      },
    });
    const initialArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { hooks?: TestHookSet };
    };
    const agentInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'anything' },
    };
    const { hook: guard, result } = await findDenyingPreToolUseHook(
      initialArgs.options.hooks,
      agentInput,
    );
    const agentCall = [
      agentInput as never,
      undefined as never,
      { signal: new AbortController().signal } as never,
    ] as const;

    expect(result).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    forcedWindow = 128_000;
    await expect(guard(...agentCall)).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });

    await handle.send({ type: 'user', content: 'rebuild before enabling forced subagent' });
    expect(first.close).toHaveBeenCalledTimes(1);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: { env?: Record<string, string> };
    };
    expect(replacementArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
    await expect(guard(...agentCall)).resolves.toEqual({ continue: true });

    await handle.close();
  });

  it('keeps a profile-changing model switch lazy, then closes before rebuilding on send', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      subagentModel: 'claude-haiku-4-5',
      systemPrompt: 'stable cache prefix for context-profile rebuild',
      additionalModels: [PROVIDER_372K],
    });
    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);

    await handle.setModel?.(PROVIDER_372K.id);

    expect(firstQuery.setModel).not.toHaveBeenCalled();
    expect(firstQuery.close).not.toHaveBeenCalled();

    await handle.send({ type: 'user', content: 'use the wider provider window' });

    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: { env?: Record<string, string>; resume?: string; systemPrompt?: unknown };
    };
    const initialArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { systemPrompt?: unknown };
    };
    expect(rebuildArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    expect((rebuildArgs.options as { model?: string }).model).toBe(PROVIDER_372K.id);
    expect(rebuildArgs.options.systemPrompt).toEqual(initialArgs.options.systemPrompt);

    await handle.close();
  });

  it('rechecks model generation after replacement replay before accepting input', async () => {
    const aliasC: ModelDescriptor = {
      ...PROVIDER_272K,
      id: 'provider/luna-alias-c',
      displayName: 'Luna alias C',
    };
    const aliasD: ModelDescriptor = {
      ...PROVIDER_272K,
      id: 'provider/luna-alias-d',
      displayName: 'Luna alias D',
    };
    const { handle, firstQuery } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K, PROVIDER_272K, aliasC, aliasD],
    });
    await handle.setModel?.(PROVIDER_272K.id);

    const second = createFakeQuery();
    let notifyReplayStarted!: () => void;
    let releaseReplay!: () => void;
    const replayStarted = new Promise<void>((resolve) => { notifyReplayStarted = resolve; });
    const replayHold = new Promise<void>((resolve) => { releaseReplay = resolve; });
    second.setModel.mockImplementationOnce(async () => {
      notifyReplayStarted();
      await replayHold;
    });
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setModel?.(aliasC.id);
      return second;
    });

    const sendPromise = handle.send({ type: 'user', content: 'latest generation only' });
    await replayStarted;
    const postReplayDrift = replayHold.then(() => handle.setModel?.(aliasD.id));
    releaseReplay();
    await postReplayDrift;
    await sendPromise;

    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    expect(second.setModel).toHaveBeenCalledWith(aliasC.id);
    expect(second.setModel).toHaveBeenLastCalledWith(aliasD.id);
    expect(second.close).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const secondArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: Record<string, unknown>;
    };
    expect(secondArgs.options.model).toBe(PROVIDER_272K.id);
    expect(secondArgs.prompt.pending).toBe(1);
    const promptIter = secondArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('latest generation only');
    expect(handle.model).toBe(aliasD.id);

    await handle.close();
  });

  it('does not enqueue converted input after a cross-window switch during acceptance', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K, PROVIDER_272K],
    });
    let releaseResize!: (path: string) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseResize = resolve; }),
    );
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(os.tmpdir(), 'slow-profile-switch.png') }],
    });
    await vi.waitFor(() => expect(imageResizerMock.process).toHaveBeenCalledTimes(1));

    await handle.setModel?.(PROVIDER_272K.id);
    releaseResize(path.join(os.tmpdir(), 'slow-profile-switch-resized.png'));
    await expect(sendPromise).rejects.toThrow(
      '[CLAUDE_CONTEXT_PROFILE_CHANGED_BEFORE_ACCEPTANCE]',
    );
    const initialArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending?: number };
    };
    expect(initialArgs.prompt.pending).toBe(0);
    expect(firstQuery.close).not.toHaveBeenCalled();

    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);
    await handle.send({ type: 'user', content: 'explicit retry after profile switch' });
    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect((replacementArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('272000');
    const promptIter = replacementArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content)
      .toBe('explicit retry after profile switch');

    await handle.close();
  });

  it('applies permission, effort, and fast-mode controls while content conversion is awaiting', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    let releaseResize!: (path: string) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseResize = resolve; }),
    );
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(os.tmpdir(), 'slow-runtime-controls.png') }],
    });
    await vi.waitFor(() => expect(imageResizerMock.process).toHaveBeenCalledTimes(1));

    await handle.setPermissionMode?.('bypassPermissions');
    await handle.setEffort?.('low');
    await handle.setFastMode?.(true);
    expect(firstQuery.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledWith(
      expect.objectContaining({ effortLevel: 'low' }),
    );
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });

    releaseResize(path.join(os.tmpdir(), 'slow-runtime-controls-resized.png'));
    await sendPromise;
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    expect(startArgs.prompt.pending).toBe(1);
    await handle.close();
  });

  it('rejects steer while a cross-window switch is pending, then rebuilds on the next send', async () => {
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const { handle } = await startRewindableSession({
      additionalModels: [PROVIDER_372K],
      localQueries: [first, replacement],
    });
    void (async () => {
      try {
        for await (const event of handle.events()) void event;
      } catch {
        /* ignore */
      }
    })();
    const firstArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };

    await handle.send({ type: 'user', content: 'active native turn' });
    expect(firstArgs.prompt.pending).toBe(1);
    await handle.setModel?.(PROVIDER_372K.id);
    await expect(
      handle.steer?.({ type: 'user', content: 'must not enter the old Query' }),
    ).rejects.toThrow('[CLAUDE_STEER_CONTEXT_PROFILE_PENDING]');
    expect(firstArgs.prompt.pending).toBe(1);

    first.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));

    await handle.send({ type: 'user', content: 'retry as a new turn' });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(replacementArgs.prompt.pending).toBe(1);
    const promptIter = replacementArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('retry as a new turn');

    await handle.close();
  });

  it('hot-switches provider models that share the same process context profile', async () => {
    const sameWindowModel: ModelDescriptor = {
      ...PROVIDER_372K,
      id: 'provider/terra-alias',
      displayName: 'Terra Alias',
    };
    const { handle, firstQuery } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K, sameWindowModel],
    });

    await handle.setModel?.(sameWindowModel.id);

    expect(firstQuery.setModel).toHaveBeenCalledWith(sameWindowModel.id);
    expect(firstQuery.close).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('does not compact the old Query when a turn selects a smaller process profile', async () => {
    const provider128: ModelDescriptor = {
      id: 'provider/small-128k',
      displayName: 'Small 128k',
      contextWindow: 128_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    };
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const { handle } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K, provider128],
      autoCompactThresholdPct: 50,
      localQueries: [first, replacement],
    });
    void (async () => {
      try { for await (const _event of handle.events()) { /* drain */ } } catch { /* ignore */ }
    })();
    const firstArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };

    await handle.send({ type: 'user', content: 'wide-model turn' });
    first.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 100_000, output_tokens: 0 } },
    });
    await handle.setModel?.(provider128.id);
    first.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 100_000, output_tokens: 20 },
    });
    await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));
    expect(firstArgs.prompt.pending).toBe(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(handle.getUsageSnapshot().contextWindow).toBe(372_000);

    await handle.send({ type: 'user', content: 'small-model turn after rebuild' });
    expect(first.close).toHaveBeenCalledTimes(1);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: { env?: Record<string, string> };
    };
    expect(replacementArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
    expect(replacementArgs.prompt.pending).toBe(2);
    const promptIter = replacementArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content)
      .toBe('small-model turn after rebuild');

    await handle.close();
  });

  it('refreshes the effective window on same-env hot switches in both directions', async () => {
    const provider200: ModelDescriptor = {
      id: 'provider/standard-200k',
      displayName: 'Provider 200k',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    };
    const { handle, firstQuery } = await startRewindableSession({
      additionalModels: [provider200],
    });
    void (async () => {
      try { for await (const _event of handle.events()) { /* drain */ } } catch { /* ignore */ }
    })();

    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);
    await handle.setModel?.(provider200.id);
    expect(firstQuery.setModel).toHaveBeenLastCalledWith(provider200.id);
    expect(firstQuery.close).not.toHaveBeenCalled();
    await handle.send({ type: 'user', content: 'provider turn' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 120_000, output_tokens: 20 },
    });
    await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));
    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);

    await handle.setModel?.('claude-opus-4-6');
    expect(firstQuery.setModel).toHaveBeenLastCalledWith('claude-opus-4-6[1m]');
    expect(firstQuery.close).not.toHaveBeenCalled();
    await handle.send({ type: 'user', content: 'native turn' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 140_000, output_tokens: 20 },
    });
    await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));
    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);

    await handle.close();
  });

  it('synchronizes a changed native wire suffix before accepting catalog-refresh input', async () => {
    const dynamicModel = 'claude-haiku-dynamic';
    let verifiedWindow = 1_000_000;
    const { handle, firstQuery } = await startRewindableSession({
      model: dynamicModel,
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === dynamicModel ? verifiedWindow : null,
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      options: { model?: string };
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(startArgs.options.model).toBe(`${dynamicModel}[1m]`);

    verifiedWindow = 200_000;
    await handle.send({ type: 'user', content: 'after native window downgrade' });

    expect(firstQuery.setModel).toHaveBeenCalledWith(dynamicModel);
    expect(firstQuery.applyFlagSettings.mock.invocationCallOrder[0]).toBeLessThan(
      firstQuery.setModel.mock.invocationCallOrder[0],
    );
    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);
    expect(startArgs.prompt.pending).toBe(1);
    const promptIter = startArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content)
      .toBe('after native window downgrade');
    await handle.close();
  });

  it('keeps catalog-refresh input out when native wire synchronization fails', async () => {
    const dynamicModel = 'claude-haiku-dynamic';
    let verifiedWindow = 1_000_000;
    const { handle, firstQuery } = await startRewindableSession({
      model: dynamicModel,
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === dynamicModel ? verifiedWindow : null,
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    verifiedWindow = 200_000;
    firstQuery.setModel.mockRejectedValueOnce(new Error('wire downgrade rejected'));

    await expect(
      handle.send({ type: 'user', content: 'must not use stale 1m wire' }),
    ).rejects.toThrow('[CLAUDE_CONTEXT_PROFILE_WIRE_SYNC_FAILED]');
    expect(startArgs.prompt.pending).toBe(0);
    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('fails closed when a same-env model switch races a pre-acceptance wire sync', async () => {
    const dynamicModel = 'claude-haiku-dynamic';
    let verifiedWindow = 1_000_000;
    const { handle, firstQuery } = await startRewindableSession({
      model: dynamicModel,
      resolveVerifiedContextWindow: (_providerId, modelId) => {
        if (modelId === dynamicModel) return verifiedWindow;
        if (modelId === 'claude-sonnet-5') return 500_000;
        return null;
      },
    });
    const startArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    verifiedWindow = 200_000;
    let notifyWireSync!: () => void;
    let releaseWireSync!: () => void;
    const wireSyncStarted = new Promise<void>((resolve) => { notifyWireSync = resolve; });
    const wireSyncHold = new Promise<void>((resolve) => { releaseWireSync = resolve; });
    firstQuery.setModel.mockImplementationOnce(async () => {
      notifyWireSync();
      await wireSyncHold;
    });

    const sendPromise = handle.send({ type: 'user', content: 'racing wire sync' });
    await wireSyncStarted;
    await handle.setModel?.('claude-sonnet-5');
    releaseWireSync();
    await expect(sendPromise).rejects.toThrow(
      '[CLAUDE_CONTEXT_PROFILE_CHANGED_BEFORE_ACCEPTANCE]',
    );
    expect(startArgs.prompt.pending).toBe(0);
    expect(firstQuery.setModel).toHaveBeenCalledTimes(1);
    expect(handle.model).toBe('claude-sonnet-5');
    await handle.close();
  });

  it('serializes concurrent same-profile model switches in invocation order', async () => {
    const aliasB: ModelDescriptor = {
      ...PROVIDER_272K,
      id: 'provider/serial-b',
      displayName: 'Serial B',
    };
    const aliasC: ModelDescriptor = {
      ...PROVIDER_272K,
      id: 'provider/serial-c',
      displayName: 'Serial C',
    };
    const { handle, firstQuery } = await startRewindableSession({
      model: PROVIDER_272K.id,
      additionalModels: [PROVIDER_272K, aliasB, aliasC],
    });
    let notifyBStarted!: () => void;
    let releaseB!: () => void;
    const bStarted = new Promise<void>((resolve) => { notifyBStarted = resolve; });
    const bHold = new Promise<void>((resolve) => { releaseB = resolve; });
    firstQuery.setModel.mockImplementationOnce(async () => {
      notifyBStarted();
      await bHold;
    });

    const switchB = handle.setModel?.(aliasB.id);
    await bStarted;
    const switchC = handle.setModel?.(aliasC.id);
    expect(firstQuery.setModel).toHaveBeenCalledTimes(1);
    releaseB();
    await Promise.all([switchB, switchC]);

    expect(firstQuery.setModel.mock.calls.map(([model]) => model)).toEqual([
      aliasB.id,
      aliasC.id,
    ]);
    expect(handle.model).toBe(aliasC.id);
    expect(handle.getUsageSnapshot().contextWindow).toBe(PROVIDER_272K.contextWindow);
    await handle.close();
  });

  it('retires a Query after a hot setModel ACK failure before accepting more input', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    let daemonModel = 'claude-opus-4-6[1m]';
    firstQuery.setModel.mockImplementationOnce(async (model: string) => {
      daemonModel = model;
      throw new Error('setModel ACK lost');
    });
    await expect(handle.setModel?.('claude-sonnet-5')).rejects.toThrow('setModel ACK lost');
    expect(daemonModel).toBe('claude-sonnet-5');
    expect(handle.model).toBe('claude-opus-4-6');

    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);
    await handle.send({ type: 'user', content: 'only after uncertain Query retirement' });
    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    const firstArgs = sdkMock.query.mock.calls[0]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(firstArgs.prompt.pending).toBe(0);
    expect(replacementArgs.prompt.pending).toBe(1);
    await handle.close();
  });

  it('keeps an SSH Query retryable after a remote setModel rejection', async () => {
    const first = createFakeQuery();
    first.setModel.mockRejectedValueOnce(new Error('remote setModel rejected'));
    const { handle, remoteStartParams } = await startRewindableSession({
      remoteHostId: 'ssh-host-1',
      additionalModels: [PROVIDER_372K],
      remoteQueries: [first],
    });

    await expect(handle.setModel?.(PROVIDER_372K.id)).rejects.toThrow(
      'remote setModel rejected',
    );
    expect(handle.model).toBe('claude-opus-4-6');

    await expect(handle.setModel?.(PROVIDER_372K.id)).resolves.toBeUndefined();
    expect(first.setModel).toHaveBeenCalledTimes(2);
    expect(first.setModel).toHaveBeenLastCalledWith(PROVIDER_372K.id);
    expect(handle.model).toBe(PROVIDER_372K.id);

    await handle.send({ type: 'user', content: 'ordinary remote send after explicit retry' });
    expect(first.close).not.toHaveBeenCalled();
    expect(remoteStartParams).toHaveLength(1);
    await handle.close();
  });

  it('keeps live controls writable while a profile rebuild is only pending', async () => {
    const first = createFakeQuery();
    let notifyCloseStarted!: () => void;
    let releaseClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => { notifyCloseStarted = resolve; });
    const closeHold = new Promise<void>((resolve) => { releaseClose = resolve; });
    first.close.mockImplementationOnce(async () => {
      notifyCloseStarted();
      await closeHold;
    });
    const replacement = createFakeQuery();
    const { handle } = await startRewindableSession({
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K],
      localQueries: [first, replacement],
    });

    await handle.setModel?.(PROVIDER_372K.id);
    expect(first.setModel).not.toHaveBeenCalled();

    await handle.setEffort?.('low');
    await handle.setFastMode?.(true);
    await handle.setPermissionMode?.('ask');
    expect(first.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'low' });
    expect(first.applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    expect(first.setPermissionMode).toHaveBeenCalledWith('default');

    const oldFlagCallCount = first.applyFlagSettings.mock.calls.length;
    const oldPermissionCallCount = first.setPermissionMode.mock.calls.length;
    const send = handle.send({ type: 'user', content: 'send only after retirement' });
    await closeStarted;

    await handle.setEffort?.('high');
    await handle.setFastMode?.(false);
    await handle.setPermissionMode?.('bypassPermissions');
    expect(first.applyFlagSettings).toHaveBeenCalledTimes(oldFlagCallCount);
    expect(first.setPermissionMode).toHaveBeenCalledTimes(oldPermissionCallCount);

    releaseClose();
    await send;
    expect(first.close).toHaveBeenCalledTimes(1);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: {
        effort?: string;
        permissionMode?: string;
        settings?: { fastMode?: boolean };
      };
    };
    expect(replacementArgs.options.effort).toBe('high');
    expect(replacementArgs.options.permissionMode).toBe('default');
    expect(replacementArgs.options.settings?.fastMode).toBeUndefined();
    expect(replacement.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'high' });
    expect(replacement.applyFlagSettings).toHaveBeenCalledWith({ fastMode: false });
    expect(replacement.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');

    await handle.close();
  });

  it('coalesces A→B→A before send without spawning an intermediate Query', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      model: PROVIDER_372K.id,
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K, PROVIDER_272K],
    });

    await handle.setModel?.(PROVIDER_272K.id);
    await handle.setModel?.(PROVIDER_372K.id);

    expect(firstQuery.close).not.toHaveBeenCalled();
    expect(firstQuery.setModel).toHaveBeenCalledWith(PROVIDER_372K.id);
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('keeps the context rebuild pending when close fails and retries on the next send', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K],
    });
    const replacement = createFakeQuery();
    firstQuery.close.mockImplementationOnce(() => {
      throw new Error('remote close not acknowledged');
    });
    sdkMock.query.mockReturnValue(replacement);

    await handle.setModel?.(PROVIDER_372K.id);
    await expect(
      handle.send({ type: 'user', content: 'first attempt' }),
    ).rejects.toThrow('remote close not acknowledged');
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    await handle.send({ type: 'user', content: 'retry after close acknowledgement' });
    expect(firstQuery.close).toHaveBeenCalledTimes(2);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);

    await handle.close();
  });

  it('does not coalesce back to A after retirement has ended the old input queue', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K],
    });
    firstQuery.close.mockRejectedValueOnce(new Error('retirement ACK lost'));
    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);

    await handle.setModel?.(PROVIDER_372K.id);
    await expect(
      handle.send({ type: 'user', content: 'failed B attempt' }),
    ).rejects.toThrow('retirement ACK lost');
    await handle.setModel?.('claude-opus-4-6');

    await handle.send({ type: 'user', content: 'A only after strict retry' });
    expect(firstQuery.close).toHaveBeenCalledTimes(2);
    expect(firstQuery.setModel).not.toHaveBeenCalled();
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: { env?: Record<string, string> };
    };
    expect(replacementArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('0');
    expect(replacementArgs.prompt.pending).toBe(1);
    const promptIter = replacementArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('A only after strict retry');
    await handle.close();
  });

  it('tombstones the fifth unstable context candidate and retires it on explicit retry', async () => {
    const dynamicModel: ModelDescriptor = {
      id: 'provider/dynamic-rebuild',
      displayName: 'Dynamic rebuild model',
      contextWindow: 372_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    };
    let verifiedWindow = 372_000;
    const initial = createFakeQuery();
    const candidates = Array.from({ length: 6 }, () => createFakeQuery());
    const { handle } = await startRewindableSession({
      model: dynamicModel.id,
      additionalModels: [dynamicModel],
      localQueries: [initial, ...candidates],
      resolveVerifiedContextWindow: (_providerId, modelId) =>
        modelId === dynamicModel.id ? verifiedWindow : null,
    });
    verifiedWindow = 272_000;
    let notifications = 0;
    setClaudeSupportedModelsListener(() => {
      notifications += 1;
      if (notifications <= 5) {
        verifiedWindow = verifiedWindow === 272_000 ? 128_000 : 272_000;
      }
    });

    await expect(
      handle.send({ type: 'user', content: 'must not enter unstable candidate' }),
    ).rejects.toThrow('[CLAUDE_CONTEXT_PROFILE_REBUILD_UNSTABLE]');
    expect(sdkMock.query).toHaveBeenCalledTimes(6);
    expect(candidates[4].close).not.toHaveBeenCalled();
    for (let call = 1; call <= 5; call += 1) {
      const args = sdkMock.query.mock.calls[call]?.[0] as {
        prompt: AsyncIterable<unknown> & { pending: number };
      };
      expect(args.prompt.pending).toBe(0);
    }

    await handle.send({ type: 'user', content: 'stable explicit retry' });
    expect(candidates[4].close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(7);
    const stableArgs = sdkMock.query.mock.calls[6]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: { env?: Record<string, string> };
    };
    expect(stableArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
    expect(stableArgs.prompt.pending).toBe(1);
    const promptIter = stableArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('stable explicit retry');
    await handle.close();
  });

  it('blocks a rewind replacement until a failed close succeeds on explicit retry', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.close.mockRejectedValueOnce(new Error('rewind close not acknowledged'));

    await expect(
      handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1'),
    ).rejects.toThrow('rewind close not acknowledged');
    expect(sdkMock.query).toHaveBeenCalledTimes(1);

    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);
    await handle.send({ type: 'user', content: 'explicit retry after rewind close' });
    expect(firstQuery.close).toHaveBeenCalledTimes(2);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const retryArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    expect(retryArgs.options.forkSession).toBe(true);
    const promptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content)
      .toBe('explicit retry after rewind close');

    await handle.close();
  });

  it('retries an unacknowledged provisional rewind candidate before creating its successor', async () => {
    const initial = createFakeQuery();
    const provisional = createFakeQuery();
    const replacement = createFakeQuery();
    const smallInventory = [
      { name: 'small-plugin', description: 'small provider worker', model: 'provider/small' },
    ];
    provisional.supportedAgents.mockResolvedValue(smallInventory);
    replacement.supportedAgents.mockResolvedValue(smallInventory);
    provisional.close.mockRejectedValueOnce(new Error('provisional rewind close not acknowledged'));

    const { handle } = await startRewindableSession({
      additionalModels: [
        PROVIDER_372K,
        {
          id: 'provider/small',
          displayName: 'Small provider model',
          contextWindow: 128_000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
        },
      ],
      localQueries: [initial, provisional, replacement],
    });
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.(PROVIDER_372K.id);

    await expect(
      handle.send({ type: 'user', content: 'first rewind attempt' }),
    ).rejects.toThrow('[CLAUDE_CONTEXT_PROFILE_CANDIDATE_CLOSE_FAILED]');
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    expect(provisional.close).toHaveBeenCalledTimes(1);
    const provisionalArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    expect(provisionalArgs.prompt.pending).toBe(0);

    await handle.send({ type: 'user', content: 'explicit retry after provisional rewind close' });
    expect(provisional.close).toHaveBeenCalledTimes(2);
    expect(sdkMock.query).toHaveBeenCalledTimes(3);
    const replacementArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: { env?: Record<string, string> };
    };
    expect(replacementArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
    expect(replacementArgs.prompt.pending).toBe(1);
    const promptIter = replacementArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content)
      .toBe('explicit retry after provisional rewind close');

    await handle.close();
  });

  it('keeps the context rebuild pending when Query creation fails and retries without replaying input', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K],
    });
    const replacement = createFakeQuery();
    sdkMock.query
      .mockImplementationOnce(() => {
        throw new Error('replacement Query failed to start');
      })
      .mockReturnValue(replacement);

    await handle.setModel?.(PROVIDER_372K.id);
    await expect(
      handle.send({ type: 'user', content: 'must not be replayed' }),
    ).rejects.toThrow('replacement Query failed to start');
    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);

    await handle.send({ type: 'user', content: 'explicit retry' });
    expect(firstQuery.close).toHaveBeenCalledTimes(2);
    expect(sdkMock.query).toHaveBeenCalledTimes(3);
    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: { env?: Record<string, string> };
    };
    expect(retryArgs.options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('372000');
    const promptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('explicit retry');

    await handle.close();
  });

  it('leaves SSH MAX_CONTEXT unmanaged and preserves the existing hot-switch path', async () => {
    const first = createFakeQuery();
    const { handle, remoteStartParams } = await startRewindableSession({
      remoteHostId: 'ssh-host-1',
      additionalModels: [PROVIDER_372K],
      remoteQueries: [first],
    });

    await handle.setModel?.(PROVIDER_372K.id);

    expect(remoteStartParams).toHaveLength(1);
    expect(
      (remoteStartParams[0]?.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    ).toBeUndefined();
    expect(first.setModel).toHaveBeenCalledWith(PROVIDER_372K.id);
    expect(first.close).not.toHaveBeenCalled();
    expect(handle.getUsageSnapshot().contextWindow).toBe(372_000);

    await handle.close();
  });

  it('rebuilds when a newly selected provider model needs a different process profile', async () => {
    const first = createFakeQuery();
    const replacement = createFakeQuery();
    const { handle, firstQuery, agent } = await startRewindableSession({
      localQueries: [first, replacement],
    });

    agent.capabilities.availableModels.push({
      id: 'x-ai/grok-4.6',
      displayName: 'Grok 4.6',
      contextWindow: 256_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });

    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);

    await handle.setModel?.('x-ai/grok-4.6');
    expect(firstQuery.setModel).not.toHaveBeenCalled();
    await handle.send({ type: 'user', content: 'switch to grok' });

    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect((rebuildArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('256000');
    expect(handle.getUsageSnapshot().contextWindow).toBe(256_000);

    await handle.close();
  });

  it('uses the session provider route when the same model id has different windows', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const workingDir = await makeTempDir();
    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);

    const resolveVerifiedContextWindow = vi.fn((providerId: string | null | undefined, modelId: string) => {
      if (modelId !== 'shared-model') return null;
      if (providerId === 'xd') return 256_000;
      return 1_000_000;
    });

    const agent = new ClaudeCodeAgent({
      ...createDeps({ subagentModel: 'claude-haiku-4-5' }),
      capabilityAdditions: {
        availableModels: [
          ...TEST_MODELS,
          {
            id: 'shared-model',
            displayName: 'Shared',
            contextWindow: 1_000_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
          },
        ],
      },
      resolveVerifiedContextWindow,
    });
    const handle = await agent.startSession({
      sessionId: 'session-provider-window',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
    });

    await handle.setModel?.('shared-model', { providerId: 'xd' });

    expect(resolveVerifiedContextWindow).toHaveBeenCalledWith('xd', 'shared-model');
    // The selected profile is pending; usage still describes the live Query.
    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);

    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);
    await handle.send({ type: 'user', content: 'apply provider-specific profile' });
    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    expect(handle.getUsageSnapshot().contextWindow).toBe(256_000);

    await handle.close();
  });

  it('does not apply the flattened catalog window when the host resolver returns null', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const workingDir = await makeTempDir();
    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);

    const resolveVerifiedContextWindow = vi.fn(() => null);

    const agent = new ClaudeCodeAgent({
      ...createDeps(),
      capabilityAdditions: {
        availableModels: [
          ...TEST_MODELS,
          {
            id: 'shared-model',
            displayName: 'Shared',
            contextWindow: 256_000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
          },
        ],
      },
      resolveVerifiedContextWindow,
    });
    const handle = await agent.startSession({
      sessionId: 'session-unverified-window',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'acceptEdits',
    });

    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);

    await handle.setModel?.('shared-model', { providerId: 'xd' });

    expect(resolveVerifiedContextWindow).toHaveBeenCalledWith('xd', 'shared-model');
    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);

    await handle.close();
  });

  it('passes max through when changing effort in a live Sonnet 5 session', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.setModel?.('claude-sonnet-5');
    await handle.setEffort?.('max');

    expect(firstQuery.applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: 'max' });

    await handle.close();
  });

  it('falls back to the model-supported xhigh when an older runtime rejects max', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.setModel?.('claude-sonnet-5');
    firstQuery.applyFlagSettings
      .mockRejectedValueOnce(new Error('invalid effortLevel: max'))
      .mockResolvedValueOnce(undefined);
    await expect(handle.setEffort?.('max')).resolves.toBeUndefined();

    expect(firstQuery.applyFlagSettings.mock.calls.slice(-2)).toEqual([
      [{ effortLevel: 'max' }],
      [{ effortLevel: 'xhigh' }],
    ]);

    await handle.close();
  });

  it('falls back to high when the selected model does not support xhigh', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings
      .mockRejectedValueOnce(new Error('invalid effortLevel: max'))
      .mockResolvedValueOnce(undefined);

    await expect(handle.setEffort?.('max')).resolves.toBeUndefined();

    expect(firstQuery.applyFlagSettings.mock.calls.slice(-2)).toEqual([
      [{ effortLevel: 'max' }],
      [{ effortLevel: 'high' }],
    ]);

    await handle.close();
  });

  it('does not retry max when applyFlagSettings fails at the transport layer', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings.mockRejectedValueOnce(
      new Error('ProcessTransport is not ready for writing'),
    );

    await expect(handle.setEffort?.('max')).rejects.toThrow(
      'ProcessTransport is not ready for writing',
    );
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('does not retry failures for non-max effort levels', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    firstQuery.applyFlagSettings.mockRejectedValueOnce(new Error('transport failed'));

    await expect(handle.setEffort?.('high')).rejects.toThrow('transport failed');
    expect(firstQuery.applyFlagSettings).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('replays max without downgrading it when effort changes during query rebuild', async () => {
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setModel?.('claude-sonnet-5');
      void handle.setEffort?.('max');
      return secondQuery;
    });

    await handle.send({ type: 'user', content: 'use max after rewind' });

    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });

    await handle.close();
  });

  it('setModel / setEffort / setFastMode / setPermissionMode skip the closed query and apply on rebuild', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    expect(firstQuery.close).toHaveBeenCalled();

    // 事故形态回归: 修复前这四个调用会打到已 close 的 transport 直接 reject。
    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();
    await expect(handle.setEffort?.('low')).resolves.toBeUndefined();
    await expect(handle.setFastMode?.(true)).resolves.toBeUndefined();
    await expect(handle.setPermissionMode?.('auto')).resolves.toBeUndefined();

    // 窗口内不许对旧 q 发任何 control request（fake 会抛, 这里再显式钉死语义）。
    expect(firstQuery.setModel).not.toHaveBeenCalled();
    expect(firstQuery.applyFlagSettings).not.toHaveBeenCalled();
    // startSession 阶段可能推过 permissionMode; commit 后不许再推。
    const permCallsAfterClose = firstQuery.setPermissionMode.mock.invocationCallOrder.filter(
      (order) => order > (firstQuery.close.mock.invocationCallOrder[0] ?? 0),
    );
    expect(permCallsAfterClose).toHaveLength(0);

    // 下一次 send 触发重建: 新 Query 直接带上窗口期改的 model / permissionMode。
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    // fixture 把 sonnet-5 配成 500K 窗口 → 窗口驱动的 wire 规则不带 [1m](<1M 不带)。
    expect(rebuildArgs.options.model).toBe('claude-sonnet-5');
    // Cindy 档 'auto'(Auto-review)映射到 SDK 'default' —— 不透传 'auto' 给 CC,改由
    // canUseTool + Cindy 策略审查(见 toSdkPermissionMode)。
    expect(rebuildArgs.options.permissionMode).toBe('default');
    expect(rebuildArgs.options.forkSession).toBe(true);
    expect(rebuildArgs.options.resumeSessionAt).toBe('assistant-uuid-1');

    await handle.close();
  });

  it('merges a pending context-profile change into the rewind three-part rebuild', async () => {
    const { handle } = await startRewindableSession({
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K],
    });
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.(PROVIDER_372K.id);

    const replacement = createFakeQuery();
    sdkMock.query.mockReturnValue(replacement);
    await handle.send({ type: 'user', content: 'rewind with the new context profile' });

    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: Record<string, unknown>;
    };
    expect(rebuildArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    expect(rebuildArgs.options.forkSession).toBe(true);
    expect((rebuildArgs.options.env as Record<string, string>).CLAUDE_CODE_MAX_CONTEXT_TOKENS)
      .toBe('372000');

    await handle.close();
  });

  it('setPlanMode armed during rewind window does not throw and rebuild starts in plan mode', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    await expect(handle.setPlanMode?.(true)).resolves.toBeUndefined();
    const permCallsAfterClose = firstQuery.setPermissionMode.mock.invocationCallOrder.filter(
      (order) => order > (firstQuery.close.mock.invocationCallOrder[0] ?? 0),
    );
    expect(permCallsAfterClose).toHaveLength(0);

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'plan after rewind' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('plan');

    await handle.close();
  });

  it('runtime settings arriving during the async rebuild window still skip the old query', async () => {
    const { handle, firstQuery } = await startRewindableSession();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    // 不 await: send 同步执行完 rebuild 前置段后挂起在 `await buildQuery` 上,
    // 此刻 q 仍指向旧 closed query。修复前 pendingRewindTo 在 await 之前就被清掉,
    // 这里的 setModel 会判定窗口已结束 → 打旧 q → 抛 transport 错误。
    const sendPromise = handle.send({ type: 'user', content: 'hello after rewind' });
    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();
    expect(firstQuery.setModel).not.toHaveBeenCalled();

    await sendPromise;
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    // buildQuery 头部在竞态切换之前就快照了旧 model — 重建 options 里是旧值,
    // 全靠 rebuild 完成后的 diff 重放把新 model 补推到新 q(否则 UI 报成功但
    // session 实际还在旧模型上跑, Codex review P2)。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.model).toBe('claude-opus-4-6[1m]');
    // sonnet-5 fixture 窗口 500K < 1M → wire 串不带 [1m](窗口驱动规则)。
    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({
      availableModels: ['claude-opus-4-6[1m]', 'claude-sonnet-5'],
    });
    expect(secondQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(secondQuery.applyFlagSettings.mock.invocationCallOrder[0]).toBeLessThan(
      secondQuery.setModel.mock.invocationCallOrder[0],
    );

    await handle.close();
  });

  it('fails before input when same-env model replay on a replacement Query is rejected', async () => {
    const { handle, firstQuery } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    secondQuery.setModel.mockRejectedValueOnce(new Error('replacement rejected setModel'));
    sdkMock.query.mockReturnValue(secondQuery);
    const sendPromise = handle.send({ type: 'user', content: 'must stay out of replacement' });
    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();
    expect(firstQuery.setModel).not.toHaveBeenCalled();

    await expect(sendPromise).rejects.toThrow('[CLAUDE_CONTEXT_PROFILE_REPLAY_MODEL_FAILED]');
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending?: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(0);
    expect(secondQuery.send).not.toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'explicit retry keeps rewind intent' });
    expect(secondQuery.close).toHaveBeenCalledTimes(1);
    expect(sdkMock.query).toHaveBeenCalledTimes(3);
    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    expect(retryArgs.options.forkSession).toBe(true);
    const promptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content)
      .toBe('explicit retry keeps rewind intent');

    await handle.close();
  });

  it('fails before input when replacement replay rejects effort drift', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      additionalModels: [PROVIDER_372K],
    });
    await handle.setModel?.(PROVIDER_372K.id);
    const replacement = createFakeQuery();
    replacement.applyFlagSettings.mockRejectedValueOnce(new Error('replacement rejected effort'));
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setEffort?.('low');
      return replacement;
    });

    await expect(
      handle.send({ type: 'user', content: 'must stay outside failed effort replay' }),
    ).rejects.toThrow('[CLAUDE_RUNTIME_REPLAY_EFFORT_FAILED]');
    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    expect(replacementArgs.prompt.pending).toBe(0);
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('fails before input when replacement replay rejects fast-mode drift', async () => {
    const { handle, firstQuery } = await startRewindableSession({
      additionalModels: [PROVIDER_372K],
    });
    await handle.setModel?.(PROVIDER_372K.id);
    const replacement = createFakeQuery();
    replacement.applyFlagSettings.mockRejectedValueOnce(new Error('replacement rejected fast mode'));
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setFastMode?.(true);
      return replacement;
    });

    await expect(
      handle.send({ type: 'user', content: 'must stay outside failed fast-mode replay' }),
    ).rejects.toThrow('[CLAUDE_RUNTIME_REPLAY_FAST_MODE_FAILED]');
    expect(firstQuery.close).toHaveBeenCalledTimes(1);
    const replacementArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<unknown> & { pending: number };
    };
    expect(replacementArgs.prompt.pending).toBe(0);
    expect(handle.isTurnRunning?.()).toBe(false);
    await handle.close();
  });

  it('setPlanMode arriving after rewind q install but before turn start stays deferred', async () => {
    // 覆盖 pendingRewindTo 已清、new q 已安装,但 turnInFlight 尚未登记的接受窗口。
    // 这里的 setPlanMode 只能 arm 下一 turn,不能把当前显式普通 send 升级为 plan turn。
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setModel?.('claude-sonnet-5'); // 让 rebuild replay 进入 q.setModel await 窗口
      return secondQuery;
    });
    secondQuery.setModel.mockImplementationOnce(async () => {
      await handle.setPlanMode?.(true);
    });

    await handle.send({ type: 'user', content: 'normal turn please' }, { planMode: false });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('acceptEdits');
    // sonnet-5 fixture 窗口 500K < 1M → wire 串不带 [1m](窗口驱动规则)。
    expect(secondQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5');
    const planSwitches = secondQuery.setPermissionMode.mock.calls.filter((c: unknown[]) => c[0] === 'plan');
    expect(planSwitches, 'accepting-window setPlanMode must not upgrade the current normal send').toHaveLength(0);
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.close();
  });

  it('setModel crossing compact threshold during accepting window is bridge-counted', async () => {
    // pendingRewindTo 清掉后、turnInFlight=true 前的 setModel 若直接触发 /compact,
    // 该 compact 没有 queuedBridgeTurns 标记,done/status 会泄漏成独立 turn。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setEffort?.('low'); // 让 rebuild replay 进入 applyFlagSettings await 窗口
      return secondQuery;
    });
    secondQuery.applyFlagSettings.mockImplementationOnce(async () => {
      await handle.setModel?.('claude-sonnet-5'); // 500K 窗口: 400K usage 跨过 50% 阈值
    });

    await handle.send({ type: 'user', content: 'normal turn after accepting-window model switch' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content).toBe('normal turn after accepting-window model switch');

    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.type === 'done'), 'accepting-window /compact done must be bridge-suppressed').toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(true);

    await handle.close();
  });

  it('setModel skips auto-compact trigger while the rewind rebuild is pending', async () => {
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const eventIterator = handle.events()[Symbol.asyncIterator]();

    // 先写入一份旧窗口下未达阈值、切到小窗口后会达阈值的 usage 快照。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    const usageStatus = await eventIterator.next();
    expect(usageStatus.value?.type).toBe('status');
    expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    expect(handle.isTurnRunning?.()).toBe(false);

    await expect(handle.setModel?.('claude-sonnet-5')).resolves.toBeUndefined();

    expect(handle.getUsageSnapshot().contextWindow).toBe(1_000_000);
    // 修复前这里会立即注入 /compact 到即将被重建丢弃的 inputQueue, 并把 turnInFlight 置 true。
    expect(handle.isTurnRunning?.()).toBe(false);

    await handle.close();
  });

  it('injects host auto-compact at 75% even when the model-switch handoff callback would fire', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      shouldHandoffAfterContextAssessment: () => true,
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 400_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });

    await handle.setModel?.('claude-sonnet-5');
    expect(handle.getUsageSnapshot().contextWindow).toBe(500_000);
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toEqual([
      'auto-compact triggered',
    ]);

    await handle.close();
  });

  it('injects host auto-compact at the 0.1.57 Grok occupancy that is below a full window', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 80,
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toEqual([
        'auto-compact triggered',
      ]);
    });
    expect(handle.getUsageSnapshot().contextTokens).toBe(437_712);
    expect(handle.getUsageSnapshot().contextWindow).toBe(500_000);
    expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();

    await handle.close();
  });

  it('does not inject host auto-compact when occupancy is already full', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 75,
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 500_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toEqual([]);

    await handle.close();
  });

  it('keeps idle auto-compact on remote sessions because overflow rollover is local-only', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      remoteHostId: 'remote-1',
      model: 'claude-sonnet-5',
      shouldHandoffAfterContextAssessment: () => true,
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 400_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);
    });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 20_000, output_tokens: 20 },
    });
    await vi.waitFor(() => expect(handle.isTurnRunning?.()).toBe(false));

    expect(handle.getUsageSnapshot().contextWindow).toBe(500_000);
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toEqual([
      'auto-compact triggered',
    ]);

    await handle.close();
  });

  it('still injects host auto-compact on a full remote session because rollover is local-only', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 75,
      remoteHostId: 'remote-1',
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 500_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toEqual([
        'auto-compact triggered',
      ]);
    });
    expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();

    await handle.close();
  });

  it('latches rollover when idle host auto-compact returns an empty summary', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 80,
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toEqual([
        'auto-compact triggered',
      ]);
    });

    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      result: 'Error during compaction: summarization produced empty response',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().needsRollover).toBe(true);
    });
    expect(handle.isTurnRunning?.()).toBe(false);

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 438_000, output_tokens: 0 } },
    });
    await Promise.resolve();
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);

    await handle.close();
  });

  it('retries idle host auto-compact after a transient compact failure', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 80,
    });
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();

    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);
    });

    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      result: 'Error during compaction: 401 unauthorized',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();

    await handle.send({ type: 'user', content: 'again' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 438_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(2);
    });

    await handle.close();
  });

  async function waitForIdleHostAutoCompact(
    handle: Awaited<ReturnType<typeof startRewindableSession>>['handle'],
    firstQuery: ReturnType<typeof createFakeQuery>,
    infoCalls: string[],
  ): Promise<void> {
    void (async () => {
      try {
        for await (const _event of handle.events()) {
          /* drain */
        }
      } catch {
        /* ignore */
      }
    })();
    await handle.send({ type: 'user', content: 'hi' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);
    });
  }

  it('does not re-inject idle host auto-compact after abort until the next user turn', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 80,
    });
    await waitForIdleHostAutoCompact(handle, firstQuery, infoCalls);

    await handle.abort();
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      result: 'error_during_execution',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);

    await handle.send({ type: 'user', content: 'again' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 438_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(2);
    });

    await handle.close();
  });

  it('does not re-inject idle host auto-compact after the upstream idle watchdog', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 80,
      idleTimeoutMs: 20,
    });
    await waitForIdleHostAutoCompact(handle, firstQuery, infoCalls);
    await vi.waitFor(() => {
      expect(firstQuery.interrupt).toHaveBeenCalled();
    });
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      result: 'error_during_execution',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);

    await handle.send({ type: 'user', content: 'again' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 438_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(2);
    });

    await handle.close();
  });

  it('clears idle host auto-compact fired after requestGracefulStop', async () => {
    const { handle, firstQuery, infoCalls } = await startRewindableSession({
      model: 'claude-sonnet-5',
      autoCompactThresholdPct: 80,
    });
    await waitForIdleHostAutoCompact(handle, firstQuery, infoCalls);

    await handle.requestGracefulStop?.();
    firstQuery.stream.emit({
      type: 'result',
      is_error: true,
      result: 'error_during_execution',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 437_712, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
    });
    expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(1);

    await handle.send({ type: 'user', content: 'again' });
    firstQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 438_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(infoCalls.filter((message) => message === 'auto-compact triggered')).toHaveLength(2);
    });

    await handle.close();
  });

  it('rebuild replays auto-compact when a large→small window switch crossed the threshold during rewind', async () => {
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const eventIterator = handle.events()[Symbol.asyncIterator]();

    // 旧窗口 1M / usage 400K → ratio 40% (未达 50% 阈值)。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    const status = await eventIterator.next();
    expect(status.value?.type).toBe('status');

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    // 切到 500K 窗口 → ratio 80% (跨过阈值)。窗口期跳过了立即触发,
    // 补触发要延到 rebuild 完成时。
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 断言新 inputQueue 里 /compact 先于用户消息 — SDK 会先压缩再处理用户消息,
    // 语义与 idle setModel 触发 /compact 等价, 不会让首轮直接撞小窗上下文上限。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    const iterator = rebuildArgs.prompt[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value?.message?.content).toBe('/compact');
    expect(second.value?.message?.content).toBe('hello after rewind');

    await handle.close();
  });

  it('late stream_end from the closed rewind query does not tear down the rebuilt bridge turn', async () => {
    // 反馈原型 (Codex review 3539123827): commitRewindFiles close 的旧 Query
    // forward loop 可能晚于下一次 send rebuild 才退出。若只看共享 pendingRewindTo,
    // 新 q 接管后该标记已清,旧 q 的迟到 stream_end 会误进 bridge_stream_closed /
    // remote_daemon_closed 兜底,把刚重建的首个 post-rewind turn 关掉。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after delayed old stream_end' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(2); // bridge /compact + real user message are still alive.

    firstQuery.stream.end();
    await new Promise((r) => setTimeout(r, 20));

    expect(
      events.find(
        (e) =>
          e.type === 'error' &&
          ['bridge_stream_closed', 'remote_daemon_closed'].includes((e.data as { reason?: string }).reason ?? ''),
      ),
      'late stream_end from the closed rewind query must stay silent after rebuild',
    ).toBeUndefined();
    expect(
      events.find(
        (e) =>
          e.type === 'done' &&
          ['bridge_stream_closed', 'remote_daemon_closed'].includes((e.data as { reason?: string }).reason ?? ''),
      ),
      'late stream_end from the closed rewind query must not finalize the rebuilt turn',
    ).toBeUndefined();
    expect(handle.isTurnRunning?.()).toBe(true);
    expect(rebuildArgs.prompt.pending).toBe(2);

    await handle.close();
  });

  it('late stream_end from the closed rewind query preserves the rebuilt turn watchdog', async () => {
    // 反馈原型 (Codex review 3541143604): 旧 rewind Query 可能在新 Query 已接受
    // 用户输入并 arm upstream-idle watchdog 后才退出。旧 loop 的 shared finally
    // 不能清掉属于新 turn 的 timer,否则新 turn 在首个 SDK event 前挂死时不会自愈。
    const { handle, firstQuery } = await startRewindableSession({ idleTimeoutMs: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after delayed old stream_end' });

    firstQuery.stream.end();

    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout',
          ),
          'new turn watchdog must survive stale rewind query cleanup',
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    expect(secondQuery.interrupt).toHaveBeenCalledTimes(1);

    await handle.close();
  });

  it('suppresses middle-turn end-status/done while inputQueue has a queued turn', async () => {
    // 反馈原型: rebuild 尾部注入 /compact 是 SDK 独立 turn, 处理完发 status(isRunning=false)+done。
    // 这两个事件到 register.ts 会触发 turn-finalization 副作用 (idle 调度 / turn 结束回写 /
    // IM handleTurnDoneAsync / snapshot), 让真正的用户回答被当作"第二个 turn"。
    // forward loop 的事件 sink 在 pending>0 时 suppress 这两类边界事件。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    // fake stream 不响应 abortController, handle.events() iterator 不会自然结束 —
    // 不 await collected, 用 .catch 消 unhandled rejection, 测试结束时 vitest 自动 gc。
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // fake 不 drain inputQueue, pending 保持 >0 → middle-turn 判定成立。
    // 让 SDK "处理完 /compact turn" 发 result — translator 会推出 status(isRunning=false)+done,
    // forward loop 的 sink 必须把这两条吞掉。
    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 200_000, output_tokens: 10 },
    });
    await vi.waitFor(() => {
      // translator handleResult 会同步 push 一些非边界事件 (endTurn 的 log 等), 但边界事件
      // 应被 suppress; 等 forward loop 消费完这一 rawMsg。
      expect(events.length).toBeGreaterThanOrEqual(beforeCount);
    });
    // 再等一小段确认后续没有 middle-turn 的 done / end-status 漏出来。
    await new Promise((r) => setTimeout(r, 20));

    const middleDone = events.find((e) => e.type === 'done');
    expect(middleDone, 'middle-turn done must be suppressed while queued turn exists').toBeUndefined();
    const middleEndStatus = events.find(
      (e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false,
    );
    expect(middleEndStatus, 'middle-turn end-status must be suppressed while queued turn exists').toBeUndefined();

    await handle.close();
  });

  it('still suppresses middle-turn events after SDK drains inputQueue (bridge counter is source of truth)', async () => {
    // 反馈原型 (Codex review 3535259132 / 3535293200): 用 inputQueue.pending 判"排队 turn"
    // 有两个漏窗:
    //  (a) send 里 push /compact 后到 push user message 之间是 async 空窗
    //      (toClaudeSdkContent 图片 resize 几百 ms), SDK 可能已 drain /compact → pending 归 0
    //  (b) SDK prompt 是 AsyncIterable, 可能 eager 消费两条 → pending 归 0 但两 turn 都还在跑
    // 修复用显式桥接 turn 计数, 与 pending 无关。这条用例模拟"SDK 已 drain inputQueue
    // → pending=0"但计数仍 >0 的时刻: middle-turn 边界事件必须仍被 suppress。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 手动 drain 掉 rebuild 里 push 的 /compact + user message, 模拟 SDK 消费完毕 → pending=0。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { prompt: AsyncIterable<unknown> };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    await promptIter.next();
    await promptIter.next();

    // pending=0 后 emit /compact turn 的 result: 靠 pending 判定的旧实现会误放行,
    // 靠 bridge counter 的新实现仍 suppress (计数在 onTurnEnd 里才 -1)。
    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(beforeCount);
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.type === 'done'), 'bridge /compact turn done must stay suppressed regardless of pending').toBeUndefined();
    expect(
      events.find((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false),
      'bridge /compact turn end-status must stay suppressed regardless of pending',
    ).toBeUndefined();

    await handle.close();
  });

  it('lets end-status/done through after bridge /compact turn ends (real user turn end)', async () => {
    // 反向对照: 桥接 turn 消费掉之后 (onTurnEnd 里 counter -1 归 0), 真正用户 turn 结束
    // 时 translator 的 status(isRunning=false)+done 必须正常放行 — 否则真终态永远
    // 收不到, register.ts 上层挂死。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // ① /compact turn 结束 → onTurnEnd 消费一个 bridge turn (counter 1 → 0), 边界事件仍 suppress
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true); // 保持 in-flight (等真正用户 turn)
    });

    // ② 真正的用户 turn 结束 → counter=0 → 边界事件放行
    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 220_000, output_tokens: 100 },
    });
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThan(beforeCount);
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
    expect(
      events.some((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false),
    ).toBe(true);

    await handle.close();
  });

  it('preserves turnInFlight across the /compact → user message queued turn boundary', async () => {
    // 反馈原型: /compact 是独立 turn, SDK 处理完发 result → translator.onTurnEnd
    // 清 turnInFlight; 已排队的用户消息之后被消费起新 turn, 但没人把 turnInFlight
    // 置回 true → isTurnRunning() 返 false, rewind preview 守卫失守。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const eventIterator = handle.events()[Symbol.asyncIterator]();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    const status = await eventIterator.next();
    expect(status.value?.type).toBe('status');

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // send 后应仍处于 in-flight (compact + user 两条已在 inputQueue 排队)。
    expect(handle.isTurnRunning?.()).toBe(true);

    // 让 SDK 消费 /compact 起的 turn, 再吐一个 result 收尾 —— 这一次 onTurnEnd 触发,
    // 但 inputQueue 还剩用户消息 (pending>0), 修复后仍保持 turnInFlight=true。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 200_000, output_tokens: 10 },
    });
    // 等 forward loop 消费掉 result, 走完 translator.onTurnEnd。
    await vi.waitFor(() => {
      expect(sdkMock.query).toHaveBeenCalledTimes(2);
    });
    // 关键回归断言: 排队 turn 存在时 onTurnEnd 不该清 turnInFlight。
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });

    await handle.close();
  });

  it('bridge /compact turn end does not consume the queued plan turn state', async () => {
    // 反馈原型 (Codex review 3535545475): 用户 arm 了 plan mode 后 send, rewind 尾部又
    // 注入了 /compact bridge; SDK 消费 /compact 发 result → onTurnEnd。
    // 若 onTurnEnd 里 plan cleanup 在 bridge 消费之前跑, planTurnActive 会被清、
    // SDK 权限档会被降回底层 — 真正的用户 plan turn 就变成普通 turn 跑, plan_review 消失。
    // 修: bridge 消费必须优先, 保留 plan 状态给用户 turn。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    void (async () => {
      try { for await (const _event of handle.events()) { void _event; /* discard */ } } catch { /* ignore */ }
    })();

    // 写 usage 让 500K 窗口切换后过阈值。
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    // arm plan mode → 下一次 send 消耗 arm 态启动 plan turn。
    await handle.setPlanMode?.(true);
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5'); // 500K 窗口 → 触发 auto-compact bridge

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    // send 里消耗 plan arm: planTurnActive=true / mutablePlanMode=false / SDK 起在 plan 档;
    // rebuild 尾部触发 auto-compact bridge: queuedBridgeTurns=1。
    await handle.send({ type: 'user', content: 'draft me a plan' });

    // 快照 SDK 起 turn 时的 permissionMode / plan 状态: 起在 plan 档。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('plan');
    const permCallsBefore = secondQuery.setPermissionMode.mock.calls.length;

    // 让 SDK "跑完 /compact turn"发 result → 触发 onTurnEnd。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 10 },
    });

    // 修复前: onTurnEnd 里的 plan cleanup 会 fire, 调 setPermissionMode 把 SDK 从
    // plan 降到 acceptEdits (mutablePermissionMode) — 用户 plan turn 因此崩;
    // 修复后: bridge 消费优先, 直接 return, 不动 plan / setPermissionMode。
    await vi.waitFor(() => {
      // 等 forward loop 消费完 result 后再看 setPermissionMode 调用。
      expect(true).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));

    const permCallsAfter = secondQuery.setPermissionMode.mock.calls.length;
    expect(
      permCallsAfter - permCallsBefore,
      'bridge /compact turn must not downgrade SDK permission mode (plan → acceptEdits)',
    ).toBe(0);
    // handle 端仍视为 in-flight, 准备接用户 plan turn。
    expect(handle.isTurnRunning?.()).toBe(true);

    await handle.close();
  });

  it('suppresses middle-turn terminal error from a failed bridge /compact turn', async () => {
    // 反馈原型 (Codex review 3535545481): bridge /compact turn 内部失败 (is_error result)
    // 会走 translator terminal-error 路径, 事件类型是 error, isTerminal:true。
    // register.ts 上层拿 isTerminal 做 turn finalization / abort, 泄漏后用户消息又变第二 turn。
    // 修: filter 也 suppress bridge 期间的 terminal error。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 让 SDK 处理 /compact 时**失败**: is_error result → translator 走 terminal-error 路径,
    // 依次 push error(isTerminal:true) + status(isRunning:false) + done。
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content).toBe('hello after rewind');
    expect(rebuildArgs.prompt.pending).toBe(0);

    const beforeCount = events.length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: null,
      is_error: true,
      subtype: 'error_during_execution',
      result: 'compact failed: context too small',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await vi.waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(beforeCount);
    });
    await new Promise((r) => setTimeout(r, 20));

    // 三个边界事件都必须被 suppress: terminal error / end-status / done。
    expect(events.find((e) => e.type === 'error' && (e.data as { isTerminal?: boolean }).isTerminal === true),
      'bridge /compact terminal error must be suppressed to avoid triggering turn finalization',
    ).toBeUndefined();
    expect(events.find((e) => e.type === 'done'), 'bridge /compact done must be suppressed').toBeUndefined();
    expect(
      events.find((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === false),
      'bridge /compact end-status must be suppressed',
    ).toBeUndefined();

    // handle 保持 in-flight, 用户 turn 继续走。
    expect(handle.isTurnRunning?.()).toBe(true);

    // /compact 失败未到 compact_boundary,需要重置 auto-compact fired latch。
    // 用户 turn 结束后如果 usage 仍过阈值,应能再次排队 /compact。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 410_000, output_tokens: 10 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });
    expect(rebuildArgs.prompt.pending).toBe(1);
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');

    await handle.close();
  });

  it('upstream-idle watchdog during bridge closes query and rebuilds from rewind point', async () => {
    // 反馈原型 (Codex review 3535664420 / 3536509277): watchdog 是**直接 push eventQueue**
    // 绕过 filter;若打在 bridge /compact 上,只清 counter + interrupt 仍无法追回 SDK 已
    // eager-drain 的真实用户消息。修: watchdog 与手动 Stop 一样 close 当前 Query,保留
    // rewind resume point,下一次 send 从同一 checkpoint 重建。
    const { handle, firstQuery } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      idleTimeoutMs: 50, // 快速触发 watchdog
    });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'hello after rewind' });

    // 不 emit result — SDK 静默, watchdog 阈值内触发。
    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout',
          ),
          'watchdog terminal error must reach eventQueue (not swallowed by bridge filter)',
        ).toBe(true);
      },
      { timeout: 1000 },
    );
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout'),
      ).toBe(true);
    });

    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);

    // 旧 Query 迟到 result 必须被丢弃;下一次 send 从同一个 rewind point 重建。
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after watchdog' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after watchdog');

    await handle.close();
  });

  it('upstream-idle watchdog during bridge closes query and clears queued real user input', async () => {
    // 反馈原型 (Codex review 3535996876 / 3536509277): watchdog 打在 bridge /compact 上时,
    // 只清 counter/inputQueue 或只 interrupt 都无法取消 SDK 已 eager-drain 的真实用户消息。
    // 修: watchdog 与手动 Stop 一样 close 当前 Query,同时清尚未被 SDK 消费的本地 queue。
    const { handle, firstQuery } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      idleTimeoutMs: 50,
    });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'must be cleared by watchdog' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(2); // /compact + 真实用户消息都还没被 SDK 拉取

    await vi.waitFor(
      () => {
        expect(
          events.some(
            (e) =>
              e.type === 'error' &&
              (e.data as { reason?: string }).reason === 'upstream_response_idle_timeout',
          ),
        ).toBe(true);
      },
      { timeout: 1000 },
    );

    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(secondQuery.close).toHaveBeenCalled();
    expect(rebuildArgs.prompt.pending).toBe(0);

    await handle.close();
  });

  it('send failure after bridge compact injection cancels bridge query and preserves retry point', async () => {
    // 反馈原型 (Codex review 3535996878 / 3538382993 / 3538551816): rebuild 后先注入
    // /compact,再 await toClaudeSdkContent。若附件处理/取消在真实用户消息 push 前失败,
    // 必须取消整条 bridge query,不能让已排队 /compact 作为普通 turn 继续跑并立即重试。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    imageResizerMock.process.mockRejectedValueOnce(new Error('resize failed'));
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await expect(
      handle.send({ type: 'user', content: [{ type: 'image', path: path.join(os.tmpdir(), 'missing.png') }] }),
    ).rejects.toThrow('resize failed');

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
      options: Record<string, unknown>;
    };
    expect(rebuildArgs.prompt.pending).toBe(0);
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'done')).toBe(true);
    });
    expect(
      events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned'),
    ).toBe(true);
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;

    // 旧 query 的迟到 compact failure 不应再驱动事件或立即排队下一次 /compact。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: null,
      is_error: true,
      subtype: 'error_during_execution',
      result: 'compact failed after abandoned send',
      total_cost_usd: 0,
      usage: { input_tokens: 410_000, output_tokens: 10 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);
    expect(rebuildArgs.prompt.pending).toBe(0);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after abandoned bridge' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after abandoned bridge');

    await handle.close();
  });

  it('keeps an abandoned context-profile bridge tombstoned across a same-env model switch', async () => {
    const sameProfileAlias: ModelDescriptor = {
      ...PROVIDER_372K,
      id: 'provider/terra-alias',
      displayName: 'Terra alias',
    };
    const first = createFakeQuery();
    const second = createFakeQuery();
    let releaseClose!: () => void;
    const closeAck = new Promise<void>((resolve) => { releaseClose = resolve; });
    second.close.mockImplementationOnce(() => closeAck);
    const third = createFakeQuery();
    const { handle } = await startRewindableSession({
      autoCompactThresholdPct: 50,
      subagentModel: 'claude-haiku-4-5',
      additionalModels: [PROVIDER_372K, sameProfileAlias],
      localQueries: [first, second, third],
    });

    await handle.send({ type: 'user', content: 'establish usage before profile switch' });
    first.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 250_000, output_tokens: 0 } },
    });
    first.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 250_000, output_tokens: 20 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(false);
      expect(handle.getUsageSnapshot().contextTokens).toBe(250_000);
    });
    await handle.setModel?.(PROVIDER_372K.id);
    imageResizerMock.process.mockRejectedValueOnce(new Error('profile bridge resize failed'));

    await expect(
      handle.send({
        type: 'user',
        content: [{ type: 'image', path: path.join(os.tmpdir(), 'profile-bridge.png') }],
      }),
    ).rejects.toThrow('profile bridge resize failed');
    expect(second.close).toHaveBeenCalledTimes(1);

    await handle.setModel?.(sameProfileAlias.id);
    expect(second.setModel).not.toHaveBeenCalled();

    const retry = handle.send({ type: 'user', content: 'retry after profile bridge close ACK' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    expect(second.close).toHaveBeenCalledTimes(1);

    releaseClose();
    await retry;
    expect(sdkMock.query).toHaveBeenCalledTimes(3);
    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: { model?: string };
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.model).toBe(sameProfileAlias.id);
    const retryPrompt = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPrompt.next()).value?.message?.content).toBe('/compact');
    expect((await retryPrompt.next()).value?.message?.content)
      .toBe('retry after profile bridge close ACK');

    await handle.close();
  });

  it('send failure after bridge compact has already ended still cancels bridge query', async () => {
    // 反馈原型 (Codex review 3539298190): /compact result 可能先于图片/文件
    // content conversion 失败到达,此时 queuedBridgeTurns 已被 onTurnEnd 消费为 0,
    // 但 activeBridgeRewindResumeAt 仍保留到真实用户 turn 的首条 SDK message。catch
    // 不能只看 queuedBridgeTurns,否则已 emit isRunning:true 的 send 会卡在 running。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    let rejectResize!: (error: Error) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => { rejectResize = reject; }),
    );
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(os.tmpdir(), 'slow-missing.png') }],
    });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect(rebuildArgs.prompt.pending).toBe(0);
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0.0025,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await new Promise((r) => setTimeout(r, 20));

    rejectResize(new Error('resize failed after compact'));
    await expect(sendPromise).rejects.toThrow('resize failed after compact');

    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned'),
      ).toBe(true);
    });
    const abandonedDone = events.find(
      (e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned',
    );
    expect(abandonedDone?.data).toMatchObject({
      total_cost_usd: 0.0025,
      usage: { input_tokens: 210_000, output_tokens: 20 },
      reason: 'bridge_send_abandoned',
    });

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after compact-ended abandoned bridge' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after compact-ended abandoned bridge');

    await handle.close();
  });

  it('re-arms bridge auto-compact after compact boundary followed by send failure', async () => {
    // 反馈原型 (Codex review 3539465005): bridge /compact 已成功吐出 compact_boundary 后,
    // controller 会清 latest + fired。若随后真实用户消息的附件处理失败并回滚到 rewind
    // point,只调用 onCompactCanceled 已无 snapshot 可重试,下一次 send 会漏掉必需的 /compact。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    let rejectResize!: (error: Error) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((_resolve, reject) => { rejectResize = reject; }),
    );
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    const sendPromise = handle.send({
      type: 'user',
      content: [{ type: 'image', path: path.join(os.tmpdir(), 'compact-boundary-then-fail.png') }],
    });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');

    secondQuery.stream.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 400_000,
        post_tokens: 120_000,
        duration_ms: 10,
      },
    });
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 20 },
    });
    await new Promise((r) => setTimeout(r, 20));

    rejectResize(new Error('resize failed after compact boundary'));
    await expect(sendPromise).rejects.toThrow('resize failed after compact boundary');
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after compact-boundary abandoned bridge' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options: Record<string, unknown>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after compact-boundary abandoned bridge');

    await handle.close();
  });

  it('does not emit bridge_send_abandoned after Stop aborts a bridge send in content conversion', async () => {
    // 反馈原型 (Codex review 3540961667): rebuild 已注入 /compact,真实用户消息还在
    // toClaudeSdkContent(image/file) 里时用户点 Stop。abort 已 close query + emit
    // bridge_aborted;随后 send 观察到 aborted signal 进 catch 时必须 no-op,不能再发
    // bridge_send_abandoned 第二个终态边界。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    let resolveResize!: (value: string) => void;
    imageResizerMock.process.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveResize = resolve; }),
    );
    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    const controller = new AbortController();
    const sendPromise = handle.send(
      { type: 'user', content: [{ type: 'image', path: path.join(os.tmpdir(), 'slow-stop.png') }] },
      { signal: controller.signal },
    );

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');

    controller.abort();
    await handle.abort();
    resolveResize(path.join(os.tmpdir(), 'slow-stop.png'));
    await expect(sendPromise).rejects.toThrow('Claude send cancelled before acceptance');

    expect(secondQuery.close).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted')).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(
      events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_send_abandoned'),
      'send catch after Stop must not emit a second terminal bridge boundary',
    ).toBe(false);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(handle.isTurnRunning?.()).toBe(false);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after stop during conversion' });
    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after stop during conversion');

    await handle.close();
  });

  it('setPlanMode(true) arriving during rebuild must not upgrade a normal send to plan turn', async () => {
    // 反馈原型 (Codex review 3535660068): rebuild await 期间到达的 setPlanMode 只翻
    // mutablePlanMode(arm), replay 若用 effectiveSdkPermissionMode() 会读到 arm 态 →
    // 判定档位漂移 → 把 SDK 切到 plan, 让本轮"普通 send"意外升级为 plan turn。
    // 修: rebuild 起档 + replay 都用 currentTurnSdkPermissionMode()(只看 planTurnActive,
    // 不含 arm),arm 留给下一次 send。
    //
    // 复刻思路: mockImplementation 让 sdkMock.query 在返回 secondQuery 前**同步**改 arm 态,
    // 精确模拟 "buildQuery options 已按本 turn 普通档构造 → mockImpl 里 flip arm=true →
    // buildQuery return → replay 读 current" 的 timing。
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockImplementationOnce(() => {
      void handle.setPlanMode?.(true); // rewindPending() 短路, 只翻 mutablePlanMode arm
      return secondQuery;
    });

    await handle.send({ type: 'user', content: 'normal turn please' }, { planMode: false });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('acceptEdits');
    const planSwitches = secondQuery.setPermissionMode.mock.calls.filter((c: unknown[]) => c[0] === 'plan');
    expect(planSwitches, 'rebuild replay must not upgrade normal send to plan turn').toHaveLength(0);
    // arm 态保留: 下一次 send 才该消费。
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.close();
  });

  it('explicit normal send ignores plan arm already pending during rewind rebuild start', async () => {
    // 反馈原型 (Codex review 3535801840): plan arm 已在 rewind 窗口里存在时,
    // 排队/自动化 send 仍可能显式带 planMode:false。send 头部会判定本轮是普通 turn,
    // 但旧 buildQuery 起档仍读含 arm 态的 effectiveSdkPermissionMode() → 新 Query 从 plan 起,
    // replay 又用 turn-scoped 档看不到 diff,因此不会 downgrade,普通 turn 被误跑成 plan turn。
    const { handle } = await startRewindableSession();
    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    await handle.setPlanMode?.(true); // rewindPending() 短路,只留下 mutablePlanMode arm
    expect(handle.getPlanMode?.()).toBe(true);

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'explicit normal turn' }, { planMode: false });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as { options: Record<string, unknown> };
    expect(rebuildArgs.options.permissionMode).toBe('acceptEdits');
    const planSwitches = secondQuery.setPermissionMode.mock.calls.filter((c: unknown[]) => c[0] === 'plan');
    expect(planSwitches, 'rebuild must not start or replay this explicit normal send as plan').toHaveLength(0);
    // arm 态仍留给下一条未显式 planMode:false 的 send 消费。
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.close();
  });

  it('abort during bridge compact closes query so eager-drained user input cannot continue', async () => {
    // 反馈原型 (Codex review 3536258014): SDK 可能 eager-drain /compact 和真实用户消息。
    // Stop 只 inputQueue.clear() 时,已被 SDK 拉走的真实消息无法追回,q.interrupt() 也只
    // 中断 active /compact turn,后续真实消息仍可能继续跑。修:bridge Stop 直接 close 当前
    // Query,保留 rewind resume point,下一次 send 重新 buildQuery。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'eager-drained but should be cancelled' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect((await promptIter.next()).value?.message?.content).toBe('eager-drained but should be cancelled');
    expect(rebuildArgs.prompt.pending).toBe(0);

    await handle.abort();

    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted'),
      ).toBe(true);
    });
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;

    // 旧 Query 的迟到 result 不应再进入事件流;下一次 send 从同一个 resume point 重建。
    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'next clean turn' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('next clean turn');

    await handle.close();
  });

  it('abort after bridge compact ends but before user turn starts still cancels queued input', async () => {
    // 反馈原型 (Codex review 3536509265): SDK 跑完 bridge /compact 后,可能尚未开始
    // 后续真实用户 turn。若 onTurnEnd 在 counter 归零时立刻清 activeBridgeRewindResumeAt,
    // 这个 gap 里的 Stop 会退化成普通 q.interrupt(),既不清 queued input,也无法下次从
    // rewind point 重建。修: bridge resume point 保留到下一条 SDK message 到达。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'queued but not started' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('/compact');
    expect(rebuildArgs.prompt.pending).toBe(1);

    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 210_000, output_tokens: 10 },
    });
    await vi.waitFor(() => {
      expect(handle.isTurnRunning?.()).toBe(true);
    });
    expect(rebuildArgs.prompt.pending).toBe(1);

    await handle.abort();

    expect(secondQuery.close).toHaveBeenCalled();
    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(rebuildArgs.prompt.pending).toBe(0);
    expect(handle.isTurnRunning?.()).toBe(false);
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted'),
      ).toBe(true);
    });
    const doneCountBeforeLateResult = events.filter((e) => e.type === 'done').length;

    secondQuery.stream.emit({
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountBeforeLateResult);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after gap stop' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after gap stop');

    await handle.close();
  });

  it('abort during bridge compact closes query and clears queued input', async () => {
    // 反馈原型 (Codex review 3535801846): Stop 发生在 rebuild 注入的 /compact bridge turn
    // 正在跑时,旧 onTurnEnd 会把 interrupted /compact result 当 bridge result 消费:counter-- 后
    // return,不清 turnInFlight,也不放行 done/status;同时 inputQueue 里的真实用户消息仍可能继续跑。
    // 修: abort 先 close 当前 Query 取消 SDK 侧已 drain 的后续输入,并 clear 尚未被 SDK
    // 消费的本地 queued input。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'should be cancelled by stop' });

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    const promptIter = rebuildArgs.prompt[Symbol.asyncIterator]();
    const compactInput = await promptIter.next();
    expect(compactInput.value?.message?.content).toBe('/compact');
    expect(rebuildArgs.prompt.pending).toBe(1); // 真实用户消息仍在本地 queue 中等待 SDK 拉取

    await handle.abort();

    expect(secondQuery.close).toHaveBeenCalled();
    expect(secondQuery.interrupt).not.toHaveBeenCalled();
    expect(rebuildArgs.prompt.pending).toBe(0); // Stop 丢弃尚未被 SDK 消费的真实用户消息

    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_aborted'),
      ).toBe(true);
    });
    const doneCountAfterFirstAbort = events.filter((e) => e.type === 'done').length;

    // 重复 / 迟到的 Stop 不能再次进入 bridge-cancel 分支,否则会重复发 turn boundary。
    await handle.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(secondQuery.close).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(doneCountAfterFirstAbort);

    const thirdQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(thirdQuery);
    await handle.send({ type: 'user', content: 'retry after stop' });

    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      options: Record<string, unknown>;
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
    };
    expect(retryArgs.options.forkSession).toBe(true);
    expect(retryArgs.options.resumeSessionAt).toBe('assistant-uuid-1');
    const retryPromptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await retryPromptIter.next()).value?.message?.content).toBe('/compact');
    expect((await retryPromptIter.next()).value?.message?.content).toBe('retry after stop');

    await handle.close();
  });

  it('keeps applying runtime settings while bridge compact is running', async () => {
    // activeBridgeRewindResumeAt 保留期间有两种状态:
    //  - Stop/watchdog 已 close 当前 Query → control request 必须跳过, 等下次 rebuild
    //  - 正常 bridge /compact 正在跑 → 当前 Query 仍可写,运行时设置必须继续打给 SDK
    // 这条覆盖第二种,避免长 compact 窗口里切模型/权限档只改闭包不改 live q。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'long bridge compact' });

    await expect(handle.setModel?.('claude-opus-4-6')).resolves.toBeUndefined();
    await expect(handle.setEffort?.('xhigh')).resolves.toBeUndefined();
    await expect(handle.setFastMode?.(true)).resolves.toBeUndefined();
    await expect(handle.setPermissionMode?.('auto')).resolves.toBeUndefined();

    expect(secondQuery.setModel).toHaveBeenCalledWith('claude-opus-4-6[1m]');
    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' });
    expect(secondQuery.applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    // Cindy 档 'auto' 映射到 SDK 'default'(见 toSdkPermissionMode)。
    expect(secondQuery.setPermissionMode).toHaveBeenCalledWith('default');

    await handle.close();
  });

  it('cancels a rewind rebuild before bridge compact or turn-start side effects', async () => {
    // 反馈原型: Session.abort() 可在 await buildQuery 期间取消 sendOpts.signal。
    // rebuild resolve 后必须立刻检查 signal,否则会继续注入 /compact、emit running status,
    // 最后才在内容转换处抛取消,留下没有真实用户输入的 in-flight turn。
    const { handle } = await startRewindableSession();
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    let resolveRebuild!: (query: ReturnType<typeof createFakeQuery>) => void;
    const rebuildPromise = new Promise<ReturnType<typeof createFakeQuery>>((resolve) => {
      resolveRebuild = resolve;
    });
    sdkMock.query.mockImplementationOnce(() => rebuildPromise as unknown as ReturnType<typeof createFakeQuery>);
    const controller = new AbortController();

    const sendPromise = handle.send({ type: 'user', content: 'cancel during rebuild' }, { signal: controller.signal });
    await vi.waitFor(() => {
      expect(sdkMock.query).toHaveBeenCalledTimes(2);
    });

    controller.abort();
    const secondQuery = createFakeQuery();
    resolveRebuild(secondQuery);

    await expect(sendPromise).rejects.toThrow(/cancelled before acceptance/i);
    expect(secondQuery.close).toHaveBeenCalled();
    expect(handle.isTurnRunning?.()).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(
      events.some((e) => e.type === 'status' && (e.data as { isRunning?: boolean }).isRunning === true),
      'cancelled rebuild must not emit a running turn status',
    ).toBe(false);

    await handle.close();
  });

  it('cancels replacement stabilization before starting a turn', async () => {
    // Replacement stabilization can still be awaiting a control mutation before the
    // user input is accepted. Stop must retire that candidate without creating a
    // synthetic product turn or leaking the rejected input into the next Query.
    const { handle } = await startRewindableSession();
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');

    const secondQuery = createFakeQuery();
    const thirdQuery = createFakeQuery();
    let resolveFirstReplay!: () => void;
    let notifyFirstReplayStarted!: () => void;
    let resolveAcceptReplay!: () => void;
    let notifyAcceptReplayStarted!: () => void;
    const firstReplayStarted = new Promise<void>((resolve) => { notifyFirstReplayStarted = resolve; });
    const firstReplayHold = new Promise<void>((resolve) => { resolveFirstReplay = resolve; });
    const acceptReplayStarted = new Promise<void>((resolve) => { notifyAcceptReplayStarted = resolve; });
    const acceptReplayHold = new Promise<void>((resolve) => { resolveAcceptReplay = resolve; });
    let setModelCalls = 0;
    secondQuery.setModel.mockImplementation(async () => {
      setModelCalls += 1;
      if (setModelCalls === 1) {
        notifyFirstReplayStarted();
        await firstReplayHold;
        return;
      }
      notifyAcceptReplayStarted();
      await acceptReplayHold;
    });
    sdkMock.query
      .mockImplementationOnce(() => {
        void handle.setModel?.('claude-sonnet-5');
        return secondQuery;
      })
      .mockReturnValue(thirdQuery);
    const controller = new AbortController();

    const sendPromise = handle.send(
      { type: 'user', content: 'cancel during accept replay' },
      { signal: controller.signal },
    );
    await firstReplayStarted;
    resolveFirstReplay();
    // The replay continuation runs first, then this microtask changes mutable
    // state while the outer send is yielding at its final rebuild barrier.
    // That creates genuine drift for the separate acceptance replay.
    queueMicrotask(() => {
      queueMicrotask(() => { void handle.setModel?.('claude-opus-4-6'); });
    });
    await acceptReplayStarted;
    expect(handle.isTurnRunning?.()).toBe(false);

    controller.abort();
    await handle.abort();
    resolveAcceptReplay();

    await expect(sendPromise).rejects.toThrow('Claude send cancelled before acceptance');
    expect(handle.isTurnRunning?.()).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(secondQuery.close).toHaveBeenCalledTimes(1);

    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(rebuildArgs.prompt.pending).toBe(0);
    await handle.send({ type: 'user', content: 'next after accept replay cancellation' });
    expect(sdkMock.query).toHaveBeenCalledTimes(3);
    const retryArgs = sdkMock.query.mock.calls[2]?.[0] as {
      prompt: AsyncIterable<{ message?: { content?: unknown } }> & { pending: number };
    };
    expect(retryArgs.prompt.pending).toBe(1);
    const promptIter = retryArgs.prompt[Symbol.asyncIterator]();
    expect((await promptIter.next()).value?.message?.content).toBe('next after accept replay cancellation');

    await handle.close();
  });

  it('tears down and emits a terminal boundary if bridge compact stream crashes', async () => {
    // bridge /compact 的 SDK stream 自发抛错不是主动 Stop/watchdog close,不能按 rewind
    // transition 静默;否则 queuedBridgeTurns 会残留并吞掉下一次真实用户 turn 的终态。
    const { handle, firstQuery } = await startRewindableSession({ autoCompactThresholdPct: 50 });
    const events: AgentEvent[] = [];
    void (async () => {
      try { for await (const ev of handle.events()) events.push(ev); } catch { /* ignore */ }
    })();

    firstQuery.stream.emit({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { input_tokens: 400_000, output_tokens: 0 } },
    });
    await vi.waitFor(() => {
      expect(handle.getUsageSnapshot().contextTokens).toBe(400_000);
    });

    await handle.commitRewindFiles?.('user-uuid-1', 'assistant-uuid-1');
    await handle.setModel?.('claude-sonnet-5');

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'will be cancelled by bridge crash' });

    secondQuery.stream.fail(new Error('bridge stream exploded'));

    await vi.waitFor(() => {
      expect(
        events.some(
          (e) =>
            e.type === 'error' &&
            (e.data as { reason?: string; isTerminal?: boolean }).reason === 'bridge_sdk_stream_crashed' &&
            (e.data as { isTerminal?: boolean }).isTerminal === true,
        ),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        events.some((e) => e.type === 'done' && (e.data as { reason?: string }).reason === 'bridge_sdk_stream_crashed'),
      ).toBe(true);
    });
    expect(handle.isTurnRunning?.()).toBe(false);
  });
});
