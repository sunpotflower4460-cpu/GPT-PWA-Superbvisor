import { describe, expect, it } from 'vitest';
import {
  getCheckNamesByCategory,
  getMaintainerMode,
  parseProjectKernel,
  requiresDraftPrFirst,
  resolveContextRoutingPaths,
} from './projectKernel';

// Closes the gap projectKernel.test.ts's own golden-snapshot test documents:
// that fixture is a point-in-time copy of GPT-template's real
// project-kernel.json, so it catches THIS parser regressing against a
// known-good contract but not GPT-template's manifest shape drifting out
// from under it. This file re-runs the exact same structural assertions
// against GPT-template's CURRENT live manifest instead of the frozen copy.
//
// Deliberately excluded from the normal `npm test` / PR-blocking CI path
// (see GPT_TEMPLATE_LIVE_DRIFT_CHECK gate below): a live network fetch has
// no place in every contributor's offline test run or in gating unrelated
// PRs on GitHub's availability. Wired instead into a separate scheduled
// workflow (.github/workflows/gpt-template-kernel-drift.yml) that only
// this suite runs, on its own cadence — a failure there is a signal to
// review, not a block on this repo's own changes.
const LIVE_MANIFEST_URL = 'https://raw.githubusercontent.com/sunpotflower4460-cpu/GPT-template/main/project-kernel.json';
const FETCH_TIMEOUT_MS = 15_000;

async function fetchLiveManifest(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(LIVE_MANIFEST_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`GPT-template manifest fetch failed: HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

describe.skipIf(!process.env.GPT_TEMPLATE_LIVE_DRIFT_CHECK)('cross-repo contract: GPT-template LIVE project-kernel.json (opt-in, see GPT_TEMPLATE_LIVE_DRIFT_CHECK)', () => {
  it('parses without throwing', async () => {
    const raw = await fetchLiveManifest();
    expect(() => parseProjectKernel(raw)).not.toThrow();
  });

  it('still requires a Draft PR first on a feature branch (the actual deadlock this repo hits against GPT-template)', async () => {
    const parsed = parseProjectKernel(await fetchLiveManifest());
    expect(requiresDraftPrFirst(parsed, 'ai-dev-deck/some-feature')).toBe(true);
    expect(requiresDraftPrFirst(parsed, 'main')).toBe(false);
  });

  it('still classifies check-approval as HUMAN_APPROVAL_REQUIRED', async () => {
    const parsed = parseProjectKernel(await fetchLiveManifest());
    expect(getCheckNamesByCategory(parsed, 'HUMAN_APPROVAL_REQUIRED')).toEqual(new Set(['check-approval']));
  });

  it('still resolves core context routing to real paths', async () => {
    const parsed = parseProjectKernel(await fetchLiveManifest());
    const core = resolveContextRoutingPaths(parsed, 'core');
    expect(core).toContainEqual({ key: 'agents', path: 'AGENTS.md' });
    expect(core).toContainEqual({ key: 'soul', path: 'docs/00-soul/SOUL.md' });
  });

  it('still reads governance.maintainerMode as SOLO_MAINTAINER', async () => {
    const parsed = parseProjectKernel(await fetchLiveManifest());
    expect(getMaintainerMode(parsed)).toBe('SOLO_MAINTAINER');
  });
});
