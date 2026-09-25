---
status: accepted
---

# Read-owned Book AI with NotebookLM as an isolated study provider

LearnBuddy keeps EPUB parsing, Book and Person records, reading position, word/phrase lookup, BookConversation, BookContext, StudyJob metadata, and StudyArtifact ownership in the existing Python host. NotebookLM, accessed through an isolated Python worker using `notebooklm-py`, is the only external knowledge and generation provider for explicit whole-Book or chapter-scoped study artifacts; the worker never becomes the authority for local reading data, and its failure must not stop Read, lookup, or TTS. Open Notebook, GBrain, and weread-omni are design references only, not runtime dependencies.

## Considered Options

- Use Open Notebook, GBrain, or weread-omni as the application backend: rejected because their domains, storage models, operational footprints, and reader semantics do not match LearnBuddy.
- Put NotebookLM behind the ordinary Chat surface: rejected because ordinary Chat and Read have separate product boundaries, and Book context must be explicit and inspectable.
- Put NotebookLM credentials and calls in the browser or main Read request path: rejected because the integration is unofficial, credential-sensitive, asynchronous, and allowed to fail independently.

## Consequences

- Book AI introduces a Read-owned BookConversation and explicit context scopes rather than changing ordinary Conversation.
- NotebookLM source/artifact IDs are non-authoritative NotebookRefs; local Book data remains usable without the provider.
- Whole-Book upload, generation, and remote cleanup are asynchronous, consented, observable, and isolated from the local reader.
