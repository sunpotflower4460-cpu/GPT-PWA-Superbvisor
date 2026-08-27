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
export interface RouteNode {
  id: string;
  label: string;
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
    nodes.push({ id: id.trim().slice(0, 64), label: label.trim().slice(0, MAX_LABEL_CHARS) });
    if (nodes.length >= MAX_ROUTE_NODES) break;
  }
  return nodes.length ? nodes : undefined;
}
