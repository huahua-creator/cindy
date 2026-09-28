/**
 * 刀 4：effective memory provider 选择。
 * review/remote/disabled 优先 → workspaceOverrides[canonicalId] → owner default。
 * 没有 canonical ID 不得应用 override。禁止只读 defaultProvider。
 */

import type { MemoryProviderKind, MemoryProviderSettingsV1 } from './workspace-identity-registry.js';

export type EffectiveMemoryProvider = MemoryProviderKind | 'disabled';

export interface ResolveEffectiveProviderInput {
  reviewMode?: boolean;
  remoteHostId?: string;
  canonicalWorkspaceId?: string;
  settings?: Pick<MemoryProviderSettingsV1, 'defaultProvider' | 'workspaceOverrides'> | undefined;
}

export function resolveEffectiveProvider(input: ResolveEffectiveProviderInput): EffectiveMemoryProvider {
  if (input.reviewMode || input.remoteHostId) return 'disabled';
  const defaults = input.settings?.defaultProvider ?? 'internal';
  const canonical = input.canonicalWorkspaceId;
  if (!canonical) return defaults;
  const override = input.settings?.workspaceOverrides?.[canonical];
  return override ?? defaults;
}
