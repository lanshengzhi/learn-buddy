# Book AI / NotebookLM v1

## Problem Statement

LearnBuddy 的 Read 已经能够打开 EPUB、恢复阅读位置、朗读句子和查询本地词典，但沉浸式阅读中仍有三个断点：

1. 阅读者遇到不认识的英文或日文词/词组时，不能在不离开当前阅读上下文的情况下查看读音、词义和上下文解释；多读音词还需要依据当前句子选择正确读音。
2. 阅读者选中文本后没有一个低干扰的操作面来处理复制、马克笔和书本问答。
3. 阅读者想从当前书本得到更完整的解释、问答、报告、思维导图、闪卡或音频讲解时，没有一个明确、可持续的 book-scoped AI 工作流。

当前仓库已有句子切分、词边界、本地词典、TTS、Person/Book/Reading position 数据和 Python/Node 进程边界。已有外部项目调研表明，Open Notebook 的上下文准备模式、GBrain 的证据/降级模式和 weread-omni 的 provider 边界可以作为设计参考，但它们不进入 LearnBuddy 运行时。唯一实际使用的外部知识/生成后端是 NotebookLM，通过 `notebooklm-py` 接入。

## Solution

在 Read 中增加两个互相配合、但数据所有权分离的能力：

1. **词卡与选择工具条**：点击已有词边界或选择词组后，查看本地词典提供的读音、词义、当前句和可播放发音；选择文本后显示 `复制 / 马克笔 / AI 问书`，并以句级马克笔和 Book-scoped AI 保持阅读连续性。
2. **Book AI 侧栏**：从 Read 打开 Book AI 面板，查看当前 Book、章节和 context；通过 BookConversation 进行当前句、选区或章节问答；用户明确确认后，通过 NotebookLM 生成整本书或章节范围的学习报告、思维导图、闪卡和音频讲解。

Read 的 EPUB、章节、句子、阅读位置、词卡状态、马克笔、Person 和本地数据仍由 LearnBuddy 权威拥有。NotebookLM 只作为显式、隔离、可降级的远端生成资源；它不拥有 Book、Person、Reading position 或 BookConversation。

## User Stories

