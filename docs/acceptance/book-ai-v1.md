# Book AI v1 acceptance and rollout gate

- **Issue:** [#81](https://github.com/lanshengzhi/learn-buddy/issues/81)
- **Implementation under test:** consolidated Standards and Spec review-fix pass on `feat/book-ai-notebooklm-v1`
- **Recorded:** 2026-09-25 (review-fix rerun)
- **Decision:** automated acceptance passes; household rollout is **BLOCKED** pending the human gates below.

## Acceptance story map

The v1 stories are covered by focused deterministic tests rather than one large provider test:

| Stories | Evidence |
|---|---|
| 1–10, 12, 22 | `tests/book-lookup-card.test.js`; `server/tests/test_api.py::TestLookupEndpoints`; `tests/api-client.test.js` |
| 4–5 | `tests/book-lookup-card.test.js` contextual ruby/alternate-reading tests; `server/tests/test_dicts.py` |
| 11 | `server/tests/test_api.py::TestWordsEndpoint`; `tests/book-support.test.js`; browser-smoke mark-known flow |
| 13–18 | `tests/read-purity.test.js`; `tests/shell-controller.test.js`; `scripts/shell-smoke.mjs` selection/toolbar and sentence-anchor checks |
| 19–24, 27, 43 | `tests/book-ai-panel.test.js`; `server/tests/test_book_context.py`; `server/tests/test_book_conversation_api.py`; `scripts/shell-smoke.mjs` |
| 20–21, 25–26 | `tests/book-ai-panel.test.js` quick prompts; `server/tests/test_book_context.py`; `server/tests/test_book_conversation_api.py` |
| 28–36 | `tests/book-ai-panel.test.js`; `server/tests/test_api.py::TestStudyArtifactEndpoint`; `scripts/shell-smoke.mjs` |
| 32, 37–39, 44–47 | `server/tests/test_notebooklm.py`; `server/tests/test_api.py::TestStudyArtifactEndpoint`; `tests/api-client.test.js`; `tests/book-ai-panel.test.js` |
| 40 | `server/tests/test_notebooklm.py::TestNotebookLMSyncBoundary` and `server/tests/test_api.py::TestStudyArtifactEndpoint` |
| 41 | `server/tests/test_api.py::TestStudyArtifactEndpoint` local deletion/read-preservation checks |
| 42–43 | `server/tests/test_book_ai.py`; `server/tests/test_book_conversation_api.py::TestBookConversationApi::test_person_isolation` and ordinary-Chat isolation test |
| 48 | `server/tests/test_server.py::TestStaticServing`; `scripts/shell-smoke.mjs` old-shell parity checks |
| 49 | `server/tests/test_notebooklm.py` fake worker/provider contracts; no live credentials used |
| 50 | `tests/read-purity.test.js`; `scripts/shell-smoke.mjs` wide/narrow Book AI overlay and input geometry checks |

## Automated results

All commands were rerun after the consolidated Standards and Spec review fixes.

| Command | Result |
|---|---|
| `(cd server && python3 -m unittest discover -s tests -p 'test_*.py' -v)` | **PASS** — 295 tests, 11 optional-tokenizer skips (SudachiPy/Jieba unavailable) |
| `node --test` | **PASS** — 169 tests, 0 failures |
| `DATA=$(mktemp -d /tmp/learnbuddy-81-data.XXXXXX); python3 server/tts_server.py --port 8123 --data-dir "$DATA"; node scripts/shell-smoke.mjs` | **PASS** — fresh data dir; `/next/`, Learn, Chat, narrow layout, Book AI, old `/` parity, rollback path |
| `DATA=$(mktemp -d /tmp/learnbuddy-81-browser-data.XXXXXX); python3 server/tts_server.py --port 8123 --data-dir "$DATA" &` then `LEARNBUDDY_BASE=http://127.0.0.1:8123 LEARNBUDDY_EPUB=server/tests/fixtures/nav.epub node scripts/browser-smoke.mjs` | **PASS** — fresh data dir and project `nav.epub`; EPUB upload/open, immediate mid-debounce pagehide position flush, position resume, lookup, TTS, Learn, and legacy shell |

The browser smoke now supplies a deterministic lookup response at the browser boundary so a fresh data directory does not depend on an installed dictionary database. It still exercises the real word-card and `mark-known` rendering path. NotebookLM remains unconfigured; no live account or quota was used.

## Human gates (not yet recorded)

These are required gates, not implied by automated coverage. **Do not start household rollout until each is recorded with date, device/account, and result:**

1. **Physical iPhone / virtual keyboard — PENDING.** Test wide and narrow layouts, Book AI overlay ordering, input focus with the real iOS keyboard, opening/closing and artifact preview return, and reading-position preservation.
2. **Maintainer PC dogfood — PENDING.** Record the maintainer's `/next/` result across EPUB parsing, reading position, lookup, TTS, Learn, ordinary Chat, and Book AI provider-down behavior.
3. **Opt-in live NotebookLM account/quota — PENDING.** With explicit consent only, record authentication state, one representative chapter generation, quota/error behavior, and remote cleanup status. Do not place credentials in the browser or repository.

Household rollout is blocked while any human gate is pending. Usability complaints are soft lines; they do not override the hard rollback line.

## Hard rollback

1. Stop routing the default shell to `/next/`; keep the legacy shell at `/` and its existing data plane.
2. If a deploy process changed the default route, restore the last known-good deployment/configuration (the old shell is already retained at `/`).
3. **Do not delete or migrate the shared data directory.** Books, Persons, reading positions, words, History, highlights, BookConversations, NotebookRefs, StudyJobs, and StudyArtifacts remain on disk. The old shell may not render new Book AI records; it must not erase them.
4. Verify `/` opens, an existing Book opens, the stored reading position resumes, lookup and TTS work, and Learn/Chat remain available. Record the rollback event and affected data files before any cleanup or retry.
5. Resume `/next/` only after the cause is fixed and the acceptance gate plus required human gates are rerun.

Trigger hard rollback immediately for data loss, a core reading regression (open Book, TTS, or lookup), or service startup failure. No automated result in this record authorizes household rollout.
