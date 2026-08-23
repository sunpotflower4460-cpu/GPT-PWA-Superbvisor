# AI DEV DECK repository instructions

Treat `docs/PRODUCT_CONSTITUTION.md` and `product-concept.json` as the highest-level product constraints.

The primary product is **Multi Chat Remote**: one mobile-first PWA controlling multiple existing ChatGPT development conversations.

Keep these role boundaries:

- ChatGPT conversation: implementation, debugging, review, GitHub execution.
- PWA: multi-chat control plane.
- Worker: durable queue/state/evidence/recovery/notifications.
- External LLMs: orchestration-only.
- ChatGPT Apps Bridge: same-conversation transport only.

Do not redesign the product into a second IDE, generic project manager, provider router, chat viewer, or external autonomous coding agent.

Do not add external-LLM repository write/delete/merge authority, automatic merge, automatic production deploy, or unofficial ChatGPT cookie/session automation unless the Product Constitution is deliberately amended with human review.

When implementing features, optimize first for:

1. faster multi-chat control;
2. lower mobile interaction cost;
3. durable queue/state;
4. safe recovery;
5. evidence-based completion;
6. minimal settings complexity.

Run `npm run concept:guard` before declaring work complete. If it fails, investigate product drift before changing the guard.