1. As a reader, I want to click a word in the EPUB text, so that I can understand it without leaving the reading view.
2. As a reader, I want the word card to show the selected surface form, so that I know exactly which text I am asking about.
3. As a reader, I want the word card to show a pronunciation or reading, so that I can read or pronounce the word correctly.
4. As a Japanese reader, I want the current contextual reading shown as the primary reading, so that a kanji word is interpreted in the sentence I am actually reading.
5. As a Japanese reader, I want other possible readings available without obscuring the contextual reading, so that I can understand ambiguity without losing the immediate answer.
6. As a Chinese reader, I want pinyin shown for a selected word or phrase, so that unfamiliar characters are pronounceable.
7. As an English reader, I want pronunciation information for a selected word or phrase, so that unfamiliar vocabulary can be read aloud correctly.
8. As a reader, I want the word card to include the current sentence, so that the meaning is grounded in the actual context.
9. As a reader, I want a short definition or phrase meaning, so that I can continue reading without a long detour.
10. As a reader, I want to play the selected word or phrase, so that I can hear the pronunciation immediately.
11. As a reader, I want to mark a selected word as known or unknown, so that the reader's vocabulary state remains useful across the book.
12. As a reader, I want to select a word group or sentence, so that I can inspect a phrase rather than only one token.
13. As a reader, I want a selection toolbar to appear over a valid text selection, so that common reading actions are close to the text.
14. As a reader, I want the selection toolbar to offer Copy, Highlight, and Ask Book, so that I can act without navigating to another surface.
15. As a reader, I want Copy to copy the exact selected text, so that the action does not depend on a tokenized approximation.
16. As a reader, I want Highlight to mark the current sentence, so that the mark has a stable reading anchor.
17. As a reader, I want to open Ask Book from a selection, so that the AI receives the selected passage and its nearby context.
18. As a reader, I want Ask Book from a sentence without a selection, so that I can ask about the sentence I am currently reading.
19. As a reader, I want the Book AI panel to show which Book, chapter, and context range are active, so that I know what the AI is answering about.
20. As a reader, I want quick prompts for sentence structure, word-by-word explanation, grammar points, and Chinese translation, so that common questions do not require typing.
21. As a reader, I want to type a custom question in the Book AI panel, so that I can ask a question not covered by the quick prompts.
22. As a reader, I want each Book AI message to retain the context used when it was sent, so that reopening history does not silently change the meaning of an old answer.
23. As a reader, I want Book AI answers to stream into the panel, so that the interaction feels conversational instead of blocking.
24. As a reader, I want Book AI to remain scoped to the active Book, so that it cannot silently answer from another Book or from global reading history.
25. As a reader, I want a chapter-scoped question, so that a long Book can be discussed without sending the entire Book by default.
26. As a reader, I want an explicit whole-Book question, so that the extra upload and cloud processing are visible and intentional.
27. As a reader, I want a whole-Book answer to be clearly identified as NotebookLM-generated, so that I understand where the answer came from.
28. As a reader, I want to generate a learning report for the current chapter or the whole Book, so that I can obtain a structured study aid.
29. As a reader, I want to generate a mind map for the current chapter or the whole Book, so that I can see the structure of the material.
30. As a reader, I want to generate flashcards for a selection, chapter, or whole Book, so that I can turn the material into study prompts.
31. As a reader, I want to generate an audio explanation for a chapter or the whole Book, so that I can listen while commuting or practicing.
32. As a reader, I want generation to show progress through preparation, upload, remote wait, download, completion, or failure, so that a long task is not an unexplained spinner.
33. As a reader, I want generated reports, mind maps, flashcards, and audio to appear in a center preview, so that I can inspect the result before leaving the Book.
34. As a reader, I want to close an artifact preview and return to the exact reading position, so that previewing does not disturb immersion.
35. As a reader, I want to download the original generated artifact, so that I retain a copy outside the transient preview.
36. As a reader, I want to list this Book's AI tasks and artifacts, so that I can find work after closing the side panel.
37. As a reader, I want a failed task to show a product-owned error and a safe retry action, so that upstream messages do not leak or become misleading.
38. As a reader, I want an unknown remote task to avoid automatic resubmission, so that a lost response does not create duplicate artifacts or consume quota twice.
39. As a reader, I want Read, word lookup, and TTS to keep working when NotebookLM is unconfigured or unavailable, so that the core reading experience is independent of the cloud.
40. As a reader, I want to know when content will be uploaded to Google NotebookLM, so that cloud processing is not implicit.
41. As a reader, I want a local Book to remain readable after a remote Notebook or Source is deleted, so that remote cleanup cannot remove reading data.
42. As a Person, I want my BookConversation and generated-artifact records organized under my Person, so that my reading activity is not mixed into another Person's records by default.
43. As a Person, I want my BookConversation to be separate from ordinary Chat, so that general conversations do not silently acquire Book content.
44. As a maintainer, I want NotebookLM credentials kept out of the browser and ordinary Read requests, so that the unofficial integration does not widen the web security boundary.
45. As a maintainer, I want the remote NotebookLM worker isolated from the local data owner, so that provider failures or upgrades do not corrupt Books or Person records.
46. As a maintainer, I want local Book hashes to identify remote Source mappings, so that repeated uploads are controlled and content versions are traceable.
47. As a maintainer, I want local deletion separated from remote deletion, so that cleanup operations are explicit and recoverable.
48. As a maintainer, I want this feature integrated into `/next/` first, so that the old reading shell remains a rollback path during the staged rollout.
49. As a maintainer, I want the new behavior tested with a fake NotebookLM worker, so that ordinary tests do not depend on a Google account or live quota.
50. As a maintainer, I want real-device rollout checks for wide and narrow layouts, so that panel overlays and mobile keyboard behavior do not regress reading position or input access.

## Implementation Decisions

