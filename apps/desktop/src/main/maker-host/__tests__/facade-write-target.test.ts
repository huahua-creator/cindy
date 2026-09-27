/**
 * 前置刀 1c：写路径守卫。缺字段 / 生产树 / 禁 UUID / junction 必须在 MemoryStore 之前失败。
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveXdtMemoryRoot } from '@cindy/maker-core';

import {
  assertWriteTarget,
  FacadeWriteTargetError,
} from '../facade-write-target.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('facade write target', () => {
  it('rejects missing Host-injected roots before any store construction', async () => {
    expect(() => assertWriteTarget(undefined)).toThrow(FacadeWriteTargetError);
    expect(() => assertWriteTarget({ repoRoot: '', dataRoot: '', workspace: '' })).toThrow(
      /WRITE_TARGET_REQUIRED/,
    );
  });

  it('rejects production and sandbox workspaces', async () => {
    const repoRoot = await tempDir('cindy-facade-1c-ws-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    expect(() => assertWriteTarget({
      repoRoot,
      dataRoot,
      workspace: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
    })).toThrow(/WRITE_TARGET_FORBIDDEN/);
    expect(() => assertWriteTarget({
      repoRoot,
      dataRoot,
      workspace: '5fb84df7-8de0-4f74-a7ff-6c7b0850f317',
    })).toThrow(/WRITE_TARGET_FORBIDDEN/);
  });

  it('rejects the production xdt-memory checkout as repoRoot', () => {
    const production = resolveXdtMemoryRoot();
    expect(() => assertWriteTarget({
      repoRoot: production,
      dataRoot: path.join(production, 'data'),
      workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).toThrow(/WRITE_TARGET_FORBIDDEN/);
    expect(() => assertWriteTarget({
      repoRoot: 'D:/AI/Codex/xdt-memory',
      dataRoot: 'D:/AI/Codex/xdt-memory/data',
      workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).toThrow(/WRITE_TARGET_FORBIDDEN/);
  });

  it('rejects a Windows junction whose realpath is production data', async () => {
    const productionData = path.join(resolveXdtMemoryRoot(), 'data');
    const repoRoot = await tempDir('cindy-facade-1c-junc-repo-');
    const link = path.join(repoRoot, 'data');
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, productionData], { windowsHide: true });
    expect(() => assertWriteTarget({
      repoRoot,
      dataRoot: link,
      workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).toThrow(/WRITE_TARGET_FORBIDDEN/);
  });

  it('allows the production UUID only on an injected non-production tree', async () => {
    const repoRoot = await tempDir('cindy-facade-prod-uuid-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    expect(assertWriteTarget({
      repoRoot,
      dataRoot,
      workspace: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
    }, { allowProductionWorkspace: true })).toEqual({
      repoRoot: expect.stringMatching(/cindy-facade-prod-uuid-repo-/),
      dataRoot: expect.stringMatching(/data$/),
      workspace: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
    });
    expect(() => assertWriteTarget({
      repoRoot,
      dataRoot,
      workspace: '5fb84df7-8de0-4f74-a7ff-6c7b0850f317',
    }, { allowProductionWorkspace: true })).toThrow(/WRITE_TARGET_FORBIDDEN/);
    const production = resolveXdtMemoryRoot();
    expect(() => assertWriteTarget({
      repoRoot: production,
      dataRoot: path.join(production, 'data'),
      workspace: 'dc703d5e-1ce0-4543-be4d-014cfa3a1955',
    }, { allowProductionWorkspace: true })).toThrow(/WRITE_TARGET_FORBIDDEN/);
  });

  it('accepts an isolated tree whose dataRoot is inside repoRoot', async () => {
    const repoRoot = await tempDir('cindy-facade-1c-ok-repo-');
    const dataRoot = path.join(repoRoot, 'data');
    await mkdir(dataRoot, { recursive: true });
    expect(assertWriteTarget({
      repoRoot,
      dataRoot,
      workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).toEqual({
      repoRoot: expect.stringMatching(/cindy-facade-1c-ok-repo-/),
      dataRoot: expect.stringMatching(/data$/),
      workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
  });
});
