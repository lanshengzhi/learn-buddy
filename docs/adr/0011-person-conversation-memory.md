# ADR 0011: Person, Conversation and Memory

Date: 2026-09-22
Status: Accepted
Tickets: [#26](https://github.com/lanshengzhi/learn-buddy/issues/26) (this decision), [#27](https://github.com/lanshengzhi/learn-buddy/issues/27) (the identity chip), [#34](https://github.com/lanshengzhi/learn-buddy/issues/34) (the Chat surface)

The family hub adds a Chat surface to the reader, so the entity ADR 0007 called a **Profile** — "who is reading" — now also owns conversations and whatever they remember. This ADR renames it to **Person**, refuses *agent* as product vocabulary, and draws the line between **Memory** and reading state.

## Context

- ADR 0007 introduced **Profile (档案)** for a device-local app that had just moved its learner records to the server. Its definition is a role: *who is reading*. It carries reading positions, History, word states and playback preferences, and it is deliberately unauthenticated — no password, no login, no data isolation, anyone may switch to anyone.
- Map #23 adds a Chat surface. Charting settled that **each family member has their own Chat** and that the identity chip switches the whole identity at once — reading context *and* conversation (issue #27). It also **removed** the "ask my daughter's agent" feature, so nobody reads anybody else's conversations by design (issue #34).
- The engine's vocabulary leaked into the product discussion: "each person has an agent" was being used as if *agent* were a domain concept.
- "Memory" was being used for two different things at once — the thread of a conversation, and the reading state (position, word marks, highlights) a conversation might draw on.

## Decisions

- **The entity is a `Person`.** One entity, not two: `Person` and the old `Profile` are the same thing, renamed because the old name described a role it has outgrown. *Ownership* holds — each Person's reading positions, History, word states, preferences, Conversations and Memory are theirs. *Reachability* does not — there is still no password, no login and no isolation, so anyone may switch to anyone. These are two separate statements and the glossary makes both; they merge only when a security boundary is drawn (map #23, *Out of scope*).
- **`Agent` is not product vocabulary.** In v1 each Person has exactly one conversation partner: it has no name, cannot be switched, and never runs on its own. A concept with no independently observable behaviour does not earn an entity. *Agent* stays runtime vocabulary (pi, DSH) and joins *Terms we avoid*.
- **`Conversation` is the unit of talking; `Memory` is what survives one.** In v1 Memory is the Conversation list plus resuming a stored Conversation — both provided by the engine (research #32 measured cross-process resume and token-level streaming). Cross-Conversation search and distilled personal facts are future evolution, not v1; the term is defined now so it cannot later mean two things at once.
- **Reading state is not Memory.** `Reading position`, `History`, `Word state` and the new 划线 / 想法 are the reading domain's own layer. Folding them into Memory would turn a precisely structured thing into a synonym for "everything persisted". The two layers meet through exactly one channel: **a Conversation may read the reading domain** — which is what the D3 AI panel and the 查义卡 follow-up already do.

## Considered Options

- **Keep `Profile`, widen its definition** — rejected: *Profile* reads as "a set of settings", and this entity is the owner (books, progress, words, conversations, memory), not a bundle of preferences.
- **Two entities, a `Person` and a `Profile`, with a mapping** — rejected: in v1 they would always be one-to-one, so the mapping is pure ceremony.
- **Keep `Agent` as a property of a Person** — rejected for v1: nothing observes it. Worth revisiting if agents ever gain names, autonomy or background runs.
- **Make Memory everything persisted about a Person** — rejected: it destroys the distinction that makes `Reading position` precise.
- **Ship distilled personal facts (ChatGPT-style memory) in v1** — deferred, not rejected: it needs extraction, storage and injection, and the cost model (issue #30) is still open.

## Consequences

- `CONTEXT.md` gains `Person`, `Conversation` and `Memory`, drops `Profile`, and adds `agent` to *Terms we avoid*.
- **The implementation still spells the old word**: `?profile=`, `profiles.json`, `<data-dir>/state/<profile>/` and the browser's `lb.profile`. Those identifiers are renamed when the API is rebuilt (map #23, host-language and topology ticket #33). The glossary entry says so explicitly, so a reader grepping the code is not misled.
- ADR 0007 is **narrowed, not overturned**: the server as the only store, the password-free switching, the per-Person reading position and the one-file-per-record-class writes all stand. Only the name changes, and the scope of what the entity owns widens.
- `Highlight (划线)` and `Note (想法)` are named by the prototype and confirmed for v1, but **not yet defined** — the storage unit, the re-parse anchors and the interaction with 生词提示 belong to map #23's highlights-and-notes ticket (#37).
