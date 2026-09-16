/**
 * Session-frozen cindy_memory store for an XdtMemoryBindingV1.
 * index 只来自已核对的 FrozenIndexSnapshotV1；list/read/search 读同一 snapshot
 * 约束下的 facade 记录。write / delete / consolidate 在进 internal store 之前红。
 */

import { MemoryError, type MemoryRecord, type SearchHit, type SearchOptions } from './types.js';
import type { FrozenFacadeRecord, FrozenIndexSnapshotV1, MemorySessionStore } from './xdt-binding.js';

function toRecord(entry: FrozenFacadeRecord): MemoryRecord {
  return {
    filename: entry.filename,
    slug: entry.name,
    frontmatter: {
      title: entry.title,
      description: entry.description,
      type: entry.type,
      updatedAt: entry.updatedAt,
    },
    body: entry.body,
    sizeBytes: Buffer.byteLength(entry.body, 'utf8'),
  };
}

function readOnly(): never {
  throw new MemoryError('not-ready', 'xdt prepared session is read-only');
}

export function createXdtFrozenSessionStore(input: {
  snapshot: FrozenIndexSnapshotV1;
  records: readonly FrozenFacadeRecord[];
}): MemorySessionStore {
  const records = input.records.map(toRecord);

  return {
    async list() {
      return records.map((r) => ({ ...r, frontmatter: { ...r.frontmatter } }));
    },
    async read(filename: string) {
      const rec = records.find((item) => item.filename === filename);
      if (!rec) {
        throw new MemoryError('not-found', `memory shard not found: ${filename}`);
      }
      return { ...rec, frontmatter: { ...rec.frontmatter } };
    },
    async search(query: string, opts?: SearchOptions) {
      const needle = query.trim().toLocaleLowerCase();
      const limit = Math.min(50, Math.max(1, opts?.limit ?? 10));
      const hits: SearchHit[] = [];
      for (const rec of records) {
        if (opts?.type && rec.frontmatter.type !== opts.type) continue;
        const haystack = `${rec.frontmatter.title}\n${rec.frontmatter.description}\n${rec.body}`.toLocaleLowerCase();
        if (!haystack.includes(needle)) continue;
        hits.push({
          filename: rec.filename,
          type: rec.frontmatter.type,
          title: rec.frontmatter.title,
          snippet: rec.frontmatter.description,
          score: rec.frontmatter.title.toLocaleLowerCase().includes(needle) ? 1 : 10,
        });
      }
      return hits.slice(0, limit);
    },
    async getIndex() {
      return input.snapshot.content;
    },
    async write() {
      readOnly();
    },
    async delete() {
      readOnly();
    },
    async consolidate() {
      readOnly();
    },
  };
}
