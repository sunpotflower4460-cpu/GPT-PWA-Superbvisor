import { describe, expect, it } from 'vitest';
import {
  getCheckNamesByCategory,
  getMaintainerMode,
  parseProjectKernel,
  requiresDraftPrFirst,
  resolveContextRoutingPaths,
} from './projectKernel';

// contextRouting entries are KEYS into `paths` (e.g. "soul" -> paths.soul),
// not literal repository paths. This mirrors the contract GPT-template's
// own project-kernel.json actually ships (see the cross-repo fixture test
// below) — a fixture using literal paths here would silently test the
// wrong contract.
const validManifest = {
  schemaVersion: 1,
  kind: 'ai-project-kernel',
  paths: {
    soul: 'docs/00-soul/SOUL.md',
    features: 'docs/03-scope/FEATURES.md',
    craftIndex: 'craft/INDEX.md',
    handoff: 'docs/05-handoff/HANDOFF.md',
  },
  capabilities: {
    structuredStatus: true,
    structuredGuard: true,
  },
  contextRouting: {
    core: ['soul'],
    scoped: ['craftIndex'],
    onDemand: ['handoff'],
  },
  runtime: {
    status: 'npm run status -- --json',
  },
  validation: {
    strategies: [
      {
        type: 'push',
        required: true,
        branches: ['main'],
        checks: [{ name: 'guard', category: 'GUARD_FAILURE' }],
      },
      {
        type: 'pull_request',
        required: true,
        checks: [
          { name: 'guard', category: 'GUARD_FAILURE' },
          { name: 'check-approval', category: 'HUMAN_APPROVAL_REQUIRED' },
        ],
      },
    ],
  },
};

describe('parseProjectKernel', () => {
  it('accepts the schema v1 foundation and preserves validation categories', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.kind).toBe('ai-project-kernel');
    expect(parsed.validation?.strategies[1].type).toBe('pull_request');
    expect(parsed.validation?.strategies[1].checks[1].category).toBe('HUMAN_APPROVAL_REQUIRED');
  });

  it('preserves required and branches on validation strategies', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(parsed.validation?.strategies[0].required).toBe(true);
    expect(parsed.validation?.strategies[0].branches).toEqual(['main']);
    expect(parsed.validation?.strategies[1].branches).toBeUndefined();
  });

  it('rejects unsupported schemas without guessing', () => {
    expect(() => parseProjectKernel(JSON.stringify({ ...validManifest, schemaVersion: 2 })))
      .toThrow('Unsupported Project Kernel schema');
  });

  it('rejects repository path traversal', () => {
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      paths: { soul: '../secrets.txt' },
    }))).toThrow('unsafe repository path');
  });

  it('rejects malformed validation strategies', () => {
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      validation: { strategies: [{ type: 'magic', checks: [] }] },
    }))).toThrow('type is invalid');
  });

  it('rejects a non-boolean required flag', () => {
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      validation: { strategies: [{ type: 'push', required: 'yes', checks: [] }] },
    }))).toThrow('required must be boolean');
  });

  it('rejects contextRouting entries that are literal paths instead of paths keys', () => {
    // The exact mistake PR #30's original parser made: treating a routing
    // entry as a safe repository path rather than a key into `paths`.
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      contextRouting: { core: ['docs/00-soul/SOUL.md'] },
    }))).toThrow('contextRouting.core references unknown paths key');
  });

  it('ignores unknown top-level fields for forward compatibility', () => {
    const parsed = parseProjectKernel(JSON.stringify({
      ...validManifest,
      futureCapability: { enabled: true },
    }));
    expect(parsed.kind).toBe('ai-project-kernel');
  });

  it('accepts a declared governance.maintainerMode and preserves unrelated governance keys', () => {
    const parsed = parseProjectKernel(JSON.stringify({
      ...validManifest,
      governance: { phases: ['P0', 'P1'], maintainerMode: 'SOLO_MAINTAINER' },
    }));
    expect(parsed.governance?.maintainerMode).toBe('SOLO_MAINTAINER');
    expect(parsed.governance?.phases).toEqual(['P0', 'P1']);
  });

  it('rejects an unrecognized governance.maintainerMode value', () => {
    expect(() => parseProjectKernel(JSON.stringify({
      ...validManifest,
      governance: { maintainerMode: 'SOLO' },
    }))).toThrow('governance.maintainerMode must be SOLO_MAINTAINER or MULTI_MAINTAINER');
  });
});

