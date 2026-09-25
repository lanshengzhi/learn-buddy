# GBrain primary-source review for LearnBuddy

**Review date:** 2026-09-25
**Upstream repository:** <https://github.com/garrytan/gbrain>
**Exact inspected commit:** [`467ff6737f741375a9a78eafd2818634d908eb99`](https://github.com/garrytan/gbrain/commit/467ff6737f741375a9a78eafd2818634d908eb99)
**Upstream version:** `0.57.0.0` ([`VERSION`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/VERSION), [`package.json`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/package.json#L178-L183))
**Tags inspected:** both `v0.57.0.0` and `latest-stable` resolve to that exact commit.
**Clone used:** `/tmp/learnbuddy-gbrain-research-1790317107-514592` (clean `master`, tracking `origin/master`)
**Commit timestamp:** `2026-09-24T19:13:16-04:00`; subject: `v0.57.0.0 fix: bound accepted-write waits and report safe receipt health (#5411)`.

All upstream links in this report are pinned to that commit rather than `master`.

## Executive conclusion

GBrain is a sophisticated, rapidly evolving **memory and retrieval daemon for coding/operator agents**, not an ebook reader, a language-learning product, or a general household chat application. Its own one-line positioning is “Give the agent you already use a memory you control,” and it distinguishes raw retrieval (`search`/`query`) from optional answer synthesis (`think`) and cross-agent memory operations over MCP ([`README.md` lines 1–3, 254–284](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L1-L3), [lines 254–284](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L254-L284)). It should not replace LearnBuddy’s product model or become its default backend.

The genuinely useful lesson is its **context discipline**: explicit retrieval stages, evidence and degradation metadata, a bounded context envelope, source/visibility scoping, honest gaps, and a clear separation between raw search and generative synthesis. A second useful lesson is its source-oriented ingestion contract and durable-write/receipt vocabulary. Those ideas can be implemented in LearnBuddy’s own Python host with much smaller Book-aware types.

The most book-adjacent feature is `book-mirror`: an EPUB/PDF skill extracts chapters externally, runs one read-only model subagent per chapter, and writes one personalized report page ([`skills/book-mirror/SKILL.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/skills/book-mirror/SKILL.md), [`src/commands/book-mirror.ts`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/commands/book-mirror.ts)). It is useful evidence for a future whole-book report workflow, but it is **not** an immersive reader, current-book chat, word lookup, mind-map generator, or NotebookLM client. Its extractor even sorts EPUB XHTML filenames and treats each file as a chapter, so it is unsuitable as a replacement for LearnBuddy’s EPUB spine/TOC parser ([`skills/book-mirror/SKILL.md` lines 98–129](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/skills/book-mirror/SKILL.md#L98-L129)).

**Recommendation:** do not fork, vendor, or install GBrain as LearnBuddy infrastructure. Borrow a small set of source-grounded context and provenance patterns; implement a small Book-scoped retrieval/context adapter inside LearnBuddy; keep current-book conversation and whole-book NotebookLM artifacts on separate, explicit paths.

## 1. Scope and method

This was a static primary-source review. I inspected:

- the complete root README, product/design and architecture documentation, selected deep source modules, representative test suites and CI configuration, package/build metadata, configuration/deployment/security documentation, the license, changelog, tags, and recent history;
- the source paths behind ingestion, import/indexing, search, synthesis, citation handling, context injection, storage, engines, extension contracts, and `book-mirror`;
- a 40-commit recent history window and release-to-release diff metadata.

No provider account, paid model, hosted MCP server, admin deployment, or external benchmark corpus was used. Therefore this report does not attest production availability, provider prices, the README’s personal production totals, or benchmark results outside the exact fixtures documented by the project.

The inspected clone had 1,085 reachable commits on `master`. The project began on 2026-04-05 and had releases through `v0.57.0.0` on 2026-09-24, indicating very high release velocity and substantial simultaneous change, not a stable, slow-moving library API. Recent releases focus heavily on persistence liveness, search reliability, hosted-access security, ingestion parsing, and shared skills ([`CHANGELOG.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/CHANGELOG.md)).

## 2. Product intent and actual product boundary

### What GBrain is trying to be

1. **A portable, user-controlled memory layer.** The primary promise is explicit facts with sources, correction/withdrawal, and availability across existing agents. The intended user supplies memory to Claude Code, Codex, OpenClaw, Grok, Muse, or another MCP-capable harness rather than switching to a new personal agent identity ([`README.md` lines 1–18](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L1-L18), [`README.md` lines 97–252](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L97-L252)).
2. **An always-on knowledge daemon.** Meetings, mail, calendars, social posts, transcripts, voice, and code can be ingested continuously; background “dream” cycles enrich pages, detect contradictions, update citations, and consolidate memory ([`README.md` lines 19–35, 333–384](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L19-L35), [lines 333–384](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L333-L384)).
3. **An operator/platform product.** The primary UX is CLI, MCP tools/verbs, cron/autopilot, and an admin dashboard. The admin design document explicitly calls the dashboard an operator tool and the terminal the user’s normal surface ([`DESIGN.md` lines 1–14, 84–103](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/DESIGN.md#L1-L14), [lines 84–103](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/DESIGN.md#L84-L103)).
4. **A multi-scale knowledge engine.** It supports schema packs, typed links, facts/takes, full-text and vector retrieval, reranking, synthesis, optional model providers, and two storage engines ([`README.md` lines 386–447](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L386-L447)).

### What it is not

There is no first-class LearnBuddy-style `Book`, chapter, sentence, reading position, dictionary lookup, TTS, or immersive reader state. The closest feature is an agent skill that asks an agent with shell/Python access to unzip an EPUB, strip HTML, and sort filenames into chapter text files ([`skills/book-mirror/SKILL.md` lines 65–129](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/skills/book-mirror/SKILL.md#L65-L129)). The CLI then consumes those pre-extracted `.txt` files; it does not parse EPUB container/OPF/spine/navigation itself ([`src/commands/book-mirror.ts` lines 1–40, 121–145](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/commands/book-mirror.ts#L1-L40), [lines 121–145](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/commands/book-mirror.ts#L121-L145)).

It also has no end-user “chat with this book” domain surface. Chat history is owned by the connected agent/harness; GBrain contributes memory tools, ambient injected context, or an explicit `think` synthesis operation. A source can be scoped to a repository, but a source is not a Book with chapter/position semantics ([`docs/architecture/brains-and-sources.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/brains-and-sources.md), [`docs/protocol/MEMORY_VERBS_v1.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/protocol/MEMORY_VERBS_v1.md)).

## 3. Architecture and ingestion/indexing

### High-level data flow

The documented core loop is:

```text
signal → search → answer → write → auto-link → recurring sync/enrichment
```

Markdown repositories are synchronized and parsed into a PGLite or Postgres+pgvector engine; CLI/MCP operations sit above a shared contract-first operation layer; retrieval can feed synthesis and a cited answer ([`README.md` lines 386–447](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L386-L447)). The two shipped engines implement the large `BrainEngine` contract; PGLite is embedded Postgres/WASM for a single local machine, while Postgres/pgvector is the shared/scale path ([`docs/ENGINES.md` lines 1–33, 205–228](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ENGINES.md#L1-L33), [lines 205–228](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ENGINES.md#L205-L228)).

### Pluggable ingestion boundary

The versioned `IngestionSource` contract is the clearest reusable design. A source emits a validated `IngestionEvent` containing source ID/kind, original URI, receipt time, content type, content, SHA-256, optional upsert/tombstone semantics, optional untrusted-payload marker, and free-form metadata. Sources are deliberately “dumb emitters”; the daemon owns validation, supervision, deduplication, rate limiting, and dispatch ([`src/core/ingestion/types.ts` lines 1–28, 55–130](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/types.ts#L1-L28), [lines 55–130](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/types.ts#L55-L130)). The public barrel calls this a versioned publisher API ([`src/core/ingestion/index.ts`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/index.ts)), and a deterministic source-author test harness is exported to publishers ([`src/core/ingestion/test-harness.ts`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/test-harness.ts)).

The production daemon validates events, deduplicates trickle events in a 24-hour content-hash window, applies a default 100-events/10-second per-source rate limit, and dispatches accepted work to the Minion queue. Migration-mode importers bypass that short dedup window and must supply their own permanent idempotency ([`src/core/ingestion/daemon.ts` lines 1–42, 405–489](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/daemon.ts#L1-L42), [lines 405–489](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/daemon.ts#L405-L489)).

This boundary is useful, but LearnBuddy already has a better product-specific parser and data owner. A Book importer should emit parsed `Book`/chapter/sentence/word/reading records, not a generic Markdown page. A generic page event would discard exactly the structure the reader needs.

### Markdown/import pipeline

The central import path parses Markdown/frontmatter, runs trust/privacy and content-sanity checks, computes a content hash, short-circuits unchanged content, prepares chunks, and transactionally writes page/version/tags/chunks. Embeddings are a separate post-commit effect and can complete later without changing the canonical write result ([`src/core/import-file.ts` lines 195–319, 541–665, 829–959](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/import-file.ts#L195-L319), [lines 541–665](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/import-file.ts#L541-L665), [lines 829–959](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/import-file.ts#L829-L959)). Individual content is capped at 5 MB ([`src/core/import-file.ts` line 158](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/import-file.ts#L158)).

The source URI/kind/ingestion lane can be written through to page columns, but this is metadata about how the page entered the brain—not a complete chain from each claim to an original external document, page, paragraph, or immutable version ([`src/core/import-file.ts` lines 268–285](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/import-file.ts#L268-L285)).

### Media/PDF/EPUB caveat

The ingestion taxonomy names PDF, images, audio, and video, and the inbox source can emit those types, but parts of the daemon source still describe processor-router wiring as later work ([`src/core/ingestion/types.ts` lines 42–63](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/types.ts#L42-L63), [`src/core/ingestion/daemon.ts` lines 23–27](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/daemon.ts#L23-L27)). The media guide is substantially workflow prose and pseudocode, not proof of a universal built-in parser. The only concrete EPUB path found is the book-mirror skill’s manual unzip + BeautifulSoup extraction, not the product import path.

## 4. Retrieval, context preparation, and AI boundaries

### Raw retrieval is deliberately separate from synthesis

The project defines three lookup boundaries:

- direct `get` when the exact page is known;
- cheap-hybrid `search` for names/keywords, without LLM query expansion;
- full `query` for natural-language/concept/landscape questions, which can use LLM query expansion;
- expensive `think`/`synthesize` to generate an answer across gathered evidence ([`docs/guides/search-modes.md` lines 1–42, 208–281](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/search-modes.md#L1-L42), [lines 208–281](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/search-modes.md#L208-L281)). The memory protocol likewise labels `synthesize` as slow, model-calling, and costly, while `recall`, `entity`, `context_pack`, and `delta` have cheaper/zero-LLM semantics ([`docs/protocol/MEMORY_VERBS_v1.md` lines 81–105, 194–246, 308–352](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/protocol/MEMORY_VERBS_v1.md#L81-L105), [lines 194–246](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/protocol/MEMORY_VERBS_v1.md#L194-L246), [lines 308–352](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/protocol/MEMORY_VERBS_v1.md#L308-L352)).

This is the most important positive design lesson for LearnBuddy: do not make every current-book turn invoke a general RAG/synthesis stack. Word lookup and “explain this sentence” should use exact local structures; only ambiguous, book-scoped questions need retrieval.

### Retrieval pipeline

The documented full query path combines:

1. deterministic intent classification;
2. optional query expansion;
3. vector and keyword recall plus title/alias/relational arms;
4. reciprocal-rank fusion and source/evidence-aware reranking;
5. optional graph augmentation, deduplication, cross-encoder reranking, relational re-pin, exact lookup;
6. evidence/confidence stamps, adaptive return/autocut, limit, and final token budget.

The order and fail-open/fail-closed exceptions are documented in detail ([`docs/architecture/RETRIEVAL.md` lines 173–254](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/RETRIEVAL.md#L173-L254)). Results carry evidence labels such as exact title, alias, high vector match, exact keyword, or weak semantic, and unverified auto-extracted content is quarantined from privileged boosts ([`docs/architecture/RETRIEVAL.md` lines 83–123](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/RETRIEVAL.md#L83-L123)). This is more honest than returning a list of opaque similarity scores.

The shared token-budget enforcer walks final ranked results in order and stops before exceeding the requested budget. Its estimator is deliberately `ceil(chars/4)`, not a language-aware tokenizer; the project documents materially worse error for mixed Unicode and notes CJK token density can be up to roughly eight characters per token ([`src/core/search/token-budget.ts` lines 1–38, 73–132](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/search/token-budget.ts#L1-L38), [lines 73–132](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/search/token-budget.ts#L73-L132)). LearnBuddy should not copy that estimator for Japanese context budgeting without measuring it.

### Context assembly for synthesis

`think` gathers page hybrid hits, keyword/vector take hits, optional anchored graph traversal, and a forced anchor-page hydration. It propagates source, private-page, take-holder, and safe-chunk policies into every arm and sanitizes the question before LLM-bound expansion ([`src/core/think/gather.ts` lines 1–68, 118–248](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/gather.ts#L1-L68), [lines 118–248](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/gather.ts#L118-L248)). Rendered page evidence is capped to a 12,000-character block with explicit beginning/end truncation markers, and each page is framed as a `<page>` element ([`src/core/think/gather.ts` lines 580–637](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/gather.ts#L580-L637)).

The model is instructed to cite every substantive claim, surface low-weight/conflicting evidence, put unknowns in a structured `gaps` array, and return structured JSON ([`src/core/think/prompt.ts` lines 1–72](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/prompt.ts#L1-L72)). The user message places the question and retrieved `<pages>`, `<takes>`, and optional `<graph>` into one explicit prompt ([`src/core/think/prompt.ts` lines 160–226](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/prompt.ts#L160-L226)).

There is also an ambient/hook context assembler. It builds a subordinate “data, not instructions” envelope from entity pointers, volunteered pages, and hot facts, defaults to an 8 KiB byte cap, trims low-confidence facts first, and forces world-only visibility on the hook path ([`src/core/context/turn-context.ts` lines 1–64, 120–208, 250–375](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/context/turn-context.ts#L1-L64), [lines 120–208](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/context/turn-context.ts#L120-L208), [lines 250–375](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/context/turn-context.ts#L250-L375)).

For LearnBuddy, the analogous contract should be even narrower: `CurrentBookContext(book_id, chapter, selected_sentence, reading_position, excerpt_budget)` with a mandatory `book_id` check on every chunk and no default fallback to a different Book.

## 5. Citation and provenance behavior

GBrain has several provenance layers, but they should not be conflated:

1. **Ingestion provenance:** source ID/kind, source URI, receipt time, content hash, and sometimes metadata ([`src/core/ingestion/types.ts` lines 72–130](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/types.ts#L72-L130)).
2. **Page-level source attribution convention:** inline `[Source: …]` strings, mandatory URLs for social posts, and explicit contradictions rather than silent resolution ([`docs/guides/source-attribution.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/source-attribution.md)).
3. **Fact provenance:** `remember` requires non-empty free-text provenance, while returned facts carry it ([`docs/protocol/MEMORY_VERBS_v1.md` lines 113–158](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/protocol/MEMORY_VERBS_v1.md#L113-L158)).
4. **Synthesis citations:** `[page-slug]` or `[page-slug#take-row]`, normalized from model output and persisted for take citations when a synthesis page is saved ([`src/core/think/cite-render.ts`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/cite-render.ts), [`src/core/think/index.ts` lines 438–471](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/index.ts#L438-L471)).

Positive details:

- structured citations are preferred; inline markers are a recovery fallback;
- mismatches between structured and inline lists are warned;
- citations outside all gathered page/take/graph evidence produce `CITATION_NOT_IN_GATHER` ([`src/core/think/index.ts` lines 866–881](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/index.ts#L866-L881));
- synthesis failure after a non-empty gather falls back to excerpts drawn only from gathered pages ([`src/core/think/index.ts` lines 384–424](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/index.ts#L384-L424)).

Limitations:

- the “not in gather” check is warn-only, so an answer can still be returned with a citation that is not in the evidence set;
- page citations are resolved only as slugs/rows; they do not provide a universal deep link into the original EPUB sentence, PDF page, transcript timestamp, or original source URI;
- source attribution is partly an agent-writing convention rather than a mandatory typed evidence chain enforced for every claim;
- `forget` withdraws a fact from active recall but does not promise physical erasure from source material, history, or backups ([`docs/guides/memory-boundaries.md` lines 8–17](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/memory-boundaries.md#L8-L17)).

For LearnBuddy, a valid current-book citation should be a structured, server-validated tuple such as `{book_id, chapter_index, sentence_index, paragraph_start, paragraph_end, book_content_hash}`. The UI can then resolve it against the locally parsed Book and jump to the exact sentence. A model-generated string or page slug is not adequate for a language reader.

## 6. Chat, search, and retrieval boundaries

GBrain has no product-level Chat history owner. The connected harness owns the conversation, while GBrain exposes operations and may inject context. The memory protocol is intentionally a tool contract, not a chat transcript schema ([`docs/protocol/MEMORY_VERBS_v1.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/protocol/MEMORY_VERBS_v1.md)).

This differs materially from LearnBuddy’s current and intended model:

- LearnBuddy’s Python host owns Book, Person-organized product data, and Conversation history; the Node sidecar only performs model calls and streaming.
- A current-book conversation needs explicit Book context supplied by the host, not globally injected memory from every source.
- Ordinary Chat and Read may remain independent unless a user deliberately opens a current-book conversation.
- Word lookup is an exact local operation against a selected token and language dictionary, not a vector search or general LLM answer.
- A question about the current Book may retrieve only that Book unless the user explicitly chooses “search all books/my notes.”

GBrain’s source scoping can suggest the mechanics, but its “source” is a repository boundary and source grants do not automatically isolate local agents sharing credentials ([`docs/guides/memory-boundaries.md` lines 58–68](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/memory-boundaries.md#L58-L68)). LearnBuddy needs Book identity in every read and citation, not merely an ambient folder convention.

## 7. Storage, state, and local/remote/provider boundaries

### Storage and system of record

GBrain distinguishes:

- file-canonical Markdown/frontmatter for file-backed knowledge;
- derived database indexes that can be rebuilt;
- DB-only knowledge, withdrawals, receipts, credentials, jobs, settings, versions, and operational state that require a full database backup.

Markdown export is explicitly **not** a full backup ([`docs/architecture/system-of-record.md` lines 1–38, 79–107](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/system-of-record.md#L1-L38), [lines 79–107](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/system-of-record.md#L79-L107), [`docs/guides/memory-boundaries.md` lines 69–76](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/memory-boundaries.md#L69-L76)). PGLite is a single-process/single-writer embedded database; Postgres adds pooling and multi-machine scale but introduces backup, migration, ownership, and database-security obligations ([`docs/ENGINES.md` lines 205–228](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ENGINES.md#L205-L228)).

For LearnBuddy, this complexity is disproportionate. The existing raw EPUB, manifest, chapter JSON, and Person position files are already inspectable and backup-friendly. A Book index should be a rebuildable cache, while original EPUB bytes, parse version, conversation messages, provider-job state, and remote artifact mappings remain explicitly authoritative.

### Local does not mean local model

The keyless path can use local PGLite, keyword retrieval, and deterministic link extraction. However, configured embedding/reranking/expansion providers receive text/query/candidates, synthesis/extraction send source or retrieved content to models, and the connected harness model receives injected context. The project itself warns that local storage does not imply local inference ([`docs/guides/memory-boundaries.md` lines 45–56](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/memory-boundaries.md#L45-L56)).

GBrain supports many hosted embedding/chat providers and local OpenAI-compatible/llama.cpp paths. It also supports a local Claude CLI subscription path, but that is still a remote model service from the household host’s perspective and inherits the CLI’s auth/config behavior ([`docs/ai-providers/claude-cli.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ai-providers/claude-cli.md), [`docs/ai-providers/llama-server-reranker.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ai-providers/llama-server-reranker.md)). LearnBuddy should keep its existing sidecar/provider boundary and add privacy labels/consent at the feature that sends Book text, not attempt to reproduce GBrain’s gateway.

### Deployment and sharing

Local MCP is stdio; remote MCP is HTTP with OAuth/scopes/rate limits, and Tailscale is the recommended private publication path. DCR is disabled by default and loopback binding is the default ([`README.md` lines 206–252](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L206-L252), [`SECURITY.md` lines 223–289, 409–487](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/SECURITY.md#L223-L289), [lines 409–487](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/SECURITY.md#L409-L487)). These are good defaults, but none are needed for LearnBuddy’s current single-household Web/PWA deployment.

## 8. Extension points

Genuine extension seams include:

- **operations:** one contract-first operation definition generates CLI, MCP, and tools metadata ([`CONTRIBUTING.md` lines 259–283](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/CONTRIBUTING.md#L259-L283));
- **ingestion:** versioned `IngestionSource` plus publisher test harness ([`src/core/ingestion/types.ts`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/types.ts), [`src/core/ingestion/test-harness.ts`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/test-harness.ts));
- **storage engine:** `BrainEngine` with parity tests, though every backend must implement the full large interface ([`docs/ENGINES.md` lines 5–33, 465–499](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ENGINES.md#L5-L33), [lines 465–499](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/ENGINES.md#L465-L499));
- **AI recipes/providers:** provider-specific adapters behind a gateway seam;
- **skills/plugins:** Markdown skills and packaged ingestion sources.

The ingestion plugin loader is a notable security constraint: v1 sources execute in-process, install trust is trust-on-first-use, and manifest `permissions` are informational only; subprocess/VM isolation is deferred ([`src/core/ingestion/skillpack-load.ts` lines 1–39](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/ingestion/skillpack-load.ts#L1-L39)). LearnBuddy should not install arbitrary code in its main reader process. If external study providers are added later, they should be narrow, user-consented adapters in a separate worker.

## 9. Operational and security risks

### Risks that matter to LearnBuddy

1. **Scope and complexity.** The release contains 1,434 TypeScript source files (about 441k physical lines) and 2,540 TypeScript test/spec files (about 586k physical lines) in this checkout. Several core modules are very large (`src/core/migrate.ts`, both engines, `hybrid.ts`, `gateway.ts`). This is a platform, not a lightweight library. Adopting it would dwarf LearnBuddy’s Python/vanilla-TS product and make upgrades/security review costly.
2. **Recent churn.** The inspected release was one day old and the preceding weeks contain many persistence/search/security “fix waves.” Pinning a commit is mandatory; treating `latest-stable` as a stable, slow-moving dependency would be unsafe.
3. **Prompt injection remains partial.** Take text is structurally wrapped, pattern-sanitized, and capped, but the source itself says the pattern defense is not bulletproof ([`src/core/think/sanitize.ts` lines 1–17, 74–106](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/sanitize.ts#L1-L17), [lines 74–106](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/sanitize.ts#L74-L106)). Retrieved page excerpts are framed as `<page>` but their arbitrary text is not passed through the same take sanitizer ([`src/core/think/gather.ts` lines 605–637](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/core/think/gather.ts#L605-L637)). LearnBuddy must treat EPUB text as untrusted data and keep the model’s tools read-only.
4. **Cloud egress and spend.** Semantic retrieval, reranking, expansion, extraction, synthesis, ambient memory, and full-book mirror can all incur provider calls/cost. LearnBuddy’s optional NotebookLM path should be explicit per Book and isolated from ordinary lookup/chat.
5. **Plugin code execution.** Display-only permissions and in-process module loading are unacceptable defaults for a family reader. The book-mirror read-only subagent/tool allowlist is a much better boundary: untrusted chapter workers can read but cannot write; the trusted host alone publishes the report ([`src/commands/book-mirror.ts` lines 18–40](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/src/commands/book-mirror.ts#L18-L40)).
6. **Citing consistency is warn-only.** A citation outside gathered evidence is flagged but synthesis remains “never fail.” A learning product should fail closed or replace the answer with extractive excerpts when claim-to-Book-span validation fails.
7. **Data export/deletion semantics are easy to misstate.** Withdrawal is logical, not guaranteed physical erasure; DB-only state needs a separate sensitive backup; Git/canonical files and database can temporarily differ ([`docs/architecture/system-of-record.md` lines 169–197](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/system-of-record.md#L169-L197)).
8. **Remote access has multiple trust boundaries.** OAuth/source/visibility controls apply at the MCP server; local files, shared database credentials, or raw Postgres access bypass them. The project explicitly warns that a container on the same Docker network can read every source without an MCP token ([`SECURITY.md` lines 419–439](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/SECURITY.md#L419-L439)). LearnBuddy should avoid exposing its Book database as a general network service.
9. **Japanese/CJK retrieval is not a first-class lexical index.** Built-in Postgres FTS configurations do not tokenize CJK; GBrain detects CJK and falls back to scanning chunk text with `ILIKE`, which grows with corpus size and is query-driven ([`docs/guides/multi-language-fts.md` lines 1–87](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/guides/multi-language-fts.md#L1-L87)). This does not meet LearnBuddy’s need for responsive Japanese word/sentence lookup.
10. **EPUB extraction quality is below LearnBuddy’s needs.** Book-mirror’s filename-sorted XHTML approach mishandles common EPUB structures where one content document contains multiple chapters and the navigation/spine, not filename order, defines reading order ([`skills/book-mirror/SKILL.md` lines 98–129](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/skills/book-mirror/SKILL.md#L98-L129)).
11. **Benchmark claims are scoped.** The documented BrainBench corpus is 240 Opus-generated pages, and the project repeatedly warns the numbers do not establish universal superiority or predict another corpus ([`docs/architecture/RETRIEVAL.md` lines 22–35](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/architecture/RETRIEVAL.md#L22-L35)). They do not validate reading comprehension, Japanese lookup, EPUB location accuracy, or household UX.

### Security strengths worth acknowledging

GBrain has a serious security culture for its scale: private secret scanning, OSV dependency scanning, Semgrep, actionlint, release attestations, fail-closed self-update verification, cwd `.env` quarantine, DCR/OAuth consent, default-deny CORS, loopback binding, rate limits, source/visibility fences, and extensive privacy tests ([`SECURITY.md` lines 1–61, 63–221, 223–352](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/SECURITY.md#L1-L61), [lines 63–221](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/SECURITY.md#L63-L221), [lines 223–352](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/SECURITY.md#L223-L352)). These are reasons to respect the project, not reasons to absorb its architecture into LearnBuddy.

## 10. Test quality and maturity

### Strong signals

The test documentation is unusually detailed. It separates unit, serial, slow, real-Postgres E2E, browser, persistence/crash, native-platform, and performance lanes; runs required CI on real PGLite and Postgres; requires “discrimination tests” that fail when a fix is reverted; and uses guard self-tests to prove scanners can fail ([`docs/TESTING.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/TESTING.md), [`CONTRIBUTING.md` lines 100–200](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/CONTRIBUTING.md#L100-L200)). The workflow has 10 unit shards, separate serial/slow/PGLite/Postgres/browser/security jobs, and dedicated BrainBench, LongMemEval, performance, and protocol conformance gates ([`.github/workflows/test.yml`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/.github/workflows/test.yml)).

There are meaningful tests for citation fallback/closure, private visibility, source scoping, remote body stripping, engine parity, ingestion contracts, persistence, and provider seams. The testing docs explicitly distinguish actual cross-process/Postgres evidence from mocks and skips—for example, compatibility tests are skipped—not counted as evidence when an old binary is absent ([`docs/TESTING.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/docs/TESTING.md)).

### Weakness relative to LearnBuddy

The book-adjacent path is not as mature as the core memory platform. `test/book-mirror.test.ts` contains nine mostly dispatch/source-text invariant assertions; its own header says the full subagent fan-out needs a live queue/API key and is covered only by an opt-in smoke lane ([`test/book-mirror.test.ts` lines 1–18, 35–110](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/test/book-mirror.test.ts#L1-L18), [lines 35–110](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/test/book-mirror.test.ts#L35-L110)). The book-mirror skill also says citations are optional and should be used sparingly ([`skills/book-mirror/SKILL.md` lines 288–297](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/skills/book-mirror/SKILL.md#L288-L297)). That is directly incompatible with LearnBuddy’s current-book grounding goal.

I did not install dependencies or run GBrain’s very large test suite for this research report. Test maturity is therefore assessed from the pinned source, CI declarations, and test corpus—not from a fresh green run at this commit.

## 11. Recent history and release posture

The latest release, `v0.57.0.0`, changes accepted-write receipt health: it adds bounded age/blocker diagnostics, bounded scheduler/query waits, safer Postgres cancellation, pool-shutdown rejection, and explicit operator instructions not to treat pending work as success or take over ownership. The release itself stresses that age is advisory and not proof of owner death ([`CHANGELOG.md` lines 13–55](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/CHANGELOG.md#L13-L55), [commit `467ff6737…`](https://github.com/garrytan/gbrain/commit/467ff6737f741375a9a78eafd2818634d908eb99)).

The immediately preceding releases repaired search projection data, writer/backup safety, and removed an unsupported hosted provider; before that were transcript/timeline/email parser repairs, MCP/OAuth simplification, persistence recovery, shared knowledge/skills, and source-identity safety. This is a useful reminder that “latest” functionality is coupled to substantial persistence and migration behavior ([`CHANGELOG.md`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/CHANGELOG.md)).

Conclusion: mature testing and operational discipline, but a fast-moving platform whose integration cost is high. Pinning a commit does not make the interface a small stable dependency.

## 12. Package/build metadata and license

The project is a Bun/TypeScript ESM CLI package. It compiles a standalone binary, requires Bun `>=1.3.11`, exports selected core/ingestion/retrieval subpaths, and declares version `0.57.0.0` ([`package.json` lines 1–49, 178–190](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/package.json#L1-L49), [lines 178–190](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/package.json#L178-L190)). The root README warns that the project is not distributed on npm and that an unrelated package can shadow the binary ([`README.md` lines 84–96](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/README.md#L84-L96)).

The repository license is MIT, copyright 2026 Garry Tan. It permits use, modification, distribution, sublicensing, and sale with preservation of the copyright/license and without warranty ([`LICENSE`](https://github.com/garrytan/gbrain/blob/467ff6737f741375a9a78eafd2818634d908eb99/LICENSE)). This makes selective adaptation legally possible. It does **not** make the dependency graph, model weights, hosted services, or content licenses automatically MIT. LearnBuddy should preserve attribution for any copied substantial code and independently review Bun dependencies before vendoring anything.

## 13. Explicit comparison with LearnBuddy’s goals

| LearnBuddy goal | GBrain fit | Assessment |
|---|---|---|
| Immersive EPUB Read | Poor | No product-level Book/chapter/sentence/position model. The EPUB book-mirror extractor is filename-oriented and external to the CLI. Keep LearnBuddy’s parser and reader. |
| English/Japanese word lookup | Poor | GBrain is retrieval over pages/facts, not dictionary lookup. CJK FTS falls back to a corpus scan, and no inflection/ruby/dictionary contract exists. Reject as implementation. |
| Current-book conversation | Partial pattern only | Source/entity/page scoping and context budgets are useful. No current-Book conversation, chapter selection, exact sentence highlight, or Book-validated citation. Build a small LearnBuddy-owned adapter. |
| Optional NotebookLM whole-book reports/mind maps | No direct fit | GBrain has no NotebookLM integration and no mind-map product flow. `book-mirror` is a local paid-subagent report alternative, not a remote artifact provider. Keep NotebookLM behind an optional `StudyProvider` adapter. |
| Household/local-first reader | Mixed | PGLite is local and keyless retrieval exists, but optional inference is usually remote, ambient capture is agent-centric, and the surrounding platform is much larger than needed. Local storage does not imply local model privacy. |
| Product-owned Book/Person/Conversation data | Poor | GBrain’s brain/source axes and harness-owned conversations would conflict with LearnBuddy ownership boundaries. Do not let GBrain/NotebookLM become system of record. |

LearnBuddy’s checked-in domain contract currently keeps Chat, Read, and Learn independent and defines Read as shelf/chapter/position/read-aloud/word lookup ([`CONTEXT.md`](../../CONTEXT.md)). The current-book conversation goal is therefore a deliberate, explicit Book-to-Conversation bridge, not a license to inject the whole knowledge brain. That bridge should be narrow and inspectable.

## 14. Reuse, pattern-borrowing, and rejection

### A. Genuinely reusable (adapt under MIT, preferably as a small LearnBuddy-native implementation)

1. **Immutable source identity for indexed content.** Carry Book content hash, parser version, source URI/hash, and original offsets alongside derived records. Borrow the separation between canonical content and rebuildable index, not GBrain’s Markdown-page model.
2. **Typed retrieval evidence and degraded state.** Return `matched_by`, scope, content hash, index readiness, truncation, and degraded reasons with every context pack. This is more useful to LearnBuddy than a raw vector score.
3. **Bounded, explicit context blocks.** Use a subordinate “retrieved book context—data, not instructions” envelope, a hard byte/token budget, and explicit omission markers. Use a real tokenizer for Japanese or a conservative measured estimator.
4. **Mandatory gap reporting and extractive fallback.** If synthesis fails, return source excerpts with exact Book locations; never return an unsupported generated answer.
5. **Read-only analysis workers plus trusted publication.** A whole-book report worker may read the selected book and approved local context but must not mutate Book, Person, dictionary, or Conversation data. The host validates output and publishes one artifact. This is the strongest reusable idea from `book-mirror`.
6. **Durable request identity and terminal-state vocabulary.** For asynchronous NotebookLM jobs, model LearnBuddy’s own `queued/running/committed/failed/unknown` receipt, retain the request ID, and never retry unknown remote side effects blindly.

No whole GBrain module is a drop-in dependency for LearnBuddy. “Reusable” here means legally and technically reusable after adaptation, not import-and-run.

### B. Borrow as design pattern only

1. **Search versus synthesis boundary.** Exact local lookup → Book-scoped retrieval → optional answer synthesis.
2. **Source/brain separation.** LearnBuddy’s analogue is Book ID plus optional document-source ID, but the Book must be mandatory for current-book turns.
3. **Fail-open retrieval with honest degradation.** Ranking providers may fail open; privacy and scope must fail closed.
4. **System-of-record classification.** Label each field as canonical, derived, DB-only, provider-only, or disposable, and test rebuild/delete behavior.
5. **Schema/plugin contracts.** A narrow typed interface is useful, but LearnBuddy should use out-of-process providers and explicit capabilities, not in-process arbitrary plugins.
6. **Retrieval evaluation discipline.** Build a small fixed EN/JA Book question set, location-resolution set, citation-closure set, and privacy set before enabling embeddings.
7. **Operational health/doctor concepts.** Borrow explicit readiness and degraded reasons, not the full doctor/queue/autopilot platform.

### C. Reject

1. **GBrain as LearnBuddy’s backend, database, or Book store.**
2. **A general 150K-page personal/company brain for a household language reader.** It adds entity graphs, people/company/deal schemas, ambient cross-conversation memory, cron enrichment, and consolidation that LearnBuddy has not asked to own.
3. **A global source/federated search default for current-book chat.** It would cross Book and domain boundaries.
4. **Slug-only citations for book answers.** LearnBuddy needs validated Book/chapter/sentence spans and jump-to-text behavior.
5. **GBrain’s CJK `ILIKE` fallback as Japanese word lookup.** Keep exact token offsets, local dictionaries, and Japanese morphological data.
6. **The book-mirror EPUB extractor.** It loses reliable reading order and richer EPUB structure.
7. **Book-mirror as a default product feature.** It is expensive, generic-summary-plus-personalization oriented, weakly tested end-to-end, and citation-optional.
8. **In-process third-party ingestion plugins with display-only permissions.**
9. **Automatic ambient capture/writeback for family reading activity.**
10. **Cloud embeddings/rerankers/synthesis as hidden defaults.** Every Book-text egress path needs a visible provider choice and consent.
11. **NotebookLM or any study provider as Book/Person/Conversation authority.** Remote artifacts must be disposable, explicitly uploaded, and locally referenceable.
12. **Adopting GBrain merely because its tests are extensive.** Test count is not product fit, and the platform’s maintenance/upgrade surface is itself an operational dependency.

## 15. Recommended LearnBuddy path

### Minimal current-book conversation POC

Implement inside the existing Python host, before the Node sidecar:

1. Add an explicit `BookConversation` or conversation-mode record containing `book_id` and an optional pinned chapter/sentence.
2. Build `CurrentBookContextAssembler` from the already parsed `book.epub`/chapter JSON:
   - selected sentence and paragraph;
   - bounded neighboring sentences/chapter;
   - optional user-selected excerpts;
   - Book ID, content hash, chapter index, sentence indices, and original offsets.
3. Enforce scope in code: every context record must match the active `book_id`; no “similar book” fallback.
4. Retrieve first with exact lexical/BM25-like local matching over that Book; optionally add embeddings later behind a provider setting.
5. Validate model citations against the context allow-list. Reject or strip any citation not in it.
6. Hand the assembled block and ordinary Conversation messages to the existing sidecar. Keep streaming, credentials, and model access there.
7. Keep word lookup entirely outside this path: it should use the local selected token, language, dictionary database, and existing lookup UX.

This is small, testable, and aligned with the current architecture. It does not require vector DB, MCP, a daemon, or a second system of record.

### Optional whole-book study provider POC

Keep this separate from current-book conversation:

```text
LearnBuddy Book
  → explicit user consent + preview of upload scope
  → StudyProvider interface (NotebookLM adapter)
  → isolated worker
  → queued/running/committed/failed/unknown receipt
  → locally stored report or mind-map reference/artifact
  → citation links resolved back to LearnBuddy Book spans where possible
```

The provider must not own Book bytes, reading positions, Person records, or Conversation history. Upload should be per-Book and explicit, not ambient. Reports/mind maps should be asynchronous and must clearly show cloud provenance and possible external retention. A provider outage must leave Read, lookup, and current-book conversation fully usable.

### Suggested evaluation before adoption of any RAG layer

Use at least:

- 20–50 English and 20–50 Japanese questions over 2–3 EPUBs;
- exact word/phrase, paraphrase, theme, character, and “quote the passage” cases;
- expected `{book_id, chapter, sentence}` locations;
- same-spelling/different-book negative cases to detect scope leakage;
- malformed/hostile EPUB text for prompt-injection tests;
- offline/provider-down and token-budget tests;
- citation closure, excerpt truncation, and click-to-source UI tests.

The pass criterion should be grounded location accuracy and scope safety, not a general RAG benchmark score.

## Final decision

**Do not integrate GBrain as a LearnBuddy dependency.** Use it as a primary-source reference for explicit context scoping, evidence/degradation contracts, bounded prompt blocks, gap/extractive fallback, read-only analysis workers, and system-of-record discipline. Implement those patterns in LearnBuddy’s existing host/sidecar architecture, with Book-aware types and exact sentence citations. Keep optional NotebookLM whole-book reports/mind maps behind a separate, consented, asynchronous provider boundary. Retain LearnBuddy’s own EPUB parser, reader state, dictionaries/TTS, Person records, Conversation history, and local authority.
