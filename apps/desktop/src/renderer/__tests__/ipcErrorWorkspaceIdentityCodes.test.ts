import { describe, expect, it } from 'vitest';

import { extractIpcError, mapIpcErrorToI18nKey } from '../utils/ipcError';

describe('extractIpcError — workspace identity codes', () => {
  it('keeps WORKSPACE_IDENTITY_CONFLICT out of contacts IDENTITY_CONFLICT', () => {
    const err = new Error('[WORKSPACE_IDENTITY_CONFLICT] locatorDigest already bound');
    expect(extractIpcError(err)).toEqual({
      code: 'WORKSPACE_IDENTITY_CONFLICT',
      message: 'locatorDigest already bound',
    });
    expect(mapIpcErrorToI18nKey(err, { namespace: 'settings.memory.workspaceIdentity.ipcError' })).toBe(
      'settings.memory.workspaceIdentity.ipcError.WORKSPACE_IDENTITY_CONFLICT',
    );
    expect(mapIpcErrorToI18nKey(err, { namespace: 'settings.contacts.ipcError' })).not.toBe(
      'settings.contacts.ipcError.IDENTITY_CONFLICT',
    );
  });

  it('decodes CONFIG_INVALID and WORKSPACE_IDENTITY_REQUIRED', () => {
    expect(extractIpcError(new Error('[CONFIG_INVALID] damaged'))?.code).toBe('CONFIG_INVALID');
    expect(extractIpcError(new Error('[WORKSPACE_IDENTITY_REQUIRED] confirm'))?.code).toBe(
      'WORKSPACE_IDENTITY_REQUIRED',
    );
  });
});