describe('getMaintainerMode', () => {
  it('falls back to MULTI_MAINTAINER (today\'s original behavior) when governance is absent', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(getMaintainerMode(parsed)).toBe('MULTI_MAINTAINER');
  });

  it('falls back to MULTI_MAINTAINER for a GENERIC_REPO (no manifest at all)', () => {
    expect(getMaintainerMode(undefined)).toBe('MULTI_MAINTAINER');
  });

  it('returns the declared mode when present and valid', () => {
    const parsed = parseProjectKernel(JSON.stringify({ ...validManifest, governance: { maintainerMode: 'SOLO_MAINTAINER' } }));
    expect(getMaintainerMode(parsed)).toBe('SOLO_MAINTAINER');
  });
});

// This fixture and INVALID_KERNEL_MANIFEST_FIXTURES below are the mirror of
// sunpotflower4460-cpu/GPT-template's scripts/guard/selftest.mjs
// (VALID_KERNEL_MANIFEST / INVALID_KERNEL_MANIFEST_FIXTURES). Producer-side
// isValidKernelManifest() and this consumer-side parseProjectKernel() are
// each tested against the same inputs from their own repo's test suite, so
// a change that loosens one side without the other shows up as a failing
// test on whichever side didn't move, instead of as a silent GENERIC_REPO
// fallback in production. If you change a case here, apply the same change
// on the GPT-template side (and vice versa).
const MINIMAL_VALID_KERNEL_MANIFEST = {
  schemaVersion: 1,
  kind: 'ai-project-kernel',
  paths: { readme: 'README.md' },
  capabilities: {},
  contextRouting: { core: ['readme'] },
};

// Each fixture deviates from MINIMAL_VALID_KERNEL_MANIFEST by exactly one
// field, so it isolates one rule. Fixtures that aren't testing paths/
// contextRouting themselves still carry a valid paths+contextRouting pair
// (rather than omitting contextRouting) so the case can't accidentally pass
// for the wrong reason.
const INVALID_KERNEL_MANIFEST_FIXTURES: Array<[string, unknown]> = [
  ['missing-kind', { schemaVersion: 1, paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['wrong-kind', { schemaVersion: 1, kind: 'something-else', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['schema-version-string', { schemaVersion: '1', kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['schema-version-unsupported', { schemaVersion: 2, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['capabilities-missing', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, contextRouting: { core: ['readme'] } }],
  ['capabilities-non-boolean', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: { foo: 'yes' }, contextRouting: { core: ['readme'] } }],
  ['paths-empty', { schemaVersion: 1, kind: 'ai-project-kernel', paths: {}, capabilities: {}, contextRouting: {} }],
  ['paths-non-string-value', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 123 }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['paths-unsafe', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: '../escape.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['context-routing-unknown-key', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['missing'] } }],
  ['context-routing-tier-not-array', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: 'readme' } }],
  ['runtime-not-object', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, runtime: 'npm run x' }],
  ['runtime-empty-string-value', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, runtime: { setup: '   ' } }],
  ['validation-strategies-not-array', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, validation: { strategies: 'nope' } }],
  ['validation-strategy-invalid-type', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, validation: { strategies: [{ type: 'magic', checks: [] }] } }],
  ['validation-strategy-required-not-boolean', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, validation: { strategies: [{ type: 'push', required: 'yes', checks: [] }] } }],
  ['validation-strategy-branches-not-string-array', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, validation: { strategies: [{ type: 'push', branches: [123], checks: [] }] } }],
  ['validation-strategy-checks-not-array', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, validation: { strategies: [{ type: 'push', checks: 'nope' }] } }],
  ['validation-strategy-check-missing-name', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, validation: { strategies: [{ type: 'push', checks: [{ category: 'GUARD_FAILURE' }] }] } }],
  ['paths-unsafe-whitespace-traversal', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: ' ../escape.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['paths-unsafe-whitespace-absolute', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: ' /absolute.md' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['modes-non-string-item', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, modes: [123] }],
  ['modes-empty-string-item', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, modes: [''] }],
  ['context-routing-not-object', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: 'not-an-object' }],
  ['context-routing-inherited-key', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['toString'] } }],
  ['paths-windows-drive-absolute', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'C:/Windows/System32/drivers/etc/hosts' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['paths-null-byte', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md\u0000' }, capabilities: {}, contextRouting: { core: ['readme'] } }],
  ['governance-not-object', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, governance: 'not-an-object' }],
  ['governance-maintainer-mode-invalid', { schemaVersion: 1, kind: 'ai-project-kernel', paths: { readme: 'README.md' }, capabilities: {}, contextRouting: { core: ['readme'] }, governance: { maintainerMode: 'SOLO' } }],
];

