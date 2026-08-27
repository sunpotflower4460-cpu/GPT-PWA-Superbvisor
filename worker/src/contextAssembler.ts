import { GitHubEnv, readOptionalFile } from './githubExecutor';
import { ProjectKernelManifest, resolveContextRoutingPaths } from './projectKernel';

// Wires up ProjectKernelManifest.contextRouting (CORE/SCOPED/onDemand),
// which projectKernel.ts's resolveContextRoutingPaths() already parses and
// exports but which nothing in the codebase actually called before this —
// the Kernel's own routing tiers were declared and typed, never consumed.
// This is the "作業内容によって読む" (§5 of the design) Context Assembler:
// CORE is always fetched, SCOPED only when the task text looks related,
// onDemand is never auto-fetched (its keys are still reported, so a caller
// that genuinely needs one can fetch it directly via readOptionalFile).
export interface AssembledContextSection {
  key: string;
  path: string;
  tier: 'core' | 'scoped';
  content: string;
  truncated: boolean;
}

export interface AssembledContext {
  sections: AssembledContextSection[];
  // Ready-to-append prompt block; empty string when nothing was fetched
  // (e.g. every declared path is missing, or contextRouting is absent).
  text: string;
  // Keys that exist under contextRouting.onDemand — reported, never
  // fetched, so a caller can see what's available without this module
  // silently deciding on its behalf.
  omittedOnDemandKeys: string[];
  // Scoped keys that WERE relevant to the task but got dropped because the
  // char budget ran out before reaching them — distinct from
  // omittedOnDemandKeys (never fetched by design) so a caller/log can tell
  // "chose not to" from "ran out of room".
  omittedForBudgetKeys: string[];
  budgetChars: number;
  usedChars: number;
}

const DEFAULT_BUDGET_CHARS = 12_000;
const MIN_BUDGET_CHARS = 1_000;
const MAX_BUDGET_CHARS = 40_000;
const MIN_SECTION_CHARS = 200;
const CORE_SHARE = 0.6;
const SCOPED_SHARE = 0.25;

export interface AssembleKernelContextInput {
  env: GitHubEnv;
  repository: string;
  ref: string;
  manifest: ProjectKernelManifest;
  task: string;
  budgetChars?: number;
}

export async function assembleKernelContext(input: AssembleKernelContextInput): Promise<AssembledContext> {
  const budgetChars = clampBudget(input.budgetChars ?? DEFAULT_BUDGET_CHARS);
  const core = resolveContextRoutingPaths(input.manifest, 'core').map((entry) => ({ ...entry, tier: 'core' as const }));
  const scoped = resolveContextRoutingPaths(input.manifest, 'scoped')
    .filter((entry) => isTaskRelevant(input.task, entry.key))
    .map((entry) => ({ ...entry, tier: 'scoped' as const }));
  const onDemand = resolveContextRoutingPaths(input.manifest, 'onDemand');

  const sections: AssembledContextSection[] = [];
  const omittedForBudgetKeys: string[] = [];
  let remaining = budgetChars;

  for (const entry of [...core, ...scoped]) {
    if (remaining < MIN_SECTION_CHARS) {
      omittedForBudgetKeys.push(entry.key);
      continue;
    }
    const file = await readOptionalFile(input.env, input.repository, input.ref, entry.path).catch(() => null);
    if (!file) continue; // declared path missing from the repo — skip, not fatal (readOptionalFile's own contract)

    const share = entry.tier === 'core' ? CORE_SHARE : SCOPED_SHARE;
    const allowance = Math.max(MIN_SECTION_CHARS, Math.min(remaining, Math.ceil(budgetChars * share)));
    const truncated = file.content.length > allowance;
    const content = truncated ? `${file.content.slice(0, allowance)}\n…(truncated, ${file.content.length - allowance} more characters omitted)` : file.content;
    sections.push({ key: entry.key, path: entry.path, tier: entry.tier, content, truncated });
    remaining -= content.length;
  }

  const text = sections
    .map((section) => `### [${section.tier.toUpperCase()}] ${section.key} (${section.path})\n${section.content}`)
    .join('\n\n');

  return {
    sections,
    text,
    omittedOnDemandKeys: onDemand.map((entry) => entry.key),
    omittedForBudgetKeys,
    budgetChars,
    usedChars: budgetChars - remaining,
  };
}

function clampBudget(value: number) {
  const truncated = Number.isFinite(value) ? Math.trunc(value) : DEFAULT_BUDGET_CHARS;
  return Math.max(MIN_BUDGET_CHARS, Math.min(MAX_BUDGET_CHARS, truncated));
}

// Deliberately simple, non-LLM relevance heuristic — this is the MVP the
// design calls for ("作業内容によって読む"), not a semantic classifier. A
// scoped key with no keyword mapping below is treated as always-relevant:
// silently never including an unrecognized scoped section is a worse
// default than occasionally including one that turns out unrelated to this
// specific task.
const SCOPED_KEYWORDS: Record<string, string[]> = {
  uiJudgments: ['ui', 'ux', 'design', 'screen', 'component', '画面', 'デザイン', '見た目'],
  tokens: ['ui', 'style', 'color', 'token', 'css', 'デザイン', '色', 'スタイル'],
  decisions: ['why', 'decision', 'rationale', '決定', '経緯', 'architecture', '設計', 'なぜ'],
};

function isTaskRelevant(task: string, key: string): boolean {
  const keywords = SCOPED_KEYWORDS[key];
  if (!keywords?.length) return true;
  const haystack = task.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}
