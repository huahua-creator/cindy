/**
 * Codex cindy_memory write slot: Host-observed mcpToolCall.id only.
 * JSON-RPC id / extra.requestId never enter the slot.
 * HTTP acquire must match the same args digest.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  digestCodexCindyMemoryWriteArgs,
  forgetCodexCindyMemoryWriteSlot,
  forgetCodexCindyMemoryWriteSlotsForTurn,
  peekCodexCindyMemoryWriteSlot,
  releaseCodexCindyMemoryWriteSlot,
  rememberCodexCindyMemoryWriteSlot,
  resetCodexCindyMemoryWriteSlotsForTest,
  tryAcquireCodexCindyMemoryWriteSlot,
} from '../codex-cindy-memory-write-slot.js';

const SESSION = 'session-slot';
const INSTANCE = '33333333-3333-4333-8333-333333333333';
const WRITE_ARGS = {
  type: 'project',
  name: 'codex-slot',
  title: 'yes',
  description: 'callId from item.id',
  body: 'ok',
};

function writeItem(
  id: string,
  args: Record<string, unknown> = WRITE_ARGS,
  mode?: 'create' | 'update' | 'append',
) {
  return {
    id,
    type: 'mcpToolCall',
    server: 'cindy_memory',
    tool: 'call_tool',
    arguments: {
      name: 'memory_write',
      args: mode === undefined ? args : { ...args, mode },
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
      argsDigest: digestCodexCindyMemoryWriteArgs(WRITE_ARGS),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-1');
  });

  it('treats missing mode as create in the digest', () => {
    const withoutMode = digestCodexCindyMemoryWriteArgs(WRITE_ARGS);
    const withCreate = digestCodexCindyMemoryWriteArgs({ ...WRITE_ARGS, mode: 'create' });
    expect(withoutMode).toBe(withCreate);
    expect(withoutMode).not.toBe(digestCodexCindyMemoryWriteArgs({ ...WRITE_ARGS, mode: 'update' }));
  });

  it('does not register append, other servers, incomplete args, reserved keys, or missing identity', () => {
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-append', WRITE_ARGS, 'append'),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();

    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: { ...writeItem('item-other'), server: 'cindy_docs' },
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();

    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-incomplete', { mode: 'create' }),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();

    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-reserved', { ...WRITE_ARGS, callId: 'forged' }),
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

  it('forgets slots remembered for an orphan buffered turn', () => {
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-1'),
      turnId: 'turn-orphan',
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-1');
    forgetCodexCindyMemoryWriteSlotsForTurn({
      sessionInstanceId: INSTANCE,
      turnId: 'turn-other',
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-1');
    forgetCodexCindyMemoryWriteSlotsForTurn({
      sessionInstanceId: INSTANCE,
      turnId: 'turn-orphan',
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toBeUndefined();
  });

  it('refuses a second different item.id instead of overwriting the in-flight slot', () => {
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-A'),
    });
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-B', { ...WRITE_ARGS, name: 'second' }),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)).toEqual({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      itemId: 'item-A',
      argsDigest: digestCodexCindyMemoryWriteArgs(WRITE_ARGS),
    });
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-A'),
    });
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-A');
  });

  it('lets only one HTTP occupy the unique slot until release, and digest mismatch refuses', () => {
    const digest = digestCodexCindyMemoryWriteArgs(WRITE_ARGS);
    rememberCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      item: writeItem('item-A'),
    });
    expect(tryAcquireCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
    })).toBeUndefined();
    expect(tryAcquireCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      argsDigest: digestCodexCindyMemoryWriteArgs({ ...WRITE_ARGS, name: 'other' }),
    })).toBeUndefined();
    const first = tryAcquireCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      argsDigest: digest,
    });
    expect(first?.itemId).toBe('item-A');
    expect(peekCodexCindyMemoryWriteSlot(INSTANCE)?.itemId).toBe('item-A');
    expect(tryAcquireCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      argsDigest: digest,
    })).toBeUndefined();
    releaseCodexCindyMemoryWriteSlot(INSTANCE);
    expect(tryAcquireCodexCindyMemoryWriteSlot({
      sessionId: SESSION,
      sessionInstanceId: INSTANCE,
      argsDigest: digest,
    })?.itemId).toBe('item-A');
    releaseCodexCindyMemoryWriteSlot(INSTANCE);
  });
});
