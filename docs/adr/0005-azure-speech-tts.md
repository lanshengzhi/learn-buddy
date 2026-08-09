# Azure Speech TTS: phoneme-controlled readings with an Edge TTS fallback

ADR 0004 locked a **kanji-default** reading normalizer because Edge TTS cannot
take SSML reading hints: the only lever before synthesis was text rewriting,
and kana text (katakana *or* hiragana) was rejected by ear — katakana pushes
ja voices into the loanword head-high accent, hiragana loses the lexical
pitch accent kanji carries. That left a hard trade: keep kanji and accept
occasional misreads (定める read ていめる instead of さだめる), or kana-ize and
lose the accent. This ADR replaces the trade with a provider that can take
both at once.

## Context

The pain behind ADR 0004 was dual: **读音** (which reading a kanji gets) and
**声调** (the pitch accent contour). Edge TTS gives us either the reading *or*
the accent, never both — its G2P reads kanji with dictionary accents but
misreads some words, and kana text fixes readings while discarding accents.

Azure Speech (official REST API) accepts real SSML, including
`<phoneme alphabet="sapi" ph="...">`, whose `ph` value carries **both** the
reading (katakana) and the accent position (the `'` marker, サダメ'ル = さだめる
with ③型 accent on め). It ships the same neural voices LearnBuddy already
uses (ja-JP-KeitaNeural, en-US-AriaNeural, zh-CN-YunxiNeural), so the
frontend's voice/rate/lang contract is untouched. ADR 0004 rejected Azure as
"paid, needs an account"; the free tier F0 with a family-owned key (BYOK)
changes that calculus, and Edge stays as a zero-cost automatic fallback.

## Decisions

- **Azure Speech is the primary provider when `AZURE_SPEECH_KEY` is set**; the
  server selects it in `tts_server.py`, and **Edge TTS remains the automatic
  fallback** — when there is no key, or on any Azure failure. The fallback is
  invisible to the frontend: errors keep the shared error-code vocabulary and
  status mapping.
- **Phoneme dual control.** `JA_REPLACE_READINGS` entries become
  `{surface: (kana_reading, sapi_phoneme)}` — e.g. `定める: ("さだめる",
  "サダメ'ル")`. The Azure path embeds a
  `<phoneme alphabet="sapi" ph="サダメ'ル">定める</phoneme>` in the SSML body
  (reading + accent); the Edge fallback path rewrites the surface to its kana
  reading (さだめる) exactly as ADR 0004 did. The normalizer stays
  **kanji-default**: only listed, ear-confirmed surfaces are touched.
- **`server/reading.py` produces an SSML-embeddable body** (`normalize_ja`,
  `normalize`) rather than plain text, escaping `& < > " '` in the plain-text
  portions; `normalize_ja_text` keeps the plain-text form for the Edge
  fallback. `NORM_VERSION` is bumped so stale audio leaves the cache.
- **Azure needs no pacing.** The ~3s `PaceGate` (Edge throttling research)
  applies to the Edge fallback only; the cache key shape is unchanged
  (`SHA-256("{NORM_VERSION}|{normalized}|{voice}|{rate}")`).
- **Free tier F0, BYOK.** The key comes from `AZURE_SPEECH_KEY` (region from
  `AZURE_SPEECH_REGION`, default `japaneast`). With no key, the server simply
  runs on Edge. No Azure key is required to develop or test — provider logic
  is exercised with fakes.
- **Phase 1 only.** No learner-correction UI, no DeepSeek fallback; the
  runtime-mutable replacement table from ADR 0004 is preserved for a future
  override layer.

## Considered Options

- **Stay Edge-only with the ADR 0004 kana trade** — rejected: the whole pain
  was that reading and accent could not be fixed together; the curated list
  would keep trading accent for reading on every entry.
- **Azure Speech SDK** (`azure-cognitiveservices-speech`) — rejected: the
  backend is stdlib-only (ADR 0001); the REST endpoint is a POST with SSML and
  needs no SDK.
- **Other commercial TTS (Google Cloud, ElevenLabs, OpenAI)** — rejected:
  Azure was chosen because it reuses the exact neural voices the family
  already listened to, with a free tier and a simple REST API.

## Consequences

- `server/azure_tts.py` (new): stdlib REST client — envelope, headers, output
  format, and failure mapping onto the shared error codes
  (`upstream_unavailable`, `upstream_timeout`, `network_failure`, `unknown`).
- `server/reading.py`: two output forms (SSML body + Edge text); `NORM_VERSION`
  bumped; `JA_REPLACE_READINGS` values are now tuples.
- `server/tts_server.py`: provider selection (`AZURE_SPEECH_KEY`), Azure-first
  with Edge fallback, pacing on Edge only. The `lang`/`voice`/`rate` contract
  and `default_voice_for` are unchanged; the frontend is untouched.
- Audio cache entries from ADR 0004 become orphans (speed layer only — harmless).
- The original 定める misread is fixed on Azure *with* the correct accent — the
  outcome kana text could never deliver.
