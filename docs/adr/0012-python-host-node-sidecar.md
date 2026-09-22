# ADR 0012: A Python host with a Node pi sidecar

Date: 2026-09-22
Status: Accepted
Tickets: [#33](https://github.com/lanshengzhi/learn-buddy/issues/33) (this decision), [#29](https://github.com/lanshengzhi/learn-buddy/issues/29) (engine = pi), [#32](https://github.com/lanshengzhi/learn-buddy/issues/32) (pi's measured limits), [#36](https://github.com/lanshengzhi/learn-buddy/issues/36) (v1 conversations have no tools)

The family hub keeps the Python backend as the host and a Node sidecar as the pi runtime. All family data — and the browser-facing surface — stay in Python; the sidecar owns sessions, model access and streaming, and **no family data at all**.

## Context

- Research #32 established that pi is a Node/TypeScript library and that its session files have **no lock whatsoever**: two processes writing one session produce a silently forked conversation tree, with no error and no lost lines. One process carried 20 concurrent sessions comfortably.
- The Python backend is 3.2k lines plus 2.9k lines of tests. Its parsing path (`server/textseg.py`) depends on **SudachiPy** and **jieba**, which exist only for Python; the Japanese surface → normalized → dictionary-form → reading chain and its 93.4% end-to-end hit rate were verified in map #9, as were the 163 MB dictionary build (`server/tools/build_dicts.py`) and the chapter-level parsing measurements.
- Research #35 showed custom pi tools are cheap to add, but issue #36 settled that v1's Conversation has **no tools** — context is injected by the product. That removes every reason for the sidecar to reach back into family data.
- Today's `ai-service/` is already a 190-line Node sidecar behind a systemd unit, proxied by Python over loopback. The shape exists and works.

## Decisions

- **The host stays Python.** It owns the library, epub parsing, dictionaries, TTS and its cache, Person records, reading positions, History, word states, highlights and notes, the browser-facing HTTP API — and the shell itself.
- **The sidecar stays Node and owns only conversations.** It holds pi sessions (content and resume), model access, credentials and token streaming. **It owns no family data**: Python assembles the context for one turn and hands it over; Node never reads the library, the dictionaries or any Person record.
- **The conversation list is Node's, proxied by Python.** Chat already depends on the sidecar, so a list that disappears with it adds no new loss; a Python copy would create two sources of truth, and a stateless Node would throw away pi's first-class session resume.
- **Node does not know the concept of a Person.** Python records the Person ↔ session mapping (it already owns Persons) and tells the sidecar which session to resume.
- **Exactly one sidecar process.** pi's unlocked session files make a second writer a silent-corruption risk. One process, `Restart=on-failure`, no multi-instance unit.
- **One pi agent dir**, `/var/lib/learnbuddy/ai-agent/`, owned by `learnbuddy`, `auth.json` at `0600`. Not one per Person: credential refresh rotates the token, so two copies would invalidate each other.
- **ADR 0010's layout and runtime identity stand** — `/opt/learnbuddy` (code, root-owned, read-only to the service), `/var/lib/learnbuddy` (state), `/var/cache/learnbuddy` (TTS cache), `/etc/learnbuddy` (config), both services as the `learnbuddy` system user. Chat adds no new privilege. `PI_CODING_AGENT_DIR` is set explicitly (pi ships no daemon documentation and silently degrades to print mode without a TTY) and the sidecar takes `PrivateTmp=true` (pi never reaps its `$TMPDIR` spill files).

## Considered Options

- **Rewrite everything in Node/TypeScript** — rejected: the port would have to re-earn map #9's verified parsing work, and the only way to avoid that is to keep a Python parser process alongside — which is a sidecar again.
- **Python owns the whole conversation; Node is stateless per turn** — rejected: it discards pi's first-class session resume and re-sends the history every turn.
- **Python keeps a conversation index beside Node's sessions** — rejected: two sources of truth for one list.
- **One pi agent dir per Person** — rejected: credential refresh rotation makes multiple copies invalidate one another.

## Consequences

- The reader survives a sidecar outage completely: reading, playback, lookup, word marks, highlights and position all keep working; only Chat and the AI panel degrade.
- `ai-service/` is promoted from "one-shot explainer" to "conversation runtime": it gains session resume and token streaming, and loses the per-request session wipe it performs today.
- Python gains a streaming proxy path (browser → Python → sidecar → Python → browser) where today it relays only a small JSON request/response.
- The single-writer rule is an operational invariant: scaling the sidecar horizontally would corrupt conversations, not merely slow them.
