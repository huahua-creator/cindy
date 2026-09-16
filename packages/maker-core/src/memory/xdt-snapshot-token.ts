/**
 * Host 同源回算 FrozenIndexSnapshotV1 token / counts / digest。
 * 抄 xdt-memory `src/frozen-index.mjs` 的 snapshotToken() / limitsDigest()，
 * 不要另写字段名变体。validateUtf8Object(kind=frozenIndex) 不是充足条件。
 */

import { createHash } from 'node:crypto';

import { XdtPrepareError, type FrozenIndexSnapshotV1 } from './xdt-binding.js';

export const EMPTY_MEMORY_INDEX =
  '# Memory Index\n\n_(empty — no memories saved yet for this workdir)_\n';

export const EMPTY_MEMORY_INDEX_DIGEST =
  '352121ce6932565371ac0a127dc3eea378579c00941c6a7c164a8d4c88eb9c3c';

export const CANONICAL_LIMITS = Object.freeze({
  schemaVersion: 1,
  maxCanonicalRevisionFilesPerWorkspace: 50_000,
  maxCanonicalHeadsPerWorkspace: 4_096,
  defaultListPageSize: 50,
  maxListPageSize: 100,
  maxListResponseBytes: 524_288,
  maxIndexBytes: 65_536,
  maxReviewRecords: 2_048,
  maxReviewBytes: 2_097_152,
  maxBatchMembers: 4_096,
  maxBatchRequestBytes: 8_388_608,
  maxManifestBytes: 4_194_304,
});

function compareCodePointKeys(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const delta = (left[i]!.codePointAt(0) ?? 0) - (right[i]!.codePointAt(0) ?? 0);
    if (delta) return delta;
  }
  return left.length - right.length;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function projectLimits(limits: typeof CANONICAL_LIMITS): string {
  const keys = Object.keys(limits).sort(compareCodePointKeys);
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify((limits as Record<string, unknown>)[key])}`)
    .join(',');
  return `{${body}}`;
}

export function limitsDigest(limits: typeof CANONICAL_LIMITS = CANONICAL_LIMITS): string {
  return sha256Hex(projectLimits(limits));
}

/** idx1_ + sha256(`${contentDigest}:${limitsHash}:${recordCount}`).base64url.slice(0,43) */
export function snapshotToken(
  contentDigest: string,
  limitsHash: string,
  recordCount: number,
): string {
  const material = `${contentDigest}:${limitsHash}:${recordCount}`;
  return `idx1_${createHash('sha256').update(material, 'utf8').digest('base64url').slice(0, 43)}`;
}

export function assertFrozenIndexSnapshot(
  snapshot: FrozenIndexSnapshotV1,
  limits: typeof CANONICAL_LIMITS = CANONICAL_LIMITS,
): FrozenIndexSnapshotV1 {
  if (snapshot.schemaVersion !== 1) {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'schemaVersion must be 1');
  }
  if (snapshot.remoteFreshness !== 'unknown') {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'remoteFreshness must be unknown');
  }
  const contentDigest = sha256Hex(snapshot.content);
  if (snapshot.contentDigest !== contentDigest) {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'contentDigest must equal sha256 of content UTF-8');
  }
  const byteLength = Buffer.byteLength(snapshot.content, 'utf8');
  if (snapshot.byteLength !== byteLength) {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'byteLength must equal UTF-8 byte length of content');
  }
  if (byteLength > limits.maxIndexBytes) {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'frozen MEMORY.md index exceeds maxIndexBytes');
  }
  const limitsHash = limitsDigest(limits);
  if (snapshot.limitsDigest !== limitsHash) {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'limitsDigest must match CanonicalLimitsV1 projection');
  }
  const counted = snapshot.counts.v2Compat + snapshot.counts.v3;
  if (counted !== snapshot.recordCount) {
    throw new XdtPrepareError(
      'INDEX_SNAPSHOT_MISMATCH',
      'counts.v2Compat + counts.v3 must equal recordCount',
    );
  }
  const token = snapshotToken(contentDigest, limitsHash, snapshot.recordCount);
  if (snapshot.token !== token) {
    throw new XdtPrepareError('INDEX_SNAPSHOT_MISMATCH', 'token must match Host snapshotToken()');
  }
  if (snapshot.recordCount === 0 && snapshot.content !== EMPTY_MEMORY_INDEX) {
    throw new XdtPrepareError(
      'INDEX_SNAPSHOT_MISMATCH',
      'empty MEMORY.md bytes must match Cindy storage.ts empty join',
    );
  }
  return snapshot;
}
