/**
 * Host 只读调用 xdt-memory memory_index（等价 MemoryStore.index()）。
 * mutationMode=disabled。禁止 search/get 重建 MEMORY.md，禁止调用方传入 content。
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import {
  XdtPrepareError,
  type FrozenFacadeRecord,
  type FrozenIndexSnapshotV1,
} from './xdt-binding.js';
import { resolveXdtMemoryRoot } from './xdt-schema.js';

const require = createRequire(import.meta.url);

export interface XdtIndexSource {
  repoRoot: string;
  dataRoot: string;
  workspace: string;
  /**
   * 生产只读 prepare 用 `'cindy-host-readonly'`。缺省仍是段 1 fixture
   * `'cindy-host-fixture'`，不得破坏既有 fixture 测试。
   */
  device?: 'cindy-host-fixture' | 'cindy-host-readonly';
}

export interface MemoryIndexRecord {
  key?: string;
  content?: string;
  updated_at?: string;
  title?: string;
  revision?: string;
}

export interface MemoryIndexClient {
  index(): Promise<FrozenIndexSnapshotV1>;
  get?(key: string): Promise<MemoryIndexRecord | null>;
}

function loadMemoryStoreCtor(root: string): new (options: Record<string, unknown>) => MemoryIndexClient {
  const storePath = path.join(root, 'src/memory-store.mjs');
  try {
    const mod = require(storePath) as { MemoryStore: new (options: Record<string, unknown>) => MemoryIndexClient };
    return mod.MemoryStore;
  } catch (err) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      `xdt-memory MemoryStore unavailable at ${storePath}: ${String(err)}`,
    );
  }
}

export function createXdtMemoryIndexClient(
  source: XdtIndexSource,
  xdtMemoryRoot = resolveXdtMemoryRoot(),
): MemoryIndexClient {
  const MemoryStore = loadMemoryStoreCtor(xdtMemoryRoot);
  return new MemoryStore({
    repoRoot: source.repoRoot,
    dataRoot: source.dataRoot,
    workspace: source.workspace,
    mutationMode: 'disabled',
    legacyMode: 'disabled',
    device: source.device ?? 'cindy-host-fixture',
  });
}

/** 产品入口：只调 index()，等价 memory_index。 */
export async function readFrozenIndexFromXdt(
  source: XdtIndexSource,
  xdtMemoryRoot = resolveXdtMemoryRoot(),
): Promise<FrozenIndexSnapshotV1> {
  const store = createXdtMemoryIndexClient(source, xdtMemoryRoot);
  return store.index();
}

export function filenamesInSnapshot(content: string): Set<string> {
  const names = new Set<string>();
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[([^\]]+)\] /);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

export function parseSnapshotEntries(content: string): Array<{
  filename: string;
  type: FrozenFacadeRecord['type'];
  name: string;
  title: string;
  description: string;
  key?: string;
}> {
  const entries: Array<{
    filename: string;
    type: FrozenFacadeRecord['type'];
    name: string;
    title: string;
    description: string;
    key?: string;
  }> = [];
  let currentType: FrozenFacadeRecord['type'] | undefined;
  for (const line of content.split('\n')) {
    const heading = line.match(/^## (user|feedback|project|reference)$/);
    if (heading) {
      currentType = heading[1] as FrozenFacadeRecord['type'];
      continue;
    }
    const item = line.match(/^- \[([^\]]+)\] (.+?) — (.+)$/);
    if (!item || !currentType) continue;
    const filename = item[1]!;
    entries.push({
      filename,
      type: currentType,
      name: filename.replace(/^[a-z]+_/, '').replace(/\.md$/, ''),
      title: item[2]!,
      description: item[3]!,
    });
  }
  return entries;
}

export async function projectFacadeRecordsFromIndex(input: {
  snapshot: FrozenIndexSnapshotV1;
  getRecord: (filename: string, parsed: ReturnType<typeof parseSnapshotEntries>[number]) => Promise<MemoryIndexRecord | null>;
}): Promise<FrozenFacadeRecord[]> {
  const parsed = parseSnapshotEntries(input.snapshot.content);
  if (parsed.length !== input.snapshot.recordCount) {
    throw new XdtPrepareError(
      'INDEX_SNAPSHOT_MISMATCH',
      'snapshot content filenames must equal recordCount',
    );
  }
  const records: FrozenFacadeRecord[] = [];
  for (const entry of parsed) {
    const got = await input.getRecord(entry.filename, entry);
    if (!got) {
      throw new XdtPrepareError(
        'INDEX_SNAPSHOT_MISMATCH',
        `facade body missing for ${entry.filename}`,
      );
    }
    records.push({
      filename: entry.filename,
      type: entry.type,
      name: entry.name,
      title: got.title ?? entry.title,
      description: entry.description,
      key: got.key ?? entry.filename,
      revision: got.revision ?? '',
      body: got.content ?? '',
      updatedAt: got.updated_at ?? '1970-01-01T00:00:00.000Z',
    });
  }
  assertRecordsMatchSnapshot(input.snapshot, records);
  return records;
}

export function assertRecordsMatchSnapshot(
  snapshot: FrozenIndexSnapshotV1,
  records: readonly FrozenFacadeRecord[],
): void {
  const names = filenamesInSnapshot(snapshot.content);
  if (records.length !== snapshot.recordCount || records.length !== names.size) {
    throw new XdtPrepareError(
      'INDEX_SNAPSHOT_MISMATCH',
      'facade records must match FrozenIndexSnapshotV1 recordCount',
    );
  }
  for (const rec of records) {
    if (!names.has(rec.filename)) {
      throw new XdtPrepareError(
        'INDEX_SNAPSHOT_MISMATCH',
        `facade record ${rec.filename} is not in snapshot content`,
      );
    }
  }
}