- The feature is a Read capability. It introduces a Book-scoped conversation and artifact workflow without changing ordinary Chat.
- The new domain terms are `BookConversation`, `BookContext`, `ContextScope`, `StudyJob`, `StudyArtifact`, and `NotebookRef`.
- `BookConversation` is separate from `Conversation`. It belongs to a Person and a Book and records the context used by each turn.
- A Person may have multiple BookConversations for one Book. The first release opens one active conversation by default but preserves the identity needed for new, resumed, and historical conversations.
- A Book is locally authoritative. A remote NotebookLM Notebook and Source are represented by a non-authoritative `NotebookRef`.
- The initial remote mapping is one LearnBuddy Book to one NotebookLM Notebook containing one EPUB Source. Mapping identity includes the local content hash and remote IDs.
- NotebookLM is the only external knowledge and generation provider. Open Notebook, GBrain, and weread-omni are reference material only and are not runtime dependencies.
- Word and phrase cards use the existing local dictionary and parser paths. NotebookLM is not used as a real-time dictionary.
- Existing baked sentence and word boundaries are the default tap/selection substrate. Arbitrary user selections remain supported and take precedence for phrase actions.
- Japanese contextual reading comes from the existing language-aware parsing path where available; alternate readings are supplementary and never replace the contextual result silently.
- `BookContext` supports sentence, selection, chapter, and book scopes. Every context is bound to a Book ID and a Book content hash.
- Default context is the selected range or current sentence with bounded neighboring context. Chapter scope is explicit. Whole-Book scope requires an explicit cloud-processing action and upload/sync confirmation.
- Context is assembled by LearnBuddy as data, not as model instructions, and is bounded before it reaches a model. Scope validation is fail-closed: a context record from another Book is rejected.
- Each sent message records a context snapshot. Historical messages are not silently re-contextualized when the reader changes selection or the Book changes.
- Book AI normal answers stream through the existing model sidecar. NotebookLM generation jobs use asynchronous status transitions rather than token streaming.
- The Python host owns Books, Persons, BookConversations, BookContext metadata, StudyJobs, StudyArtifacts, provenance, and all local product APIs.
- A separate Python worker owns the `notebooklm-py` client, account credentials, source upload, remote polling, remote generation, and artifact download. The worker returns controlled results to the host and never directly mutates product data.
- The worker credential boundary is service-user-only. The browser never receives NotebookLM cookies, master tokens, or profile files.
- The worker is optional. Unconfigured, expired, unavailable, quota-limited, rejected-source, unknown-result, and download-failed states are represented by fixed product error codes.
- StudyJob states are: `not_configured`, `queued`, `preparing`, `uploading`, `waiting_remote`, `downloading`, `ready`, `failed`, `unknown`, and `cancelled`.
- Only `ready` is a successful job. `unknown` is never automatically resubmitted because the remote side effect may already have succeeded.
- The four v1 artifact types are learning report, mind map, flashcard set, and audio explanation. Their original downloads and local metadata are retained; the product preview is a separate concern.
- Artifacts are Person-scoped local records with a Book reference, scope, status, content hash, original file, preview data, and remote provenance. A remote notebook is shared at Book level, but local records and conversations are not automatically shared between Persons.
- Local artifact deletion and remote Notebook/Source/Artifact deletion are separate operations. Remote deletion requires explicit confirmation and reports partial or failed cleanup.
- The side panel has explicit closed, ask, job, and artifact-preview states. Opening or closing it must not rebuild the reading surface or lose its scroll position.
- The right panel is a Book AI surface, not a general Chat surface. Ordinary Chat remains independent and does not automatically receive Read content.
- The selection toolbar contains Copy, Highlight, and Ask Book. Write thoughts is not part of this first Book AI slice.
- The new UI is shipped in the `/next/` shell first. The old shell remains a rollback path and shares the existing Book and Person data.
- The Book AI API is explicit and separate from word lookup. Word lookup continues to use the existing dictionary/explanation contract; Book AI uses conversation, job, and artifact contracts.
- The source EPUB is uploaded lazily. Importing or reading a Book never implicitly uploads it to NotebookLM.
- The context compiler follows the reference pattern of explicit scope, retrieval/selection, bounded assembly, evidence metadata, and honest fallback. It does not import a general external memory daemon.
- The source-grounded answer must retain both NotebookLM provenance and LearnBuddy provenance. A remote citation is not presented as an exact local sentence unless a Book/chapter/sentence mapping has been validated.
- A synthesis failure after evidence collection falls back to extractive evidence rather than returning an unsupported generated answer.
- Long-running analysis uses a read-only worker capability. The trusted host validates and publishes local results.
- Local Book data and reading state remain available when the NotebookLM worker is stopped, misconfigured, rate-limited, or otherwise degraded.

