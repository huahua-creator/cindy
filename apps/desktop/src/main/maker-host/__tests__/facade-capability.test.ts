import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadXdtSchemaValidator, resolveXdtMemoryRoot } from '@cindy/maker-core';

import {
  facadeCapabilityMac,
  mintFacadeInitialCapability,
  verifyFacadeInitialCapability,
} from '../facade-capability.js';

const require = createRequire(import.meta.url);
const FIXTURE_SECRET = 'xdt-memory-fixture-capability-v1';

describe('facade capability mint', () => {
  it('matches the published cap-initial-pass fixture HMAC', () => {
    const { fixtureCapabilityMac, sealCapability } = require(
      path.join(resolveXdtMemoryRoot(), 'src/schema-validator/capability-mac.mjs'),
    ) as {
      fixtureCapabilityMac: (object: unknown) => string;
      sealCapability: (object: Record<string, unknown>) => { capabilityMac: string };
    };
    const minted = mintFacadeInitialCapability(
      {
        innerToolName: 'memory_write',
        normalizedArgsDigest: 'a'.repeat(64),
        sessionInstanceId: '11111111-1111-4111-8111-111111111111',
        preparedMemorySessionId: '22222222-2222-4222-8222-222222222222',
        invocationId: 'inv-opaque-1',
        issuerGeneration: 'iss-1',
        issuedAt: '2026-09-16T00:00:00Z',
        expiresAt: '2026-09-16T01:00:00Z',
        nonce: 'nonce-1',
      },
      FIXTURE_SECRET,
    );
    expect(minted.capabilityMac).toBe(fixtureCapabilityMac(minted));
    expect(minted.capabilityMac).toBe(sealCapability({ ...minted, capabilityMac: undefined }).capabilityMac);
    expect(minted.capabilityMac).toBe('6d341578814c172741c546e41c35c06f2ea5b971a9c0318c35dc48c8fb70a485');
    const schema = loadXdtSchemaValidator();
    const kind = (schema.KIND as { initialCapability?: string }).initialCapability
      ?? 'facade-initial-capability-v1';
    expect(schema.validateUtf8Object({ kind, utf8Bytes: JSON.stringify(minted) }).ok).toBe(true);
    expect(facadeCapabilityMac(minted, Buffer.alloc(32, 7))).not.toBe(minted.capabilityMac);
    expect(verifyFacadeInitialCapability(minted, FIXTURE_SECRET)).toBe(true);
    expect(verifyFacadeInitialCapability(
      { ...minted, capabilityMac: '0'.repeat(64) },
      FIXTURE_SECRET,
    )).toBe(false);
    expect(verifyFacadeInitialCapability(minted, Buffer.alloc(32, 7))).toBe(false);
  });
});
