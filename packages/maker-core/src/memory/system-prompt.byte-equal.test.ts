/**
 * 静态 MAKER_MEMORY_RULES 必须与 system-prompt.md 去尾空白后的字节完全相等。
 * 本刀不得改这段静态文案。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAKER_MEMORY_RULES } from './system-prompt.js';
import promptText from './system-prompt.md?raw';

describe('MAKER_MEMORY_RULES byte equality', () => {
  it('equals system-prompt.md.trim() bytes', () => {
    const onDisk = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'system-prompt.md'), 'utf8');
    expect(Buffer.from(MAKER_MEMORY_RULES, 'utf8').equals(Buffer.from(onDisk.trim(), 'utf8'))).toBe(true);
    expect(MAKER_MEMORY_RULES).toBe(promptText.trim());
  });
});
