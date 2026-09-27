/**
 * 前置刀 1a：owner-scoped facade journal 文件层。
 * 测试必须显式注入 temp ownerRoot，禁止默认扫生产 Roaming。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadXdtSchemaValidator, resolveXdtMemoryRoot } from '@cindy/maker-core';

import {
  claimFacadeInvocation,
  claimPath,
  entryPath,
  journalRoot,
  ownerJournalDir,
  ownerScopeDigest,
  readByInvocation,
  recoverIntent,
  schemaJournalValidator,
  shardForFacadeOperationId,
  structuralJournalValidator,
  __testOnly,
} from '../facade-journal.js';

const require = createRequire(import.meta.url);

const OWNER = 'owner-fixture-journal-1';
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function assertTempOwnerRoot(ownerRoot: string): void {
  const normalized = ownerRoot.replaceAll('\\', '/');
  expect(normalized).not.toMatch(/AppData\/Roaming\/Cindy/i);
  expect(normalized).not.toMatch(/owners\/c88d8b/i);
}

async function ownerScope() {
  const ownerRoot = await tempDir('cindy-facade-journal-owner-');
  assertTempOwnerRoot(ownerRoot);
  return { dataOwnerId: OWNER, ownerRoot };
}

function capability(invocationId = randomUUID()) {
  return { kind: 'FacadeInitialInvocationCapabilityV1' as const, invocationId };
}

function deps(owner: { dataOwnerId: string; ownerRoot: string }, extra: { limits?: { maxOwnerBytes: number } } = {}) {
  return {
    owner,
    validator: structuralJournalValidator(),
    ...extra,
  };
}

describe('facade journal files', () => {
  it('rejects claim without a fixture capability', async () => {
    const owner = await ownerScope();
    await expect(claimFacadeInvocation(deps(owner), {})).rejects.toMatchObject({
      code: 'FACADE_CAPABILITY_REQUIRED',
    });
    await expect(claimFacadeInvocation(deps(owner), { capability: null })).rejects.toMatchObject({
      code: 'FACADE_CAPABILITY_REQUIRED',
    });
    await expect(
      stat(path.join(owner.ownerRoot, 'facade-journal')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reject a production-shaped Roaming ownerRoot substring in a temp tree', async () => {
    const fakeRoaming = await tempDir('cindy-facade-journal-roaming-');
    const ownerRoot = path.join(fakeRoaming, 'AppData', 'Roaming', 'Cindy', 'owners', `c88d8b${'a'.repeat(14)}`);
    await mkdir(ownerRoot, { recursive: true });
    expect(ownerRoot.replaceAll('\\', '/')).toMatch(/AppData\/Roaming\/Cindy\/owners\/c88d8b/i);
    expect(path.resolve(ownerRoot).replaceAll('\\', '/')).not.toMatch(
      /\/Users\/XINDONG\/AppData\/Roaming\/Cindy(\/|$)/i,
    );
    const result = await claimFacadeInvocation(deps({ dataOwnerId: OWNER, ownerRoot }), {
      capability: capability(),
    });
    expect(result.claimPath.replaceAll('\\', '/')).toContain('/AppData/Roaming/Cindy/owners/c88d8b');
    expect(result.claimPath.replaceAll('\\', '/')).not.toMatch(
      /\/Users\/XINDONG\/AppData\/Roaming\/Cindy(\/|$)/i,
    );
  });

  it('matches xdt-memory objectDigest instead of hashing JSON.stringify', async () => {
    const { objectDigest, sha256Hex } = require(
      path.join(resolveXdtMemoryRoot(), 'src/schema-validator/canonical-json.mjs'),
    ) as {
      objectDigest: (value: unknown, excluded?: string[] | null) => string;
      sha256Hex: (utf8: string) => string;
    };
    const claim = {
      schemaVersion: 1,
      invocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      invocationIdDigest: 'b'.repeat(64),
      facadeOperationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };
    const canonical = objectDigest(claim, []);
    expect(__testOnly.objectDigest(claim)).toBe(canonical);
    expect(__testOnly.objectDigest(claim)).not.toBe(sha256Hex(JSON.stringify(claim)));
  });

  it('uses loadXdtSchemaValidator on origin/main journal-intent vectors', async () => {
    const schema = loadXdtSchemaValidator();
    const kind = (schema.KIND as { journalIntent?: string }).journalIntent ?? 'facade-journal-intent-v1';
    const root = resolveXdtMemoryRoot();
    const pass = JSON.parse(
      await readFile(path.join(root, 'schemas/vectors/journal-intent-prepared-pass.json'), 'utf8'),
    ) as { utf8: string };
    const extra = JSON.parse(
      await readFile(path.join(root, 'schemas/vectors/journal-intent-prepared-extra-key.json'), 'utf8'),
    ) as { utf8: string };
    const wrong = JSON.parse(
      await readFile(path.join(root, 'schemas/vectors/journal-intent-wrong-state-field.json'), 'utf8'),
    ) as { utf8: string };
    expect(schema.validateUtf8Object({ kind, utf8Bytes: pass.utf8 }).ok).toBe(true);
    expect(schema.validateUtf8Object({ kind, utf8Bytes: extra.utf8 }).ok).toBe(false);
    expect(schema.validateUtf8Object({ kind, utf8Bytes: wrong.utf8 }).ok).toBe(false);

    const owner = await ownerScope();
    const validator = schemaJournalValidator();
    expect(validator.validateIntent(extra.utf8).ok).toBe(false);
    expect(validator.validateIntent(wrong.utf8).ok).toBe(false);
    await mkdir(path.dirname(__testOnly.intentPath(owner)), { recursive: true });
    await writeFile(__testOnly.intentPath(owner), `${extra.utf8}\n`, 'utf8');
    await expect(recoverIntent({ owner, validator })).rejects.toMatchObject({ code: 'JOURNAL_INVALID' });
  });

  it('rejects a Windows junction journal root and leaves the target empty', async () => {
    const owner = await ownerScope();
    const real = await tempDir('cindy-facade-journal-junction-target-');
    const journal = journalRoot(owner);
    await mkdir(path.dirname(journal), { recursive: true });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', journal, real], { windowsHide: true });
    await expect(
      claimFacadeInvocation(deps(owner), { capability: capability() }),
    ).rejects.toMatchObject({ code: 'JOURNAL_INVALID' });
    expect(await readdir(real)).toEqual([]);
  });

  it('keeps a half-published intent on recover and does not delete it', async () => {
    const owner = await ownerScope();
    const invocationId = randomUUID();
    const facadeOperationId = '11111111-1111-4111-8111-111111111111';
    const operationId = '22222222-2222-4222-8222-222222222222';
    const invDigest = (await import('node:crypto'))
      .createHash('sha256')
      .update(invocationId, 'utf8')
      .digest('hex');
    const claim = {
      schemaVersion: 1 as const,
      invocationId,
      invocationIdDigest: invDigest,
      facadeOperationId,
      operationId,
    };
    const claimUtf8 = __testOnly.serialize(claim);
    const intendedClaimDigest = __testOnly.objectDigest(claim);
    const intendedEntryDigest = 'a'.repeat(64);
    const intent = {
      schemaVersion: 1 as const,
      intentId: '33333333-3333-4333-8333-333333333333',
      invocationIdDigest: invDigest,
      facadeOperationId,
      expectedClaimDigest: null,
      expectedEntryDigest: null,
      intendedClaimDigest,
      intendedEntryDigest,
      state: 'claim_published' as const,
    };
    await mkdir(path.dirname(claimPath(owner, invDigest)), { recursive: true });
    await writeFile(claimPath(owner, invDigest), claimUtf8, 'utf8');
    await mkdir(path.dirname(__testOnly.intentPath(owner)), { recursive: true });
    await writeFile(__testOnly.intentPath(owner), __testOnly.serialize(intent), 'utf8');

    const recovered = await recoverIntent(deps(owner));
    expect(recovered?.state).toBe('claim_published');
    expect(recovered?.facadeOperationId).toBe(facadeOperationId);
    expect(await readFile(__testOnly.intentPath(owner), 'utf8')).toContain('claim_published');
    await expect(stat(entryPath(owner, facadeOperationId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns JOURNAL_CAPACITY_EXCEEDED without deleting an uncommitted intent', async () => {
    const owner = await ownerScope();
    const intent = {
      schemaVersion: 1 as const,
      intentId: '55555555-5555-4555-8555-555555555555',
      invocationIdDigest: 'd'.repeat(64),
      facadeOperationId: '44444444-4444-4444-8444-444444444444',
      expectedClaimDigest: null,
      expectedEntryDigest: null,
      intendedClaimDigest: 'b'.repeat(64),
      intendedEntryDigest: 'c'.repeat(64),
      state: 'prepared' as const,
    };
    await mkdir(path.dirname(__testOnly.intentPath(owner)), { recursive: true });
    await writeFile(__testOnly.intentPath(owner), __testOnly.serialize(intent), 'utf8');
    await writeFile(path.join(ownerJournalDir(owner), 'pad.bin'), Buffer.alloc(400));
    const beforeIntent = await readFile(__testOnly.intentPath(owner), 'utf8');

    await expect(
      claimFacadeInvocation(deps(owner, { limits: { maxOwnerBytes: 200 } }), {
        capability: capability(),
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_CAPACITY_EXCEEDED' });
    expect(await readFile(__testOnly.intentPath(owner), 'utf8')).toBe(beforeIntent);
  });

  it('claims with a fixture capability into sharded files under injected ownerRoot', async () => {
    const owner = await ownerScope();
    const invocationId = randomUUID();
    const result = await claimFacadeInvocation(deps(owner), { capability: capability(invocationId) });
    expect(result.facadeOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.claimPath).toBe(claimPath(owner, result.invocationIdDigest));
    expect(result.entryPath).toBe(entryPath(owner, result.facadeOperationId));
    expect(result.entryPath.replaceAll('\\', '/')).toContain(
      `/${shardForFacadeOperationId(result.facadeOperationId)}/`,
    );
    assertTempOwnerRoot(result.claimPath);
    const read = await readByInvocation(deps(owner), invocationId);
    expect(read?.claim.invocationId).toBe(invocationId);
    expect(read?.entry.state).toBe('claimed');
    await expect(stat(__testOnly.intentPath(owner))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ownerScopeDigest(OWNER)).toHaveLength(64);
  });
});
