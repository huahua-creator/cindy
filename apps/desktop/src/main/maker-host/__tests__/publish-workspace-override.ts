/**
 * 测试夹具：在隔离 temp ownerRoot 上写 workspaceOverrides，不改 defaultProvider。
 * 禁止对生产 Roaming Cindy 调用。
 */

import { randomUUID } from 'node:crypto';

import {
  loadMemoryProviderSettings,
  publishMemoryProviderSettings,
  type MemoryProviderKind,
  type RegistryOwnerScope,
} from '../workspace-identity-registry.js';

function assertIsolatedOwnerRoot(ownerRoot: string): void {
  const normalized = ownerRoot.replaceAll('\\', '/');
  if (/AppData\/Roaming\/Cindy/i.test(normalized) || /cindy-no-session/i.test(normalized)) {
    throw new Error(`publishWorkspaceMemoryProviderOverride must not use production userData: ${ownerRoot}`);
  }
}

export async function publishWorkspaceMemoryProviderOverride(
  scope: RegistryOwnerScope & { canonicalWorkspaceId: string; provider: MemoryProviderKind },
): Promise<void> {
  assertIsolatedOwnerRoot(scope.ownerRoot);
  const current = await loadMemoryProviderSettings(scope);
  const previous = current.settings;
  await publishMemoryProviderSettings({
    dataOwnerId: scope.dataOwnerId,
    ownerRoot: scope.ownerRoot,
    settings: {
      schemaVersion: 1,
      defaultProvider: previous?.defaultProvider ?? 'internal',
      workspaceOverrides: {
        ...(previous?.workspaceOverrides ?? {}),
        [scope.canonicalWorkspaceId]: scope.provider,
      },
      configGeneration: `cfg-override-${randomUUID()}`,
    },
  });
}
