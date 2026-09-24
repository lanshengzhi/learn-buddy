---
status: accepted
---

# ADR 0016: Read is pure reading; language-learning tools live on a separate Learn page

Read is the ebook-reading experience and nothing else: shelf, chapters, and reading position. The legacy language-learning surface — playback, dictionary lookup, vocabulary marking, paste-and-segment, and passage history — moves to its own left-nav entry, **Learn**, which in v1 works on pasted text rather than Books. This is the household's separately-requested exception to spec #45's Out-of-Scope note that legacy learning features stay outside the product; it keeps those tools available without mixing them into Read. The old shell at `/` keeps its current mixed surface until it is retired (ADR 0014), and Learn shares nothing with Chat (ADR 0015).

## Considered options

- **Keep the learning tools in Read behind a toggle** — rejected: the toggle still mixes two experiences in one surface, which is the problem being fixed.
- **A book-aware Learn page (open a Book, study its chapters)** — deferred, not rejected: it needs a second reading surface and a second reading-position path, so it is a separate decision after v1.

## Amendment — 2026-09-24, Read/Learn boundary refined (#51)

The first split was too coarse: measured against the household's reference reader (WeChat Reading / 微信读书), the boundary is **reading affordances vs study tools**, not "everything non-reading into Learn":

- **Read keeps** shelf, chapters, reading position, **read-aloud** (continuous playback from the current position: play/pause, prev/next sentence, rate; loop limited to off/all), **word lookup** (wide: the lookup tab; narrow: the word card), and the selection toolbar. Tapping a sentence in Read selects it and records the reading position but starts no audio — playback starts only from the read-aloud bar.
- **Learn keeps** pasted text: segmentation, per-sentence listening with **single-sentence looping**, word lookup, and passage history — the deliberate-practice tools WeChat Reading does not have. The phrase "playback, lookup … belong to Learn" above now means the *study* forms of them, not reading aloud or looking up a word in Read.
- Vocabulary marking (标生词) is exposed **nowhere** in v1: it only works on a Book's word spans, and Learn's pasted sentences have no word-level rendering. Revisit together with the deferred book-aware Learn page.
- **Read and Learn each own a playback controller and bar** (two controller instances, separate state): the single shared controller in the legacy app let the Learn bar drive a Book's chapter after opening one. The old shell `/` keeps its single controller and tap-to-play behavior.
- Still out of scope: highlights/notes (划线/想法), AI 问书, listen timers/background play, and studying a Book's chapters in Learn — each a separate decision (spec #45).
