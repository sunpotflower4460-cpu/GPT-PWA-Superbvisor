## What changed

<!-- Describe the user-visible or architectural change. -->

## Why

<!-- What problem does this solve? -->

## Concept Alignment

Before submitting, read `docs/PRODUCT_CONSTITUTION.md` and `product-concept.json`.

- [ ] This change strengthens or clearly supports **Multi Chat Remote** as the primary product value.
- [ ] Existing ChatGPT development conversations remain the implementation/debugging executor.
- [ ] Supervisor / Guardian / external LLMs remain supporting orchestration layers, not the main coding agent.
- [ ] Mobile-first / low-friction operation is preserved or improved.
- [ ] Recoverable failures remain recoverable states rather than fake completion.
- [ ] Completion still requires real evidence where evidence is available.
- [ ] No unofficial ChatGPT cookie/session automation was introduced.
- [ ] No automatic merge or production deployment was introduced without an explicit product-level decision.

### North Star impact

<!-- In 1–3 sentences: How does this make controlling multiple existing ChatGPT development chats from the PWA better, safer, faster, or more durable? -->

### Concept-impacting change?

- [ ] No — product boundaries are unchanged.
- [ ] Yes — this deliberately changes a protected product invariant.

If **Yes**, explain why the product concept itself must change, and update all of:

- `docs/PRODUCT_CONSTITUTION.md`
- `product-concept.json`
- `docs/ARCHITECTURE.md`
- relevant Concept Guard assertions

Do not weaken Concept Guard merely to pass CI.

## Safety / Evidence

- [ ] No secret is exposed to the PWA or ChatGPT widget.
- [ ] No external LLM gained repository write/delete/merge authority.
- [ ] CI/current-head evidence is not confused with AI self-report.
- [ ] Human-only actions remain explicit as `WAITING_USER / あなた待ち`.

## Verification

- [ ] `npm run concept:guard`
- [ ] App build
- [ ] Worker typecheck/tests when affected
- [ ] ChatGPT Bridge typecheck/dry-run when affected

## Manual checks still required

<!-- List only checks a human/device/ChatGPT host must perform. Use "None" if there are none. -->
