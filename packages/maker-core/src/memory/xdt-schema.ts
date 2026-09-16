/**
 * 只读消费 xdt-memory 已提交 schema + semantic invariants。
 * 禁止把私有 TypeScript 当唯一校验器；不接入 upsert/archive/sync。
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { XdtPrepareError } from './xdt-binding.js';

const require = createRequire(import.meta.url);

/**
 * 仅本机 fixture 读取已发布 xdt-memory schema-validator / MemoryStore。
 * 不进生产 Cindy 安装路径探测，也不把 Cindy 绑到这台机器的目录布局。
 */
export const DEFAULT_XDT_MEMORY_ROOT = 'D:/AI/Codex/xdt-memory';

export function resolveXdtMemoryRoot(explicit?: string): string {
  return explicit ?? process.env.XDT_MEMORY_REPO ?? DEFAULT_XDT_MEMORY_ROOT;
}

function loadValidator(root: string): {
  validateUtf8Object: (input: {
    kind: string;
    utf8Bytes: string | Buffer | Uint8Array;
  }) => { ok: boolean; code?: string; message?: string };
  KIND: { binding: string; frozenIndex: string; nativeProof: string };
} {
  const validatorPath = path.join(root, 'src/schema-validator/index.mjs');
  try {
    return require(validatorPath) as {
      validateUtf8Object: (input: {
        kind: string;
        utf8Bytes: string | Buffer | Uint8Array;
      }) => { ok: boolean; code?: string; message?: string };
      KIND: { binding: string; frozenIndex: string; nativeProof: string };
    };
  } catch (err) {
    throw new XdtPrepareError(
      'CONFIG_INVALID',
      `xdt-memory schema-validator unavailable at ${validatorPath}: ${String(err)}`,
    );
  }
}

function assertSchemaOk(
  kind: string,
  value: unknown,
  code: 'CONFIG_INVALID' | 'INDEX_SNAPSHOT_MISMATCH' | 'NATIVE_MEMORY_PROOF_INVALID',
  root?: string,
): void {
  const { validateUtf8Object } = loadValidator(resolveXdtMemoryRoot(root));
  const result = validateUtf8Object({
    kind,
    utf8Bytes: JSON.stringify(value),
  });
  if (!result.ok) {
    throw new XdtPrepareError(code, `${kind} schema rejected: ${result.code ?? result.message ?? 'invalid'}`);
  }
}

export function assertXdtBindingSchema(binding: unknown, root?: string): void {
  const { KIND } = loadValidator(resolveXdtMemoryRoot(root));
  assertSchemaOk(KIND.binding, binding, 'CONFIG_INVALID', root);
}

export function assertFrozenIndexSchema(snapshot: unknown, root?: string): void {
  const { KIND } = loadValidator(resolveXdtMemoryRoot(root));
  assertSchemaOk(KIND.frozenIndex, snapshot, 'INDEX_SNAPSHOT_MISMATCH', root);
}

export function assertNativeProofSchema(proof: unknown, root?: string): void {
  const { KIND } = loadValidator(resolveXdtMemoryRoot(root));
  assertSchemaOk(KIND.nativeProof, proof, 'NATIVE_MEMORY_PROOF_INVALID', root);
}
