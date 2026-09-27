/**
 * Claude 失败门：extra.requestId 缺失、空、非安全整数 → 不能当 callId。
 * 0 是合法 JSON-RPC id。
 */

import { describe, expect, it } from 'vitest';

import { normalizeMcpRequestId } from '../memory/mcp-request-id.js';

describe('normalizeMcpRequestId', () => {
  it('returns undefined for missing, empty, or blank requestId', () => {
    expect(normalizeMcpRequestId(undefined)).toBeUndefined();
    expect(normalizeMcpRequestId(null)).toBeUndefined();
    expect(normalizeMcpRequestId('')).toBeUndefined();
    expect(normalizeMcpRequestId('   ')).toBeUndefined();
  });

  it('keeps a non-empty string and stringifies a safe integer including 0', () => {
    expect(normalizeMcpRequestId('call-1')).toBe('call-1');
    expect(normalizeMcpRequestId(0)).toBe('0');
    expect(normalizeMcpRequestId(42)).toBe('42');
  });

  it('rejects non-integer and unsafe numbers so they cannot mint', () => {
    expect(normalizeMcpRequestId(1.5)).toBeUndefined();
    expect(normalizeMcpRequestId(Number.NaN)).toBeUndefined();
    expect(normalizeMcpRequestId(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeMcpRequestId(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
  });
});
