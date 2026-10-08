import { describe, expect, it } from 'vitest';
import {
  PINNED_UPSTREAM_COMMIT,
  PINNED_UPSTREAM_TAG,
  formatAppDisplayVersionInfo,
  parseCindySourceMetadata,
  resolvePinnedUpstreamTag,
} from '../cindySourceMetadata';

const COMMIT = '3cfe760885beb85369660fa343ac5abd8585a83b';
const BUILT_AT = '2026-10-08T10:26:23.864+08:00';

describe('resolvePinnedUpstreamTag', () => {
  it('omits the field when the env is absent', () => {
    expect(
      resolvePinnedUpstreamTag({
        tag: undefined,
        expectedCommit: PINNED_UPSTREAM_COMMIT,
        resolveTagCommit: () => PINNED_UPSTREAM_COMMIT,
        isAncestor: () => true,
      }),
    ).toBeUndefined();
    expect(
      resolvePinnedUpstreamTag({
        tag: '   ',
        expectedCommit: PINNED_UPSTREAM_COMMIT,
        resolveTagCommit: () => PINNED_UPSTREAM_COMMIT,
        isAncestor: () => true,
      }),
    ).toBeUndefined();
  });

  it('fails closed on an illegal tag name', () => {
    expect(() =>
      resolvePinnedUpstreamTag({
        tag: 'v999.0.0-local',
        expectedCommit: PINNED_UPSTREAM_COMMIT,
        resolveTagCommit: () => PINNED_UPSTREAM_COMMIT,
        isAncestor: () => true,
      }),
    ).toThrow(/not a Cindy release tag/);
  });

  it('fails when a local tag name was moved to another commit', () => {
    expect(() =>
      resolvePinnedUpstreamTag({
        tag: PINNED_UPSTREAM_TAG,
        expectedCommit: PINNED_UPSTREAM_COMMIT,
        resolveTagCommit: () => 'a'.repeat(40),
        isAncestor: () => true,
      }),
    ).toThrow(/expected 88e224475a6183f7b31218a7499be956a4bf2667/);
  });

  it('fails when the pinned commit is not an ancestor of HEAD', () => {
    expect(() =>
      resolvePinnedUpstreamTag({
        tag: PINNED_UPSTREAM_TAG,
        expectedCommit: PINNED_UPSTREAM_COMMIT,
        resolveTagCommit: () => PINNED_UPSTREAM_COMMIT,
        isAncestor: () => false,
      }),
    ).toThrow(/not an ancestor of HEAD/);
  });

  it('accepts the pinned official tag when the peeled commit matches and is an ancestor', () => {
    expect(
      resolvePinnedUpstreamTag({
        tag: PINNED_UPSTREAM_TAG,
        expectedCommit: PINNED_UPSTREAM_COMMIT,
        resolveTagCommit: () => PINNED_UPSTREAM_COMMIT,
        isAncestor: () => true,
      }),
    ).toBe(PINNED_UPSTREAM_TAG);
  });
});

describe('parseCindySourceMetadata', () => {
  it('rejects malformed sourceCommit even if upstreamTag looks official', () => {
    expect(
      parseCindySourceMetadata({
        sourceCommit: 'not-a-commit',
        builtAt: BUILT_AT,
        upstreamTag: PINNED_UPSTREAM_TAG,
      }),
    ).toBeNull();
  });

  it('rejects an illegal upstreamTag instead of displaying it', () => {
    expect(
      parseCindySourceMetadata({
        sourceCommit: COMMIT,
        builtAt: BUILT_AT,
        upstreamTag: 'not-a-tag',
      }),
    ).toBeNull();
  });

  it('accepts legacy metadata without upstreamTag', () => {
    expect(parseCindySourceMetadata({ sourceCommit: COMMIT, builtAt: BUILT_AT })).toEqual({
      sourceCommit: COMMIT,
      builtAt: BUILT_AT,
    });
  });
});

describe('formatAppDisplayVersionInfo', () => {
  it('keeps unpackaged branch@sha labels', () => {
    expect(
      formatAppDisplayVersionInfo({
        packaged: false,
        version: '0.0.0',
        metadata: null,
        unpackagedLabel: 'feat/host-readonly-xdt-facade-on-0.1.97@3cfe760',
      }),
    ).toEqual({
      display: '0.0.0 · feat/host-readonly-xdt-facade-on-0.1.97@3cfe760',
      detail: '0.0.0 · feat/host-readonly-xdt-facade-on-0.1.97@3cfe760',
    });
  });

  it('ignores upstreamTag on a released package', () => {
    expect(
      formatAppDisplayVersionInfo({
        packaged: true,
        version: '0.1.97',
        metadata: {
          sourceCommit: COMMIT,
          builtAt: BUILT_AT,
          upstreamTag: PINNED_UPSTREAM_TAG,
        },
      }),
    ).toEqual({ display: '0.1.97', detail: '0.1.97' });
  });

  it('shows the official baseline on a versionless package with complete metadata', () => {
    expect(
      formatAppDisplayVersionInfo({
        packaged: true,
        version: '0.0.0',
        metadata: {
          sourceCommit: COMMIT,
          builtAt: BUILT_AT,
          upstreamTag: PINNED_UPSTREAM_TAG,
        },
      }),
    ).toEqual({ display: '0.1.97', detail: '0.1.97 · 3cfe760' });
  });

  it('falls back to 0.0.0 when metadata is missing or illegal', () => {
    expect(
      formatAppDisplayVersionInfo({
        packaged: true,
        version: '0.0.0',
        metadata: null,
      }),
    ).toEqual({ display: '0.0.0', detail: '0.0.0' });
    expect(
      formatAppDisplayVersionInfo({
        packaged: true,
        version: '0.0.0',
        metadata: { sourceCommit: COMMIT, builtAt: BUILT_AT },
      }),
    ).toEqual({ display: '0.0.0', detail: '0.0.0 · 3cfe760' });
  });
});
