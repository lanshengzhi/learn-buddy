---
status: accepted
---

# ADR 0015: Person and surface boundaries in the first release

For a fast, single-household release, Person profiles organize Chat Conversations and Read Books and reading positions but do not enforce member-level access: anyone who can reach the app can switch profiles. Chat sends only the current Conversation's text history to the Pi-configured model; Read content is not attached. This supersedes ADR 0011's cross-surface Reference behavior and ADR 0013's current-Chapter context and per-Person privacy assumptions; it does not choose a specific model provider or pricing route. Account-level privacy can be considered later.
