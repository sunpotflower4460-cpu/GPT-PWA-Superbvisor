# ADR: <decision title>

Status: Proposed
Date: YYYY-MM-DD
Concept version: `multi-chat-remote-v1`

## Context

What problem requires an architectural decision?

## North Star impact

How does this strengthen the primary product experience: controlling multiple existing ChatGPT development conversations from one mobile-first PWA?

If the answer is indirect, name the specific Multi Chat Remote capability this supports.

## Product invariants checked

- [ ] Multi Chat Remote remains the primary product value.
- [ ] Existing ChatGPT remains the implementation/debugging executor.
- [ ] External LLMs remain orchestration-only.
- [ ] PWA remains the multi-chat control plane.
- [ ] Worker remains durable orchestration/evidence infrastructure.
- [ ] Failure remains recoverable where possible.
- [ ] Completion remains evidence-based.
- [ ] Human-only actions remain explicit.
- [ ] No unofficial ChatGPT session/cookie automation is introduced.
- [ ] No implicit automatic merge or production deploy is introduced.
- [ ] Mobile interaction cost is acceptable.

## Options considered

### Option A

Description, benefits, tradeoffs.

### Option B

Description, benefits, tradeoffs.

## Decision

What are we choosing and why?

## Why this is not concept drift

Explain why this does not turn AI DEV DECK into a second IDE, external autonomous coding agent, generic project manager, provider router, or chat viewer.

## Evidence / verification

What objective evidence will prove this decision works?

## Failure and recovery behavior

What happens when this component or external provider fails? How does the system recover without falsely declaring completion?

## Human boundary

What still requires explicit human action?

## Consequences

Positive and negative consequences, including added settings/UI/operational complexity.

## Constitution amendment required?

- [ ] No
- [ ] Yes — update `docs/PRODUCT_CONSTITUTION.md`, `product-concept.json`, `docs/ARCHITECTURE.md`, and Concept Guard deliberately.
