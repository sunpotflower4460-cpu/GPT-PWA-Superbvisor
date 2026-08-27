import { normalizeChatUrl } from './chatCommandQueue';

// The "Route" layer of the design's Goal/Route/Task separation. Goal
// (DeveloperJob.goal) and Task (DeveloperJob.prompt) were already distinct
// fields before this module existed — what was missing was Route: a
// structured, ordered plan of named phases, as opposed to
// orchestratorPolicy.ts's AutopilotRouteState, which is a self-reported
// PROGRESS log (free-text checkpoints ChatGPT writes into commit messages,
// deliberately never interpreted or validated — see that module's own
// comments). A RouteNode[] here is the opposite kind of thing: it's the
// PLAN, declared upfront by the caller (the PWA, from src/operatingPlan.ts's
// parseRoutePlan), not inferred from anything ChatGPT writes later. The two
// stay separate on purpose — conflating "what was planned" with "what was
// self-reported as reached" would let a self-report silently redefine the
// plan.
//
// chatUrl is optional Multi Chat / Specialist Chat groundwork: a phase MAY
// declare which of the user's OWN already-open ChatGPT chats should receive
// that phase's handoff, instead of every phase always going to the job's
// single default chatUrl. This is a declared MAPPING the user set up, never
// an inferred/AI-picked destination — consistent with this module's own
// "never let a self-report (or a guess) redefine the plan" rule. A node
// with no chatUrl simply falls back to the job's default chat — see
// resolveRouteDispatch below.
export interface RouteNode {
  id: string;
  label: string;
  chatUrl?: string;
}

const MAX_ROUTE_NODES = 20;
const MAX_LABEL_CHARS = 200;

// Best-effort sanitizer for a RouteNode[] arriving over the wire (an
// untrusted request body) — never throws, drops anything malformed rather
// than rejecting the whole job creation over an optional field. Returns
// undefined (not an empty array) when nothing valid was provided, so
// callers can tell "no route declared" from "an empty route was declared".
export function parseRoutePlanInput(value: unknown): RouteNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes: RouteNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    const label = (item as { label?: unknown }).label;
    if (typeof id !== 'string' || !id.trim() || typeof label !== 'string' || !label.trim()) continue;
    const rawChatUrl = (item as { chatUrl?: unknown }).chatUrl;
    const chatUrl = typeof rawChatUrl === 'string' && rawChatUrl.trim() ? normalizeChatUrl(rawChatUrl) ?? undefined : undefined;
    nodes.push({ id: id.trim().slice(0, 64), label: label.trim().slice(0, MAX_LABEL_CHARS), ...(chatUrl ? { chatUrl } : {}) });
    if (nodes.length >= MAX_ROUTE_NODES) break;
  }
  return nodes.length ? nodes : undefined;
}

// The Worker-AUTHORITATIVE current phase index, held on the job as
// DeveloperJob.routePhaseIndex — deliberately NOT derived from route-
// checkpoint COUNT (an earlier version of this did that; wrong, because a
// checkpoint is recorded on every CI-green commit, and one declared phase —
// e.g. "設計" — routinely spans MANY commits before it is actually done;
// counting commits as phases would flip the dispatch target away from an
// in-progress chat the moment the FIRST commit of that phase went green).
// It is also NOT derived from AutopilotRouteState.checkpoints[].step (that
// remains free-form prose, explicitly never validated — see this file's top
// comment). Instead it only ever advances via extractRoutePhaseIndex below:
// an EXACT match against one of the plan's own declared ids, the same
// closed-set-marker trust level this system already gives
// AUTOPILOT_ROUTE_COMPLETE_MARKER for overall completion — not open-ended
// interpretation of prose, just "does this commit message contain this
// exact known id". A job with no declared route, or one that never emits
// the marker, simply always resolves to phase 0 — the same safe fallback
// as before this field existed.
export function resolveCurrentRouteNode(routePlan: RouteNode[] | undefined, phaseIndex: number): RouteNode | undefined {
  if (!routePlan?.length) return undefined;
  const index = Math.max(0, Math.min(phaseIndex, routePlan.length - 1));
  return routePlan[index];
}

// The actual dispatch destination for the NEXT outgoing handoff: the
// current phase's declared chatUrl if one was bound, otherwise the job's
// own default chatUrl. Never invents a destination — undefined means
// "nowhere to send this", same as today's behavior for a job with no
// chatUrl at all.
export function resolveRouteDispatchChatUrl(
  routePlan: RouteNode[] | undefined,
  phaseIndex: number,
  fallbackChatUrl: string | undefined,
): string | undefined {
  return resolveCurrentRouteNode(routePlan, phaseIndex)?.chatUrl || fallbackChatUrl;
}

const ROUTE_PHASE_MARKER_PATTERN = /\[ROUTE_PHASE_ID:\s*([^\]\n]{1,64})\]/;

// Reads a declared-phase-id reference out of a commit message. This is a
// closed-set EXACT match against routePlan's own ids, not free-text
// interpretation — a commit with no marker, a malformed marker, or an id
// that isn't one of the plan's own simply yields undefined and changes
// nothing (see advanceRoutePhaseIndex).
export function extractRoutePhaseIndex(routePlan: RouteNode[] | undefined, commitMessage: string | undefined): number | undefined {
  if (!routePlan?.length || !commitMessage) return undefined;
  const id = commitMessage.match(ROUTE_PHASE_MARKER_PATTERN)?.[1]?.trim();
  if (!id) return undefined;
  const index = routePlan.findIndex((node) => node.id === id);
  return index >= 0 ? index : undefined;
}

// Monotonic on purpose: the job's route phase can only move FORWARD (or
// stay put), never regress — protects against a stale/out-of-order commit
// message, or a later commit that happens to reference an earlier phase's
// id, silently undoing already-dispatched progress.
export function advanceRoutePhaseIndex(currentIndex: number, reportedIndex: number | undefined): number {
  if (reportedIndex === undefined) return currentIndex;
  return Math.max(currentIndex, reportedIndex);
}

// The instruction block appended to AUTOPILOT ROUTE prompts when the job
// has a declared plan — tells ChatGPT the fixed id/label pairs and asks it
// to reference the id (not free text, not the label) via ROUTE_PHASE_ID
// once it moves to a new phase. Absent entirely for a job with no declared
// route, so existing AUTOPILOT ROUTE behavior for jobs that never opted
// into a declared plan is completely unchanged.
export function routePhaseIdInstruction(routePlan: RouteNode[] | undefined): string {
  if (!routePlan?.length) return '';
  const list = routePlan.map((node) => `- ${node.id}: ${node.label}`).join('\n');
  return `\n\nルート工程ID:\nこのTASKには固定IDつきの工程一覧があります。取り組んでいる工程が新しいものに変わったら、そのタイミングのコミットメッセージに [ROUTE_PHASE_ID: 該当ID] を1行含めてください(例: [ROUTE_PHASE_ID: ${routePlan[0].id}])。同じ工程が続く間は省略して構いません。ID一覧:\n${list}`;
}
