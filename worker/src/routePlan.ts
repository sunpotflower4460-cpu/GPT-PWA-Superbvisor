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

// The Worker-AUTHORITATIVE current phase — deliberately NOT derived from
// the self-reported AutopilotRouteState.checkpoints[].step text (that
// field is free-form and explicitly never validated, see this file's top
// comment). Instead it counts how many checkpoints the Worker itself has
// actually witnessed (recordAutopilotRouteCheckpoint in orchestratorPolicy.ts
// only appends on a genuinely new, CI-observed head) and maps that count
// straight onto the declared plan's index — "N verified checkpoints reached
// so far" means "phase N is the one now in progress", capped at the last
// declared phase. A job with no declared route, or a plain one-shot job
// that never advances past its first checkpoint, simply always resolves to
// phase 0 (or undefined) — which is correct: there is nothing to advance
// through.
export function resolveCurrentRouteNode(routePlan: RouteNode[] | undefined, checkpointCount: number): RouteNode | undefined {
  if (!routePlan?.length) return undefined;
  const index = Math.max(0, Math.min(checkpointCount, routePlan.length - 1));
  return routePlan[index];
}

// The actual dispatch destination for the NEXT outgoing handoff: the
// current phase's declared chatUrl if one was bound, otherwise the job's
// own default chatUrl. Never invents a destination — undefined means
// "nowhere to send this", same as today's behavior for a job with no
// chatUrl at all.
export function resolveRouteDispatchChatUrl(
  routePlan: RouteNode[] | undefined,
  checkpointCount: number,
  fallbackChatUrl: string | undefined,
): string | undefined {
  return resolveCurrentRouteNode(routePlan, checkpointCount)?.chatUrl || fallbackChatUrl;
}
