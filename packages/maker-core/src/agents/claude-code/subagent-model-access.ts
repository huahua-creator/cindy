import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

export type ClaudeSubagentModelAccessStatus = 'allowed' | 'denied' | 'unknown';

export interface ClaudeSubagentModelAccessResult {
  status: ClaudeSubagentModelAccessStatus;
  /** 可选的 host 诊断；只有 denied 会展示给用户。 */
  reason?: string;
}

export type ResolveClaudeSubagentModelAccess = (
  model: string,
) => ClaudeSubagentModelAccessResult | Promise<ClaudeSubagentModelAccessResult>;

export type ClaudeSubagentContextSafetySnapshot =
  | {
      status: 'ready';
      unsafeAgentNames: readonly string[];
      /** A verified/native env override wins over definitions and tool input. */
      forcedModelActive?: boolean;
    }
  | { status: 'inventory-unavailable' }
  | { status: 'profile-transition' }
  | { status: 'forced-model-unknown'; model: string };

export type ResolveClaudeSubagentContextSafety = () => ClaudeSubagentContextSafetySnapshot;

export function normalizeClaudeSubagentModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.endsWith('[1m]')
    ? normalized.slice(0, -'[1m]'.length)
    : normalized;
}

/**
 * 返回 Agent/Task 实际会用的显式模型。平台 env 覆写优先于 tool input；
 * 缺省和 inherit 都交给 Claude 自己解析，不对无法证明的隐式默认值做拦截。
 */
export function effectiveClaudeSubagentModel(
  forcedModel: string | undefined,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (toolName !== 'Agent' && toolName !== 'Task') return undefined;
  const input = typeof toolInput === 'object' && toolInput !== null
    ? toolInput as Record<string, unknown>
    : {};
  const requested = typeof input.model === 'string' ? input.model : '';
  const effective = normalizeClaudeSubagentModel(forcedModel ?? requested);
  return !effective || effective === 'inherit' ? undefined : effective;
}

export function claudeSubagentModelDenialReason(model: string, detail?: string): string {
  return detail?.trim()
    || `Subagent model "${model}" is not available from the current account and provider. Choose an available model, or remove the unavailable override from the Agent call or Subagent Model setting.`;
}

const NATIVE_SUBAGENT_MODEL_OVERRIDES = new Set(['sonnet', 'opus', 'haiku', 'fable']);

function isNativeSubagentModelOverride(model: string): boolean {
  const normalized = normalizeClaudeSubagentModel(model);
  // AgentInput.model is an SDK alias field, not the unrestricted catalog id
  // accepted by the parent Query. Treating arbitrary `claude-*` strings as a
  // native override would let a custom provider-shaped name bypass an unsafe
  // agent definition.
  return NATIVE_SUBAGENT_MODEL_OVERRIDES.has(normalized);
}

/**
 * Keep context-window uncertainty scoped to the risky Agent/Task action. The
 * main Query remains usable, but an unavailable inventory blocks all
 * subagents, and an unverified named definition is blocked unless the call
 * explicitly selects a native Claude model. A forced env model has highest
 * precedence and therefore blocks every subagent call when it is unverified.
 */
export function buildClaudeSubagentContextWindowGuardHooks(
  resolveSafety: ResolveClaudeSubagentContextSafety,
  onDeny?: (reason: string) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const deny = (reason: string) => {
    onDeny?.(reason);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: reason,
      },
    };
  };
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== 'Agent' && pre.tool_name !== 'Task') return { continue: true };
    const safety = resolveSafety();
    if (safety.status === 'forced-model-unknown') {
      return deny(
        `Subagent execution is disabled because forced model "${safety.model}" has no verified context window. Verify that provider model or clear the Subagent Model setting.`,
      );
    }
    if (safety.status === 'inventory-unavailable') {
      return deny(
        'Subagent execution is disabled because Claude Code could not verify the active agent inventory. Rebuild the session and retry.',
      );
    }
    if (safety.status === 'profile-transition') {
      return deny(
        'Subagent execution is disabled until the pending context-window profile change rebuilds the Claude Query. Retry after the next explicit send.',
      );
    }
    if (safety.forcedModelActive) return { continue: true };

    const toolInput = typeof pre.tool_input === 'object' && pre.tool_input !== null
      ? pre.tool_input as Record<string, unknown>
      : {};
    const requestedModel = typeof toolInput.model === 'string'
      ? toolInput.model.trim()
      : '';
    if (
      requestedModel
      && normalizeClaudeSubagentModel(requestedModel) !== 'inherit'
      && isNativeSubagentModelOverride(requestedModel)
    ) return { continue: true };

    const subagentType = typeof toolInput.subagent_type === 'string'
      ? toolInput.subagent_type.trim().toLowerCase()
      : 'general-purpose';
    const unsafe = new Set(safety.unsafeAgentNames.map((name) => name.trim().toLowerCase()));
    if (!unsafe.has(subagentType)) return { continue: true };
    return deny(
      `Subagent "${subagentType}" is disabled because its configured provider model has no verified context window. Choose a native Claude model override or verify the configured provider model first.`,
    );
  };

  return { PreToolUse: [{ hooks: [guard] }] };
}

/**
 * PreToolUse 先于权限模式执行，因此 Full access 也无法绕过。resolver 每次调用都
 * 现场读取 host 的当前账号/路由状态；缺失、异常或 unknown 一律放行，防止静态目录
 * 或旧快照被误当成权限拒绝。
 */
export function buildClaudeSubagentModelGuardHooks(
  resolveAccess: ResolveClaudeSubagentModelAccess | undefined,
  forcedModel?: string,
  onDeny?: (model: string) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!resolveAccess) return {};

  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    const model = effectiveClaudeSubagentModel(forcedModel, pre.tool_name, pre.tool_input);
    if (!model) return { continue: true };

    let access: ClaudeSubagentModelAccessResult;
    try {
      access = await resolveAccess(model);
    } catch {
      return { continue: true };
    }
    if (access.status !== 'denied') return { continue: true };

    onDeny?.(model);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: claudeSubagentModelDenialReason(model, access.reason),
      },
    };
  };

  return { PreToolUse: [{ hooks: [guard] }] };
}
