import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { XdtPrepareError } from '@cindy/maker-core';

const harness = vi.hoisted(() => ({
  userData: '',
  mode: 'local' as 'signed-out' | 'local' | 'cloud',
  ownerId: 'local-owner' as string | null,
  boundaryPending: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => harness.userData },
}));

const dialogueHarness = vi.hoisted(() => ({ root: '' }));

vi.mock('../../appSessionState.js', () => ({
  LOCAL_DATA_OWNER_ID: 'local-owner',
  dataOwnerStorageKey: () => 'abc123',
  getActiveAppSession: () => ({
    mode: harness.mode,
    dataOwnerId: harness.ownerId,
    generation: 1,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
}));

vi.mock('../../localDb/dialogueWorkspace.js', () => ({
  dialogueWorkspaceRootDir: () => dialogueHarness.root || path.join(tmpdir(), 'cindy-xdt-no-dialogue'),
}));

import {
  assertEligibleLocalProjectDir,
  resolveOwnerScopedRegistryRoot,
} from '../workspace-identity-assembler';

const temps: string[] = [];

afterEach(async () => {
  harness.mode = 'local';
  harness.ownerId = 'local-owner';
  harness.boundaryPending = false;
  dialogueHarness.root = '';
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

describe('resolveOwnerScopedRegistryRoot', () => {
  it('fails before path join when signed-out', async () => {
    harness.userData = await tempDir('cindy-xdt-userdata-');
    harness.mode = 'signed-out';
    harness.ownerId = null;
    expect(() => resolveOwnerScopedRegistryRoot()).toThrow(XdtPrepareError);
    expect(() => resolveOwnerScopedRegistryRoot()).toThrow(/WORKSPACE_IDENTITY_REQUIRED/);
  });

  it('fails when an app-session boundary is pending', async () => {
    harness.userData = await tempDir('cindy-xdt-userdata-');
    harness.boundaryPending = true;
    expect(() => resolveOwnerScopedRegistryRoot()).toThrow(/WORKSPACE_IDENTITY_REQUIRED/);
  });

  it('uses the maker-memory-host formula for a local owner', async () => {
    harness.userData = await tempDir('cindy-xdt-userdata-');
    expect(resolveOwnerScopedRegistryRoot()).toEqual({
      dataOwnerId: 'local-owner',
      ownerRoot: path.join(harness.userData, 'owners', 'abc123'),
    });
  });
});

describe('assertEligibleLocalProjectDir', () => {
  it('accepts a real temp project directory', async () => {
    const dir = await tempDir('cindy-xdt-project-');
    expect(assertEligibleLocalProjectDir(dir).length).toBeGreaterThan(0);
  });

  it('rejects basename, relative, remote, and managed worktree paths', async () => {
    expect(() => assertEligibleLocalProjectDir('claude_obsidian_work')).toThrow(/MAKER_MEMORY_NOT_READY/);
    expect(() => assertEligibleLocalProjectDir('relative/project')).toThrow(/MAKER_MEMORY_NOT_READY/);
    expect(() => assertEligibleLocalProjectDir('ssh://host/repo')).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() => assertEligibleLocalProjectDir('\\\\server\\share\\proj')).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() => assertEligibleLocalProjectDir('//server/share/proj')).toThrow(/UNSUPPORTED_CAPABILITY/);
    const repo = await tempDir('cindy-xdt-base-');
    const worktree = path.join(repo, '.cindy-worktrees', 'ghost');
    await mkdir(worktree, { recursive: true });
    expect(() => assertEligibleLocalProjectDir(worktree)).toThrow(/UNSUPPORTED_CAPABILITY/);
    const legacy = path.join(repo, '.xdt-worktrees', 'ghost');
    await mkdir(legacy, { recursive: true });
    expect(() => assertEligibleLocalProjectDir(legacy)).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() => assertEligibleLocalProjectDir(path.join(repo, '.cindy-worktrees'))).toThrow(
      /UNSUPPORTED_CAPABILITY/,
    );
  });

  it('rejects directories under the dialogue workspace root', async () => {
    const root = await tempDir('cindy-xdt-dialogue-root-');
    dialogueHarness.root = root;
    const child = path.join(root, '2026-09-17', 'session-1');
    await mkdir(child, { recursive: true });
    expect(() => assertEligibleLocalProjectDir(child)).toThrow(/UNSUPPORTED_CAPABILITY/);
  });
});
