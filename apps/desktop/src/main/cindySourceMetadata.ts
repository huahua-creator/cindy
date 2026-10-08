export const PINNED_UPSTREAM_TAG = 'v0.1.97';
export const PINNED_UPSTREAM_COMMIT = '88e224475a6183f7b31218a7499be956a4bf2667';

export const UPSTREAM_TAG_PATTERN =
  /^v\d+\.\d+\.\d+(?:-beta(?:\.[0-9A-Za-z.-]+)?)?$/;
export const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export type CindySourceMetadata = {
  sourceCommit: string;
  builtAt: string;
  upstreamTag?: string;
};

export type AppDisplayVersionInfo = {
  display: string;
  detail: string;
};

export type ResolvePinnedUpstreamTagInput = {
  tag: string | undefined;
  expectedCommit: string;
  resolveTagCommit: (tag: string) => string | null;
  isAncestor: (commit: string) => boolean;
};

export class PinnedUpstreamTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinnedUpstreamTagError';
  }
}

export function resolvePinnedUpstreamTag(input: ResolvePinnedUpstreamTagInput): string | undefined {
  const raw = input.tag?.trim() ?? '';
  if (!raw) return undefined;
  if (!UPSTREAM_TAG_PATTERN.test(raw)) {
    throw new PinnedUpstreamTagError(`CINDY_UPSTREAM_TAG is not a Cindy release tag: ${raw}`);
  }
  const resolved = input.resolveTagCommit(raw);
  if (!resolved || !SOURCE_COMMIT_PATTERN.test(resolved)) {
    throw new PinnedUpstreamTagError(`CINDY_UPSTREAM_TAG ${raw} did not resolve to a commit`);
  }
  if (resolved !== input.expectedCommit) {
    throw new PinnedUpstreamTagError(
      `CINDY_UPSTREAM_TAG ${raw} resolved to ${resolved}, expected ${input.expectedCommit}`,
    );
  }
  if (!input.isAncestor(resolved)) {
    throw new PinnedUpstreamTagError(`CINDY_UPSTREAM_TAG ${raw} (${resolved}) is not an ancestor of HEAD`);
  }
  return raw;
}

export function parseCindySourceMetadata(raw: unknown): CindySourceMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.sourceCommit !== 'string' || !SOURCE_COMMIT_PATTERN.test(record.sourceCommit)) {
    return null;
  }
  if (typeof record.builtAt !== 'string' || Number.isNaN(Date.parse(record.builtAt))) {
    return null;
  }
  const metadata: CindySourceMetadata = {
    sourceCommit: record.sourceCommit,
    builtAt: record.builtAt,
  };
  if (record.upstreamTag !== undefined) {
    if (typeof record.upstreamTag !== 'string' || !UPSTREAM_TAG_PATTERN.test(record.upstreamTag)) {
      return null;
    }
    metadata.upstreamTag = record.upstreamTag;
  }
  return metadata;
}

export function stripUpstreamTagPrefix(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

export function shortSourceCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function formatAppDisplayVersionInfo(input: {
  packaged: boolean;
  version: string;
  metadata: CindySourceMetadata | null;
  unpackagedLabel?: string | null;
}): AppDisplayVersionInfo {
  if (!input.packaged) {
    const current = input.unpackagedLabel?.trim() || null;
    const display = current ? `${input.version} · ${current}` : input.version;
    return { display, detail: display };
  }

  if (input.version !== '0.0.0' && !input.version.startsWith('0.0.0-')) {
    return { display: input.version, detail: input.version };
  }

  const commitLabel = input.metadata ? shortSourceCommit(input.metadata.sourceCommit) : null;
  if (input.metadata?.upstreamTag) {
    const display = stripUpstreamTagPrefix(input.metadata.upstreamTag);
    return {
      display,
      detail: `${display} · ${commitLabel}`,
    };
  }

  return {
    display: input.version,
    detail: commitLabel ? `${input.version} · ${commitLabel}` : input.version,
  };
}
