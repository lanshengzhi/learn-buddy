# ADR 0008: Lookup dictionaries and the AI explanation layer

Date: 2026-09-20
Status: Accepted (the zh part amended by [ADR 0009](0009-chinese-lookup-and-segmentation.md))
Tickets: [#11](https://github.com/lanshengzhi/learn-buddy/issues/11) (research),
[#12](https://github.com/lanshengzhi/learn-buddy/issues/12) (UI prototype),
[#15](https://github.com/lanshengzhi/learn-buddy/issues/15) (AI decision),
[#19](https://github.com/lanshengzhi/learn-buddy/issues/19) (implementation)

## Context

点字查义 (Lookup) is one of the two core reading interactions. The research
ticket #11 measured the dictionary data plane on claw (Celeron J1900, Python
3.14): plain-index SQLite lookups at p50 10–80 µs, a Japanese surface→
normalized→dictionary-form→reading chain at 93.4% end-to-end hit rate (vs
83.7% raw surface), and no need for jieba (Chinese is out of this map's MVP).
The AI layer decision (#15) keeps the provider question inside a small Node
service wrapping the pi SDK, with the Python backend proxying and caching.

## Decision

### Dictionary runtime

- **Data**: build-time SQLite files under `<data-dir>/dicts/` — `en.sqlite`
  (ECDICT), `ja.sqlite` (JMdict) + `kanji.sqlite` (KANJIDIC2); runtime uses
  stdlib `sqlite3` only, read-only, connections shared across the HTTP
  server's threads with serialized queries. `zh.sqlite` stays reserved for the
  future Chinese effort. Built by `server/tools/build_dicts.py` (downloads
  ECDICT / JMdict_e / KANJIDIC2, atomic tmp+rename), synced by
  `scripts/deploy.sh` when built locally.
- **Endpoints**:
  - `GET /lookup?lang=&word=` → `{lang, word, key, matched, reading, senses[]}`
    with `key` being the **Word key** (`ja:食べる`); entries also expose
    `glossLanguage` and `glossSource` so an English gloss is never presented as
    a Chinese explanation. ECDICT uses its Chinese `translation` when present,
    falling back to the English `definition`; misses → `404 entry_not_found`;
    no dictionary file for the language → `503 lookup_unavailable`.
  - `POST /lookup/check` `{lang, words[]}` → `{words: {surface: key|null}}` —
    the 标生词 lazy batch for visible sentences (cap 180 words; `too_large`
    beyond). Never baked at upload time (§16: 44k tokens × 80µs ≈ 3.5s/chapter).
  - Japanese resolves via the researched chain (surface → Sudachi
    normalized → dictionary form → reading) with a single-kanji KANJIDIC2
    fallback; English by lowercase match + mechanical lemma strips (ECDICT's
    exchange lemmas cannot be walked backwards).

### Frontend gestures and card (from #12)

- 点句子 = 朗读, unchanged. 查义 by gesture: fine pointer hover with a 320 ms
  dwell; touch long-press 420 ms (vibrate, the word "held"); text selection
  wins when a non-empty selection sits inside one sentence.
- The lookup card has two tabs: 词条 (reading, matched form, numbered senses,
  context sentence, ▶这个词 / 标记认识 / 关闭) and AI (问 AI, retryable in-tab).
  Word spans that are present in the dictionary and not marked 我认识 get the
  生词提示 underline per the Profile's `hl_mode` (标生词 / 淡已认识 / 关).

### AI explanation layer (from #15)

- The frontend calls `POST /ai {word, sentence, language, explanationLocale}` —
  **never** the AI service directly. `explanationLocale` defaults to `zh-CN`
  (the generic contract can support another learner locale). The Python backend
  owns the cache (SHA-256 of `word|sentence|language|explanationLocale`,
  `<data-dir>/ai-cache/`, shared across
  Profiles — an explanation is a language fact) and the degrade codes:
  `ai_not_configured` (no `LEARNBUDDY_AI_URL`), `ai_upstream_error`,
  `ai_timeout` (20 s, retryable in the tab). A failure never blocks the
  dictionary card.
- The provider behind the proxy is the separate `learnbuddy-ai` Node service
  (pi SDK, `{word, sentence, language, explanationLocale}` → `{text}`); pi's configured model is
  whatever pi uses. Its implementation and deployment on claw are their own
  follow-up ticket — until it exists the tab shows the `ai_not_configured`
  state with the entry point visible (as #15 specified).

## Consequences

- Runtime adds no Python dependency for lookup itself (Sudachi already exists
  for parsing); dictionaries are ~132 MB (en+ja+kanji) on disk and mmap-warm.
- Card states: loading → ready / missing / unavailable — all learner-visible,
  never silent.
- `lookup_unavailable`, `ai_not_configured`, `ai_upstream_error`, `ai_timeout`
  join the API error vocabulary (CONTEXT.md).
