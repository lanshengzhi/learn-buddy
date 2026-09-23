---
status: accepted
---

# ADR 0016: Read is pure reading; language-learning tools live on a separate Learn page

Read is the ebook-reading experience and nothing else: shelf, chapters, and reading position. The legacy language-learning surface — playback, dictionary lookup, vocabulary marking, paste-and-segment, and passage history — moves to its own left-nav entry, **Learn**, which in v1 works on pasted text rather than Books. This is the household's separately-requested exception to spec #45's Out-of-Scope note that legacy learning features stay outside the product; it keeps those tools available without mixing them into Read. The old shell at `/` keeps its current mixed surface until it is retired (ADR 0014), and Learn shares nothing with Chat (ADR 0015).

## Considered options

- **Keep the learning tools in Read behind a toggle** — rejected: the toggle still mixes two experiences in one surface, which is the problem being fixed.
- **A book-aware Learn page (open a Book, study its chapters)** — deferred, not rejected: it needs a second reading surface and a second reading-position path, so it is a separate decision after v1.