## Testing Decisions

- The primary testing seam is the highest local HTTP/API contract around the Python host, using a deterministic fake NotebookLM worker. Tests assert product-visible requests, responses, state transitions, context scope, and persistence rather than private implementation details.
- A second high seam is the `/next/` browser smoke test for the real Read surface: selection toolbar, word card, side panel state transitions, artifact preview, scroll-position preservation, and mobile overlay behavior.
- Existing parser, dictionary, sentence-position, and reading-state tests are extended rather than replaced. In particular, tests cover baked Japanese reading/ruby, Chinese token boundaries, English token boundaries, exact sentence reconstruction, and dictionary lookup behavior.
- Context tests cover sentence, selection, chapter, and book scopes; adjacent-sentence inclusion; content-hash changes; cross-Book scope rejection; explicit truncation; and the data-not-instructions boundary.
- Conversation tests cover one active BookConversation, new/resume/delete behavior, context snapshot persistence, ordinary Chat isolation, streaming response handling, and historical context behavior after Book changes.
- NotebookLM worker contract tests use a fake worker for authentication state, source mapping, upload progress, polling, artifact download, fixed error mapping, and process restart recovery.
- Job tests cover every StudyJob state, especially the rule that `unknown` cannot trigger automatic resubmission and that only `ready` publishes a local artifact.
- Provenance tests verify that remote Notebook/Source IDs never replace local Book IDs, that local hashes detect content changes, and that unverified remote citations are not rendered as local sentence links.
- Browser tests cover click-word versus drag-selection routing, Copy/Highlight/Ask Book actions, opening and closing the side panel without reading-position loss, center artifact preview, and returning to the original sentence.
- Narrow-screen tests cover the side panel as an overlay, drawer/overlay layer ordering, input focus with the virtual keyboard, and the existing visual-viewport behavior.
- Failure tests cover NotebookLM not configured, authentication required, provider unavailable, quota limit, rejected source, download failure, and unknown remote outcome. In all cases local Read, lookup, TTS, and reading position remain usable.
- The real NotebookLM integration is an opt-in deployment/canary lane, never a required CI credential. It is not part of deterministic automated tests.
- Rollout verification follows the existing staged strategy: maintainer PC dogfood first, then real-device checks, then household trial. The old shell remains available until the existing rollback window closes.
- Acceptance is based on user-visible behavior and data safety, not on generic RAG benchmark scores.

## Out of Scope

- Automatic upload of the entire Book library.
- Uploading a Book merely because it was imported or opened.
- Using NotebookLM as a real-time dictionary or replacing the local dictionary.
- Replacing local TTS with NotebookLM audio.
- Making ordinary Chat automatically read or remember Book content.
- Default cross-Book search.
- Importing flashcards into spaced repetition or mastery tracking.
- Editing or merging NotebookLM artifacts in LearnBuddy.
- General PDF annotation or a full PDF reader.
- A mind-map editor.
- Automatic conversion of artifacts into formal Learn records.
- Automatic sharing of one Person's BookConversation or artifacts with another Person.
- Unconfirmed remote writes or deletions.
- Treating a remote Notebook ID, Source ID, or artifact ID as a local primary key.
- Adopting Open Notebook, GBrain, weread-omni, or another external memory/RAG application as runtime infrastructure.
- General multi-user authentication, account-level privacy isolation, or internet-facing NotebookLM access.
- Real NotebookLM account testing in deterministic CI.
- A Write Thoughts action in this first slice.

## Further Notes

- The external repository reviews are stored as local research notes and are design references only:
  - `docs/research/external-reading-learning-repos-2026-09-25.md`
  - `docs/research/gbrain-source-review-2026-09-25.md`
- The first implementation should preserve the existing Python host and Node sidecar topology. The NotebookLM worker is an additional isolated process, not a replacement for the existing sidecar.
- The existing `/next/` shell and staged rollout decisions remain authoritative. This spec adds Read-scoped Book AI behavior to that shell rather than changing the old shell.
- NotebookLM integration is unofficial and account-sensitive. The spec therefore treats credentials, account availability, quotas, source processing, and remote deletion as operational risks that must be visible in the product.
- The first release should optimize for exact local reading anchors and honest context scope, not for a general-purpose personal memory system.
