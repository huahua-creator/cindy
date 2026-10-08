/**
 * 前置刀 1b：与 1a 相同的 xdt-memory canonical-json 入口。
 * 不把 schema 复制进 Cindy。
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { HEX64_RE, resolveXdtMemoryRoot } from '@cindy/maker-core';

const require = createRequire(import.meta.url);

export function loadCanonicalJson(): {
  sha256Hex: (utf8: string) => string;
  objectDigest: (value: unknown, excludedKeys?: string[] | null) => string;
  projectControlObject: (value: unknown, excludedKeys?: string[] | null) => string;
} {
  const root = resolveXdtMemoryRoot();
  return require(path.join(root, 'src/schema-validator/canonical-json.mjs')) as {
    sha256Hex: (utf8: string) => string;
    objectDigest: (value: unknown, excludedKeys?: string[] | null) => string;
    projectControlObject: (value: unknown, excludedKeys?: string[] | null) => string;
  };
}

export function objectDigest(value: unknown): string {
  const digest = loadCanonicalJson().objectDigest(value, []);
  if (!HEX64_RE.test(digest)) {
    throw new Error('digest must be sha256 hex');
  }
  return digest;
}

export function projectControlObject(value: unknown, excludedKeys: string[]): string {
  return loadCanonicalJson().projectControlObject(value, excludedKeys);
}
