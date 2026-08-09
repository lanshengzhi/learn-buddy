# Japanese reading normalization: a G2P stage in the TTS pipeline

Japanese kanji are polyphonic, and Edge TTS — which LearnBuddy proxies — reads
raw text with its own internal G2P, so it occasionally mispronounces words
(銀行 read as コウ, 一人称 read on-yomi, date/number compounds, proper nouns).
The first spike (this ADR) validated a local fix and locked its design; a
DeepSeek/BYOK fallback for analyzer failures is a planned future layer, not
part of this decision.

## Context

Edge TTS cannot take reading hints: it rejects custom SSML (no `<phoneme>`,
no `<ruby>`, no `<sub>`), and parenthesized furigana (`今日（きょう）`) is read
as ordinary text. The only lever before synthesis is **text rewriting**:
replace kanji with their kana reading. LearnBuddy's backend is stdlib-only
(ADR 0001) and serves the whole family; per-request LLM calls were rejected as
the primary path for latency, cost, privacy, and offline-replay reasons.

A spike verified SudachiPy (morphological analyzer, `pip install sudachipy
sudachidict_core`) on the deployment box: context disambiguation resolves the
classic cases correctly — 銀行/行く (ギンコウ/イキ), 一人/一人称 (ヒトリ/
イチニンショウ), 橋/箸 (ハシ/ハシ), 東京大学 (トウキョウダイガク), 一生懸命
(イッショウケンメイ), 今日 (キョウ), 昨日 (キノウ).

## Decisions

- **A G2P stage lives in the backend** (`server/reading.py`), between
  `validate_request` and the Edge TTS client in `TtsServer.synthesize`. It
  fires only for Japanese voices (`ja-JP`); en/zh pass through untouched.
- **Output is a full-kana (hiragana) reading**, produced per-token by
  SudachiPy in `SplitMode.C`. Kana tokens, particles, punctuation, and Latin
  script keep their surface, so particle は/へ stay as written and Edge TTS
  reads them natively. Display text is never touched — this only rewrites the
  audio input.
- **Hiragana, not katakana.** Edge's ja-JP voices choose pitch-accent
  strategy from the writing form: katakana signals a loanword and triggers
  the head-high (頭高) foreign accent — the first deployed version read
  カブシキガイシャ with the accent on the first syllable, which listeners
  rejected by ear. Hiragana is read with native Japanese word accents and was
  confirmed correct. Original katakana in the text (コーヒー) stays katakana,
  where its loanword accent is correct anyway.
- **A corrections table pins the analyzer's known failures.** SudachiPy
  splits date/number compounds and misreads them (`一日中` → イチニチチュウ,
  `二十日` → ニトウカ, `一昨日` → イッサクニチ, `一昨年` → イッサクネン,
  `一晩中` → イチバンチュウ, `明後日` → ミョウゴニチ). These are applied
  longest-match-first **before** tokenization: 一昨昨日 → サキオトトイ,
  一昨日 → オトトイ, 一昨年 → オトトシ, 一日中 → イチニチジュウ, 一晩中 →
  ヒトバンジュウ, 二十日 → ハツカ, 明後日 → アサッテ.
- **The dependency is optional and degrades to identity.** `reading.py`
  imports SudachiPy in a `try/except`; without it installed the normalizer
  returns text unchanged. This keeps the backend's stdlib-only test suite
  green and the server runnable on a box that lacks the dependency.
- **The server audio cache keys on the normalized text plus a version**
  (`SHA-256("{NORM_VERSION}|{normalized}|{voice}|{rate}")`). A kanji sentence
  and its kana form therefore share one cache entry (same reading, one
  synthesis), and bumping `NORM_VERSION` invalidates stale readings when the
  logic changes. The frontend is untouched: it caches audio by the request
  URL of the raw text, and normalization is deterministic, so raw-text URLs
  map stably to one audio stream.

## Considered Options

- **Full-kana for every token, no corrections table** — rejected in the
  spike: SudachiPy misreads common date/number compounds, and full-kana would
  actively corrupt words Edge TTS already reads correctly (the original
  problem inverted). The corrections table is the minimal guard.
- **Selective replacement (keep kanji for "safe" tokens)** — deferred: the
  spike found no reliable automatic signal for "risky" (the analyzer emits one
  reading, not an ambiguity score). Full-kana + corrections is predictable and
  covers the learner's real pain; prosody quality is verified by listening
  (see below).
- **DeepSeek/BYOK as the primary normalizer** — rejected for the primary path
  (latency per sentence breaks tap-to-hear, family text leaves the box,
  offline replay of new text impossible). A future BYOK fallback may run only
  for analyzer failures or explicit learner corrections.
- **Azure Speech (real SSML `<phoneme>`/lexicon)** — rejected: paid, needs an
  account, contradicts the free family-server positioning.

## Consequences

- `server/reading.py` + `server/tests/test_reading.py`; `tts_server.py` gains
  an injectable `normalizer` (tests pass a fake; production uses
  `reading.normalize_ja`).
- The server cache key format changes (versioned, normalized) — the old
  cache files become orphans, which is harmless (speed layer only).
- Runtime dependency note: sudachipy + sudachidict_core (Rust wheel, no
  compiler needed) must be installed on claw; the server still runs without
  them, but Japanese is then synthesized unnormalized. Deployment decides how
  to install it (issue #5).
- Analyzer coverage: proper nouns and 当て字 remain imperfect (Sudachi has no
  reading for a family member's name). Those are exactly the cases a future
  BYOK/manual-override layer should carry.
- Listening check: raw vs normalized audio for the spike sentence set is
  generated and compared by ear before shipping.
