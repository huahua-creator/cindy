/**
 * 刀 4：effective provider 纯函数。dc703d5e 只作 override key，不写生产盘。
 */

import { describe, expect, it } from 'vitest';

import { resolveEffectiveProvider } from '../resolve-effective-memory-provider.js';

const PRODUCTION_WORKSPACE = 'dc703d5e-1ce0-4543-be4d-014cfa3a1955';

describe('resolveEffectiveProvider', () => {
  it('prefers review and remote over workspace override', () => {
    const settings = {
      defaultProvider: 'internal' as const,
      workspaceOverrides: { [PRODUCTION_WORKSPACE]: 'xdt' as const },
    };
    expect(resolveEffectiveProvider({
      reviewMode: true,
      canonicalWorkspaceId: PRODUCTION_WORKSPACE,
      settings,
    })).toBe('disabled');
    expect(resolveEffectiveProvider({
      remoteHostId: 'host-1',
      canonicalWorkspaceId: PRODUCTION_WORKSPACE,
      settings,
    })).toBe('disabled');
  });

  it('applies a workspace override only when a canonical id is present', () => {
    const settings = {
      defaultProvider: 'internal' as const,
      workspaceOverrides: { [PRODUCTION_WORKSPACE]: 'xdt' as const },
    };
    expect(resolveEffectiveProvider({
      canonicalWorkspaceId: PRODUCTION_WORKSPACE,
      settings,
    })).toBe('xdt');
    expect(resolveEffectiveProvider({ settings })).toBe('internal');
    expect(resolveEffectiveProvider({
      canonicalWorkspaceId: '11111111-1111-4111-8111-111111111111',
      settings,
    })).toBe('internal');
  });

  it('falls back to owner default when settings are missing', () => {
    expect(resolveEffectiveProvider({})).toBe('internal');
    expect(resolveEffectiveProvider({
      canonicalWorkspaceId: PRODUCTION_WORKSPACE,
    })).toBe('internal');
  });
});
