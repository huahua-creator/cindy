/**
 * 本刀不得改 MakerMemoryManager.enable() 全局语义：先 enabled=true，再 best-effort 关原生。
 */

import { describe, expect, it, vi } from 'vitest';

import { MakerMemoryManager } from './manager.js';
import type { Logger } from '../interfaces/logger.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

describe('MakerMemoryManager.enable semantics', () => {
  it('sets enabled=true before native setMemory(false)', async () => {
    const order: string[] = [];
    const setMemory = vi.fn(async () => {
      order.push(`setMemory:${manager.isEnabled()}`);
      return { effective: 'next-session' as const };
    });
    const manager = new MakerMemoryManager({
      basePath: '/tmp/maker-memory-enable-semantics',
      sqliteFactory: () => {
        throw new Error('enable must not open sqlite');
      },
      agents: { 'claude-code': { setMemory } as never },
      logger: noopLogger,
      initialEnabled: false,
    });
    const result = await manager.enable();
    expect(manager.isEnabled()).toBe(true);
    expect(order).toEqual(['setMemory:true']);
    expect(result.effective).toBe('next-session');
  });

  it('throws on manager.write for an xdt read-only scope', async () => {
    const manager = new MakerMemoryManager({
      basePath: '/tmp/maker-memory-xdt-readonly',
      sqliteFactory: () => {
        throw new Error('xdt write must fail before opening sqlite');
      },
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
    });
    manager.markXdtReadOnlyScope('/tmp/xdt-fixture-repo');
    await expect(
      manager.write('/tmp/xdt-fixture-repo', {
        type: 'digest',
        name: 'digest-x',
        title: 'no',
        description: 'must not persist',
        body: 'nope',
        mode: 'create',
      }),
    ).rejects.toMatchObject({ code: 'not-ready' });
  });
});
