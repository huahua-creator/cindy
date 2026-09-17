/**
 * 段 3 workspace identity IPC：无 owner / 未确认 / 幂等 / unreadable /
 * dialogue/remote/worktree 直调被拒。有 UUID ≠ 启用 xdt。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { XdtPrepareError } from '@cindy/maker-core';

import { createIpcError } from '../../../shared/ipc-errors.js';
import { createWorkspaceIdentityIpc } from '../workspace-identity-ipc.js';
import {
  createLocalAlias,
  lookupLocalAlias,
  readRegistry,
} from '../../maker-host/workspace-identity-registry.js';

const EVENT = { senderFrame: 'trusted' };
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function trustedIpc(ownerRoot: string, dataOwnerId = 'owner-fixture-1') {
  return createWorkspaceIdentityIpc({
    assertTrustedSender: vi.fn(),
    resolveOwner: () => ({ dataOwnerId, ownerRoot }),
    assertEligibleDir: (absDir) => absDir,
    lookup: lookupLocalAlias,
    create: createLocalAlias,
    read: readRegistry,
  });
}

describe('workspace identity IPC', () => {
  it('rejects untrusted senders before mkdir', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-untrusted-');
    const absDir = await tempDir('cindy-xdt-ipc-ws-');
    const ipc = createWorkspaceIdentityIpc({
      assertTrustedSender: () => {
        throw createIpcError('PERMISSION_DENIED', 'untrusted');
      },
      resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
    });
    await expect(ipc.create(EVENT, { absDir, confirmed: true })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await readFile(ownerRoot, 'utf8').catch(() => 'ok-dir')).toBe('ok-dir');
  });

  it('fails before path join when owner is missing', async () => {
    const absDir = await tempDir('cindy-xdt-ipc-no-owner-ws-');
    const ipc = createWorkspaceIdentityIpc({
      assertTrustedSender: vi.fn(),
      resolveOwner: () => {
        throw new XdtPrepareError('WORKSPACE_IDENTITY_REQUIRED', 'no owner');
      },
      assertEligibleDir: (dir) => dir,
    });
    await expect(ipc.lookup(EVENT, { absDir })).rejects.toMatchObject({
      code: 'WORKSPACE_IDENTITY_REQUIRED',
    });
    await expect(ipc.create(EVENT, { absDir, confirmed: true })).rejects.toMatchObject({
      code: 'WORKSPACE_IDENTITY_REQUIRED',
    });
  });

  it('requires confirmed === true and does not mkdir on a missing confirmed field', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-unconfirmed-');
    const absDir = await tempDir('cindy-xdt-ipc-ws-');
    const create = vi.fn();
    const ipc = createWorkspaceIdentityIpc({
      assertTrustedSender: vi.fn(),
      resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
      assertEligibleDir: (dir) => dir,
      create,
    });
    await expect(ipc.create(EVENT, { absDir })).rejects.toMatchObject({
      code: 'WORKSPACE_IDENTITY_REQUIRED',
    });
    await expect(ipc.create(EVENT, { absDir, confirmed: false })).rejects.toMatchObject({
      code: 'WORKSPACE_IDENTITY_REQUIRED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects renderer-supplied ownerRoot / UUID', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-extra-');
    const absDir = await tempDir('cindy-xdt-ipc-ws-');
    const ipc = trustedIpc(ownerRoot);
    await expect(
      ipc.lookup(EVENT, { absDir, dataOwnerId: 'spoof' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      ipc.create(EVENT, { absDir, confirmed: true, ownerRoot: '/spoof', canonicalWorkspaceId: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('creates then looks up the same realpath idempotently', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-ok-');
    const absDir = await tempDir('cindy-xdt-ipc-ws-');
    const ipc = trustedIpc(ownerRoot);
    const first = await ipc.create(EVENT, { absDir, confirmed: true });
    expect(first.status).toBe('bound');
    expect(first.created).toBe(true);
    const second = await ipc.create(EVENT, { absDir, confirmed: true });
    expect(second.canonicalWorkspaceId).toBe(first.canonicalWorkspaceId);
    expect(second.created).toBe(false);
    const looked = await ipc.lookup(EVENT, { absDir });
    expect(looked).toEqual({
      status: 'bound',
      canonicalWorkspaceId: first.canonicalWorkspaceId,
      locatorDigest: first.locatorDigest,
    });
  });

  it('maps unreadable registry to CONFIG_INVALID instead of a third 200 status', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-bad-');
    const absDir = await tempDir('cindy-xdt-ipc-ws-');
    await writeFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), '{not-json', 'utf8');
    const ipc = trustedIpc(ownerRoot);
    await expect(ipc.lookup(EVENT, { absDir })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(ipc.create(EVENT, { absDir, confirmed: true })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(await readFile(path.join(ownerRoot, 'workspace-identity-registry-v1.json'), 'utf8')).toBe(
      '{not-json',
    );
  });

  it('does not reuse contacts IDENTITY_CONFLICT for workspace identity', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-conflict-');
    const absDir = await tempDir('cindy-xdt-ipc-ws-');
    const ipc = createWorkspaceIdentityIpc({
      assertTrustedSender: vi.fn(),
      resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
      assertEligibleDir: (dir) => dir,
      create: async () => {
        throw new XdtPrepareError(
          'WORKSPACE_IDENTITY_CONFLICT',
          'locatorDigest already bound to another active canonicalWorkspaceId',
        );
      },
    });
    await expect(ipc.create(EVENT, { absDir, confirmed: true })).rejects.toMatchObject({
      code: 'WORKSPACE_IDENTITY_CONFLICT',
    });
  });
});

describe('workspace identity IPC eligibility gate', () => {
  it('maps Host eligibility rejection for remote/worktree/basename', async () => {
    const ownerRoot = await tempDir('cindy-xdt-ipc-gate-');
    const ipc = createWorkspaceIdentityIpc({
      assertTrustedSender: vi.fn(),
      resolveOwner: () => ({ dataOwnerId: 'owner-fixture-1', ownerRoot }),
    });
    await expect(ipc.lookup(EVENT, { absDir: 'claude_obsidian_work' })).rejects.toMatchObject({
      code: 'MAKER_MEMORY_NOT_READY',
    });
    await expect(ipc.create(EVENT, { absDir: 'ssh://host/repo', confirmed: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    await expect(
      ipc.create(EVENT, { absDir: '\\\\server\\share\\proj', confirmed: true }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      ipc.create(EVENT, { absDir: '//server/share/proj', confirmed: true }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const repo = await tempDir('cindy-xdt-ipc-repo-');
    const worktree = path.join(repo, '.cindy-worktrees', 'task');
    await mkdir(worktree, { recursive: true });
    await expect(
      ipc.create(EVENT, { absDir: worktree, confirmed: true }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});