describe('parseProjectKernel: cross-repo shared invalid-manifest contract', () => {
  it('accepts the shared minimal valid fixture', () => {
    expect(() => parseProjectKernel(JSON.stringify(MINIMAL_VALID_KERNEL_MANIFEST))).not.toThrow();
  });

  for (const [label, manifest] of INVALID_KERNEL_MANIFEST_FIXTURES) {
    it(`rejects ${label}`, () => {
      expect(() => parseProjectKernel(JSON.stringify(manifest))).toThrow();
    });
  }
});

describe('resolveContextRoutingPaths', () => {
  it('resolves core tier keys to their paths, preserving declared order', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(resolveContextRoutingPaths(parsed, 'core')).toEqual([{ key: 'soul', path: 'docs/00-soul/SOUL.md' }]);
  });

  it('returns an empty array for an undeclared tier', () => {
    const parsed = parseProjectKernel(JSON.stringify({ ...validManifest, contextRouting: { core: ['soul'] } }));
    expect(resolveContextRoutingPaths(parsed, 'onDemand')).toEqual([]);
  });
});

describe('getCheckNamesByCategory', () => {
  it('collects check names across every strategy sharing a category', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(getCheckNamesByCategory(parsed, 'HUMAN_APPROVAL_REQUIRED')).toEqual(new Set(['check-approval']));
    expect(getCheckNamesByCategory(parsed, 'GUARD_FAILURE')).toEqual(new Set(['guard']));
  });

  it('returns an empty set for an undeclared manifest', () => {
    expect(getCheckNamesByCategory(undefined, 'HUMAN_APPROVAL_REQUIRED')).toEqual(new Set());
  });
});

describe('requiresDraftPrFirst', () => {
  it('is true on a feature branch when only pull_request is required (the CI deadlock case)', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(requiresDraftPrFirst(parsed, 'claude/some-feature-branch')).toBe(true);
  });

  it('is false on the branch a required push strategy already covers', () => {
    const parsed = parseProjectKernel(JSON.stringify(validManifest));
    expect(requiresDraftPrFirst(parsed, 'main')).toBe(false);
  });

  it('is false when no validation contract is declared at all (GENERIC_REPO-equivalent)', () => {
    const { validation, ...withoutValidation } = validManifest;
    const parsed = parseProjectKernel(JSON.stringify(withoutValidation));
    expect(requiresDraftPrFirst(parsed, 'claude/some-feature-branch')).toBe(false);
    expect(requiresDraftPrFirst(undefined, 'claude/some-feature-branch')).toBe(false);
  });

  it('is false when the push strategy has no branches restriction (covers every branch)', () => {
    const parsed = parseProjectKernel(JSON.stringify({
      ...validManifest,
      validation: { strategies: [{ type: 'push', required: true, checks: [] }] },
    }));
    expect(requiresDraftPrFirst(parsed, 'claude/some-feature-branch')).toBe(false);
  });
});

