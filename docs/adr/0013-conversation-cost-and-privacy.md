# ADR 0013: What a Conversation costs, and what leaves the house

Date: 2026-09-22
Status: Accepted
Tickets: [#30](https://github.com/lanshengzhi/learn-buddy/issues/30) (this decision), [#31](https://github.com/lanshengzhi/learn-buddy/issues/31) (what is observable), [#32](https://github.com/lanshengzhi/learn-buddy/issues/32) (pi's measured limits), [#24](https://github.com/lanshengzhi/learn-buddy/issues/24) (one OAuth route per home)

The family hub sends the current **Chapter** — not one sentence — to OpenAI on the household's existing subscription. There is no spending cap and no per-Person quota, because on this route neither is measurable; Conversations are counted for the log, not for enforcement; and the product states plainly what leaves the home.

## Context

- The reader's AI layer (ADR 0008, issue #15) was built around one narrow request: `{word, sentence, language}` — a single sentence, with no Person attached. Its cost was the household's existing pi subscription, with no cap and no throttle.
- Chat changes both halves. The context boundary settled in issue #34 is **the current Chapter by default** plus explicit **References**; map #9 measured the largest chapter at 72k characters / 44k tokens. And the conversation history is itself family content.
- Issue #31 established the observability ceiling: pi-ai throws one ordinary English sentence on a usage wall and **conflates an exhausted subscription with a transient rate limit** — the provider's error code is dropped inside the library. No "remaining quota" field exists anywhere on either engine.
- Research #24 established that `openai-codex` is the only OAuth-only catalog provider and that **one home can carry exactly one such route**, so a per-Person route — and therefore per-Person quota — cannot be expressed on the subscription path at all.

## Decisions

- **No spending cap and no per-Person quota in v1.** On a flat-rate subscription there is no marginal cost for a cap to act on, and per-Person metering is not expressible on this route. Issue #30's answer is a deliberate *no*.
- **`ai_usage_limit` is the visible state.** A Conversation that hits the wall fails with a distinct code and the reset time pi renders into the message (`Try again in ~N min`), rather than the generic upstream error. The copy says **用量受限**, never "quota exhausted": the library cannot tell the two apart, and guessing would alarm the family on every transient throttle.
- **Per-Conversation tokens are recorded, never displayed.** pi reports tokens and a nominal cost per session (research #32); they are logged so a future decision can ask whether hitting the wall has become routine. They are not shown, because on a subscription a nominal cost is not money spent.
- **The provider is the household's existing OpenAI subscription** — the `openai-codex` OAuth route the reader already uses. Chosen for zero new accounts and zero new cost, not because it is the only option.
- **The product states what leaves the home.** Every Conversation sends the current Chapter by default, whatever the Person References, and the conversation history — to OpenAI. The specification names this explicitly rather than leaving it implicit in a context-boundary decision.
- **Upstream error text is never forwarded.** `parseErrorResponse` seeds its message with the **entire response body**; only fixed, product-owned strings cross the HTTP boundary (issue #31).

## Considered Options

- **Per-Person soft quota on the subscription** — rejected: not measurable on a single OAuth-only route, so the number would be invented.
- **Move to a metered API key for observability** — rejected for v1, worth revisiting if the wall becomes routine: it buys per-token visibility and real quotas at the price of money and a new credential.
- **Switch to another hosted provider** — rejected as a distinction without a difference: family conversations would still leave the home.
- **A local model** — the only option that keeps content inside the house; rejected for v1 on quality and hardware, not on principle.
- **Showing per-Person usage** — rejected: on a flat-rate plan a nominal cost reads as a bill, and nothing is owed.

## Consequences

- Privacy is a **documented property, not an enforced one**: the product does not read one Person's Conversations on another's behalf (issue #34), and the identity chip has no lock (issue #26). The boundary is convention plus documentation — consistent with map #23's *Out of scope*.
- If the family starts hitting the wall routinely, the logged token counts are the evidence and switching the route to a metered key is the escape hatch. Neither needs new design now.
- **Whatever is sent cannot be unsent**: this decision is cheap to make and expensive to unmake, which is why it is recorded rather than assumed.
