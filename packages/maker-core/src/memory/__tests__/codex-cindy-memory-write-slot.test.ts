/**
 * Codex cindy_memory write slot: Host-observed mcpToolCall.id only.
 * JSON-RPC id / extra.requestId never enter the slot.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  forgetCodexCindyMemoryWriteSlot,
  peekCodexCindyMemoryWriteSlot,
  rememberCodexCindyMemoryWriteSlot,
  resetCodexCindyMemoryWriteSlotsForTest,
} from '../codex-cindy-memory-write-slot.js';

const SESSION = 'session-slot';
const INSTANCE = '33333333-3333-4333-8333-333333333333';

function writeItem(id: string, mode?: 'create' | 'update' | 'append') {
  return {
    id,
    type: 'mcpToolCall',
    server: 'cindy_memory',
    tool: 'call_tool',
    arguments: {
      name: 'memory_write',
      ...(mode === undefined ? {} : { args: { mode } }),
    },
  };
}

afterEach(() => {
  resetCodexCindyMemoryWriteSlotsForTest();
});

describe('codex cindy_memory write slot', () => {
  it('remembers peekable create/update item.id and ignores JSON-RPC-looking extras', () => {
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: {
        ...writeItem('item-1'),
        extra: { requestId: 'jsonrpc-must-not-win' },
      },
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toEqual({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      itemId: 'item-1',
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-1');
  });

  it('does not register append, other servers, or missing identity', () => {
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-append', 'append'),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();

    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: { ...writeItem('item-other'), server: 'cindy_docs' },
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();

    rememberCodexCindyMemoryWriteSlot({
      sessionId: '',
      sessionInstanceId: INSTANCE,
      item: writeItem('item-no-session'),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();
  });

  it('keeps the slot until the matching item is forgotten so same item.id can replay', () => {
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-1'),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-1');
    forgetCodexCindyMemoryWriteSlot({ sessionInstanceId: INSTANCE, itemId: 'item-other' });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-1');
    forgetCodexCindyMemoryWriteSlot({ sessionInstanceId: INSTANCE, itemId: 'item-1' });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();
  });
});