// A cross-repo golden SNAPSHOT regression test, not an automatic drift
// detector: this is GPT-template's actual project-kernel.json
// (sunpotflower4460-cpu/GPT-template, branch claude/project-kernel-v2, as
// of commit 9d96c26) embedded verbatim as a point-in-time fixture. It
// catches this parser regressing against that known-good contract, and it
// is exactly how the bug it guards against — this file's own fixture using
// literal paths in contextRouting while GPT-template's real manifest used
// paths keys — was caught. It does NOT catch GPT-template changing its
// manifest shape tomorrow without a corresponding update here; nothing
// currently fetches GPT-template's live manifest at test time. Closing
// that gap for real needs either a shared JSON Schema both repos validate
// against, or a CI job that pulls GPT-template's current manifest and
// re-runs this parser against it.
const GPT_TEMPLATE_REAL_MANIFEST = `{
  "schemaVersion": 1,
  "kind": "ai-project-kernel",
  "paths": {
    "agents": "AGENTS.md",
    "phase": "PHASE.md",
    "soul": "docs/00-soul/SOUL.md",
    "designBrief": "docs/00-soul/DESIGN_BRIEF.md",
    "answers": "docs/01-intake/ANSWERS.md",
    "inventory": "docs/01-intake/INVENTORY.md",
    "questions": "docs/01-intake/QUESTIONS.md",
    "decisions": "docs/02-decisions/DECISIONS.md",
    "constraints": "docs/02-decisions/CONSTRAINTS.md",
    "features": "docs/03-scope/FEATURES.md",
    "backlog": "docs/03-scope/BACKLOG.md",
    "uiJudgments": "docs/04-design/UI_JUDGMENTS.md",
    "tokens": "docs/04-design/tokens.css",
    "handoff": "docs/05-handoff/HANDOFF.md",
    "claudeReview": "docs/05-handoff/CLAUDE_REVIEW.md",
    "craftIndex": "craft/INDEX.md",
    "craftHowTo": "craft/HOW_TO_USE.md",
    "guardConfig": "guard.config.json"
  },
  "contextRouting": {
    "_comment": "For an orchestrator assembling a prompt: read core every time, scoped only when the task touches that area, onDemand only when explicitly needed. Values are keys into paths above.",
    "core": ["agents", "phase", "soul", "constraints", "features", "guardConfig", "craftIndex"],
    "scoped": ["decisions", "uiJudgments", "tokens"],
    "onDemand": ["answers", "inventory", "questions", "backlog", "craftHowTo", "handoff", "claudeReview", "designBrief"]
  },
  "governance": {
    "_comment": "P0-P4 in PHASE.md are product-governance gates a human must move through (README.md 「新規プロジェクト開始時の流れ」). Once inside P3, the AI does not need to stop between the runtime activities below — see AGENTS.md 「5. ガバナンスとランタイムの分離」. maintainerMode is unrelated to P0-P4: it tells require-human-approval.yml's check-approval job whether this repo has a second human who can review PRs (MULTI_MAINTAINER, the default when this key is absent — preserves the original 'approval from someone other than the author' behavior) or exactly one maintainer who is also the PR author (SOLO_MAINTAINER — requires an explicit, GitHub-identity-verified /approve-maintainer PR comment from that maintainer instead, never merely opening the PR or a green CI run). AI/bot reviews (Codex, Cursor Bugbot, CodeRabbit, Claude) are evidence for that human decision, never a substitute for it, in either mode.",
    "phases": ["P0", "P1", "P2", "P3", "P4"],
    "runtimeActivitiesWithinP3": ["INSPECT", "IMPLEMENT", "TEST", "DEBUG", "REVIEW", "REPAIR", "VERIFY"],
    "maintainerMode": "SOLO_MAINTAINER"
  },
  "capabilities": {
    "structuredStatus": true,
    "structuredGuard": true,
    "dependencyPolicy": true
  },
  "dependencyPolicyDefault": {
    "_comment": "The mode guard/no-new-deps.mjs uses when guard.config.json (paths.guardConfig) does not exist or does not set dependencyPolicy. If that file exists and sets its own dependencyPolicy, that value wins — this is a fallback description, not the live value.",
    "mode": "DEV_ONLY"
  },
  "runtime": {
    "_comment": "statusJson/guardJson use --silent so npm's own banner lines ('> pkg@version script') don't precede the JSON on stdout — without it, output is not valid JSON as-is. setup picks between \`npm ci\` and \`npm install --no-package-lock\` depending on whether a lockfile exists: this repo ships none today (only refs/ has one, for the reference app, so \`npm ci\` alone would fail with EUSAGE), but a project created from this template can add real dependencies and commit a real lockfile later — \`npm install --no-package-lock\` ignores an existing lockfile even when present (not just skips writing one), so a blanket \`--no-package-lock\` would silently stop honoring that project's locked versions. \`--no-package-lock\` also keeps the still-lockfile-less case from leaving a fresh checkout dirty: npm's package-lock setting defaults to true, so a bare \`npm install\` would create an untracked root package-lock.json as a side effect. setup uses an if/else, not \`test ... && npm ci || npm install\`: the \`||\` form also runs the install fallback when \`npm ci\` exists but fails for a real reason (a stale/corrupt lockfile, a registry error), silently masking that failure as if the lockfile were simply absent. Checks for npm-shrinkwrap.json as well as package-lock.json: \`npm ci\` accepts either (shrinkwrap takes precedence if both exist), and a project that commits a shrinkwrap instead of a plain lockfile still needs \`npm ci\`, not the non-locking install path.",
    "setup": "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install --no-package-lock; fi",
    "status": "npm run status",
    "statusJson": "npm run --silent status -- --json",
    "guard": "npm run guard",
    "guardJson": "npm run --silent guard -- --json",
    "selftest": "npm run guard:selftest"
  },
  "validation": {
    "_comment": "Mirrors .github/workflows/guard.yml and require-human-approval.yml as shipped. The push strategy only runs for the branches listed — guard.yml's push trigger is 'branches: [main]', so a push to any other branch (e.g. a feature branch) does NOT get push validation; only the pull_request strategy applies there. An orchestrator must check \`branches\` before waiting on a push-triggered check on a non-listed branch, or it will wait forever — on a feature branch it must open a PR before CI can run at all, instead of waiting on a bare branch push that will never get checked. Each check's \`category\` distinguishes what kind of failure it represents: \`check-approval\` (require-human-approval.yml) always reports a plain GitHub Actions \`failure\` conclusion when it fails — never \`action_required\` — so an orchestrator that only trusts \`action_required\` to mean 'a human must act' will misclassify a missing-approval failure as a code failure and hand it back to an AI for a pointless 'fix'. \`guard\` failing is a real POLICY_FAILURE/CODE_FAILURE the AI can act on.",
    "strategies": [
      {
        "type": "push",
        "required": true,
        "branches": ["main"],
        "checks": [{ "name": "guard", "category": "GUARD_FAILURE" }]
      },
      {
        "type": "pull_request",
        "required": true,
        "checks": [
          { "name": "guard", "category": "GUARD_FAILURE" },
          { "name": "check-approval", "category": "HUMAN_APPROVAL_REQUIRED" }
        ]
      }
    ]
  }
}`;

