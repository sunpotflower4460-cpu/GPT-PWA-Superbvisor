# AI DEV DECK — Instructions for Coding Agents

Before making architecture, product, automation, transport, worker, bridge, completion, or execution-route changes, read:

1. `docs/PRODUCT_CONSTITUTION.md`
2. `product-concept.json`
3. `docs/ARCHITECTURE.md`

These are not optional background documents. They define the product boundary.

## Non-negotiable product direction

AI DEV DECK exists primarily to let the user control **multiple existing ChatGPT development conversations from one mobile-first PWA**.

Do not silently turn it into:

- a second IDE;
- a Claude Code/Cursor clone;
- an external-API autonomous coding agent;
- a generic project manager;
- a provider-routing product;
- a chat transcript viewer.

## Role boundary

- ChatGPT conversation = implementation/debug/review/GitHub executor.
- PWA = multi-chat control plane.
- Worker = durable queue/state/evidence/recovery/notification supervisor.
- External LLM APIs = classification, summarization, next/recovery command generation only.
- ChatGPT Apps Bridge = transport into the same host conversation; not a coding agent.

## Safety boundary

Do not introduce, without an explicit product-level decision:

- external LLM GitHub write/delete/merge tools;
- automatic merge;
- automatic production deployment;
- ChatGPT session-cookie/session-token automation;
- unofficial authentication bypass;
- completion based only on an AI self-report.

## Implementation priority test

When multiple designs are possible, prefer the one that:

1. makes multi-chat operation faster or clearer;
2. reduces mobile interaction cost;
3. preserves durable queue/state while the PWA is closed;
4. keeps ChatGPT as the executor;
5. improves recovery and evidence;
6. adds the least configuration/UI complexity.

Supervisor/Guardian/Autopilot sophistication is secondary to a natural Multi Chat Remote experience.

## Protected changes

Changes to the following are concept-impacting and must preserve or deliberately amend the Constitution:

- `product-concept.json`
- `docs/PRODUCT_CONSTITUTION.md`
- `docs/ARCHITECTURE.md`
- `scripts/concept-guard.mjs`
- worker execution boundaries
- Chat Control Bus
- ChatGPT Bridge transport
- completion/evidence logic
- merge/deploy boundaries

Run before considering work complete:

```bash
npm run concept:guard
```

If Concept Guard fails, do not weaken it just to make CI green. First determine whether the implementation drifted from the product concept. If the product concept itself genuinely needs to change, update the Constitution and manifest explicitly and keep the change human-reviewable.
