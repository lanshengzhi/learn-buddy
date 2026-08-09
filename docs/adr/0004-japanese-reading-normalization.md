# Japanese reading normalization: a G2P stage in the TTS pipeline

Japanese kanji are polyphonic, and Edge TTS — which LearnBuddy proxies — reads
raw text with its own internal G2P, so it occasionally mispronounces words
(銀行 read as コウ, 一人称 read on-yomi, date/number compounds, proper nouns).
This ADR records what the first spike and two deployments taught us, and locks
the design that survived real listening.

## Context

Edge TTS cannot take reading hints: it rejects custom SSML (no `<phoneme>`,
no `<ruby>`, no `<sub>`), and parenthesized furigana (`今日（きょう）`) is read
as ordinary text. The only lever before synthesis is **text rewriting**:
replace kanji with their kana reading. LearnBuddy's backend is stdlib-only
(ADR 0001) and serves the whole family; per-request LLM calls were rejected as
the primary path for latency, cost, privacy, and offline-replay reasons.

Two rounds of deployed normalization were **rejected by ear**:

1. **Full-kana katakana** (`カブシキガイシャは、テイカンで…`) — Edge's ja-JP
   voices treat katakana as a loanword and apply the head-high (頭高) foreign
   accent: 株式会社 sounded カ↑ブシキガイシャ. Wrong pitch on the first mora.
2. **Full-kana hiragana** (`かぶしきがいしゃは、ていかんで…`) — Edge reads
   kana with its own default accent contours, losing the lexical pitch accent
   it derives from kanji dictionaries. Some words happened to sound right
   (株式会社), others did not.

Conclusion: **kana text, in any form, discards the accent information that
kanji carries.** The original kanji text is the only input that keeps Edge's
native, dictionary-accented pronunciation.

## Decisions

- **A G2P stage lives in the backend** (`server/reading.py`), between
  `validate_request` and the Edge TTS client in `TtsServer.synthesize`. It
  fires only for Japanese voices (`ja-JP`); en/zh pass through untouched.
- **Kanji-default, curated replacement.** The original text passes through
  unchanged; only surfaces in `JA_REPLACE_READINGS` — words the family has
  *confirmed* Edge misreads — are rewritten to their correct hiragana reading
  (longest-match-first). Every entry trades away Edge's native accent for a
  guaranteed reading, so the list stays minimal and grows only from real
  misreads, never from speculation.
- **`JA_REPLACE_READINGS` is runtime-mutable**, so a future learner-override
  layer can add entries without redeploying. The SudachiPy analyzer is parked
  as the reference for computing readings of new entries and for the planned
  DeepSeek/BYOK fallback layer — it is not part of the hot path.
- **The server audio cache keys on the normalized text plus a version**
  (`SHA-256("{NORM_VERSION}|{normalized}|{voice}|{rate}")`). Bumping
  `NORM_VERSION` invalidates stale audio when the logic changes. The frontend
  is untouched: it caches audio by the request URL of the raw text, and
  normalization is deterministic, so raw-text URLs map stably to one stream.

## Considered Options

- **Full-kana katakana** — tried and deployed; rejected by ear (loanword
  head-high accent on every native word).
- **Full-kana hiragana** — tried and deployed; rejected by ear (kana input
  loses the lexical accent Edge derives from kanji).
- **Selective replacement with an automatic "risky" signal** — rejected: no
  reliable automatic signal exists (the analyzer emits one reading, not an
  ambiguity score; "unusual reading" heuristics over-trigger on common 連濁
  words like 株式会社). The curated list *is* the selection.
- **DeepSeek/BYOK as the primary normalizer** — rejected for the primary path
  (latency per sentence breaks tap-to-hear, family text leaves the box,
  offline replay of new text impossible). A future BYOK fallback may run only
  for analyzer failures or explicit learner corrections.
- **Azure Speech (real SSML `<phoneme>`/lexicon)** — rejected: paid, needs an
  account, contradicts the free family-server positioning.

## Consequences

- `server/reading.py` + `server/tests/test_reading.py`; `tts_server.py` gains
  an injectable `normalizer` (tests pass a fake; production uses
  `reading.normalize_ja`). With an empty replacement table the stage is
  identity — safe by default.
- The server cache key format is versioned (normalized text + version); old
  cache files become orphans, which is harmless (speed layer only).
- Deployment no longer requires sudachipy for the hot path (kanji-default
  needs no analyzer); it remains a reference for future layers and may be
  dropped from the service venv if it stays unused.
- The original mispronunciation pain is addressed by growing
  `JA_REPLACE_READINGS` from real usage, and the learner-override / BYOK
  layers (ADR "Considered Options") remain the long-term answer for proper
  nouns and 当て字, which no dictionary reliably reads.