describe('cross-repo contract: GPT-template real project-kernel.json', () => {
  it('parses without throwing', () => {
    expect(() => parseProjectKernel(GPT_TEMPLATE_REAL_MANIFEST)).not.toThrow();
  });

  it('requires a Draft PR first on a feature branch (the actual deadlock this repo hits against GPT-template)', () => {
    const parsed = parseProjectKernel(GPT_TEMPLATE_REAL_MANIFEST);
    expect(requiresDraftPrFirst(parsed, 'ai-dev-deck/some-feature')).toBe(true);
    expect(requiresDraftPrFirst(parsed, 'main')).toBe(false);
  });

  it('classifies check-approval as HUMAN_APPROVAL_REQUIRED', () => {
    const parsed = parseProjectKernel(GPT_TEMPLATE_REAL_MANIFEST);
    expect(getCheckNamesByCategory(parsed, 'HUMAN_APPROVAL_REQUIRED')).toEqual(new Set(['check-approval']));
  });

  it('resolves core context routing to real paths', () => {
    const parsed = parseProjectKernel(GPT_TEMPLATE_REAL_MANIFEST);
    const core = resolveContextRoutingPaths(parsed, 'core');
    expect(core).toContainEqual({ key: 'agents', path: 'AGENTS.md' });
    expect(core).toContainEqual({ key: 'soul', path: 'docs/00-soul/SOUL.md' });
  });

  it('reads governance.maintainerMode as SOLO_MAINTAINER (this repo is solo-maintained)', () => {
    const parsed = parseProjectKernel(GPT_TEMPLATE_REAL_MANIFEST);
    expect(getMaintainerMode(parsed)).toBe('SOLO_MAINTAINER');
  });
});
