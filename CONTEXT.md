# Domain glossary: LearnBuddy

LearnBuddy is the Web/PWA port of dasan's Language Reader Android app: paste text → sentence segmentation → tap a sentence to hear it spoken, deployed on claw for the whole family. Behavior baseline is dasan's Android app (`~/Work/dasan/CONTEXT.md`); this glossary restates the shared vocabulary in LearnBuddy terms, changing only where the web/backend architecture differs (marked with *Web*).

## Core screens

- **Paste screen** — The first screen. Contains a large text field, a **Paste from clipboard** button, a **Read** button, and a list of recent **history entries**. The Read button is disabled when the text field is empty.
- **Reader screen** — The second screen. Shows the pasted text as a scrollable list of **sentence cards**. The first sentence is automatically **selected** after segmentation so the bottom controls are immediately usable. Tapping a card plays its audio.

## Text and segmentation

- **Sentence** — A single chunk of text produced by **sentence segmentation**. The learner taps a sentence to hear it spoken.
- **Sentence card** — The UI representation of one sentence in the Reader screen. Large enough to tap comfortably, highlighted with a border when the sentence is **selected** or **currently playing**; the border animates as a loading ring while audio is being fetched.
- **Sentence segmentation** — Splitting pasted text into sentences with a `SegmentationService` chosen by **Language detection**. The local implementation uses `Intl.Segmenter` (sentence granularity, en/ja/zh locales) behind the interface; the interface exists so a future AI segmentation backend can replace it without touching the Reader.
- **SegmentationService** — The interface the Reader segments through. Today's implementation is local (`Intl.Segmenter` + **fallback chunking**); an AI-backed implementation is a planned future swap that must not change the Reader.
- **Language detection** — Script-based triage of the pasted text: kana (Hiragana or Katakana) present → Japanese; Han ideographs present without kana → Simplified Chinese; otherwise English. Known limitation (dasan ADR 0007, preserved): Japanese text without kana (e.g. 日本) is detected as Chinese.
- **Fallback chunking** — A fixed-length fallback (250 characters) that splits overlong or unpunctuated text so the Reader never produces an unusable card.

## Audio and TTS

- **TTS API** — *Web*: the backend's `GET /tts?text&voice&rate` endpoint returning MP3 bytes. The backend holds the Edge TTS connection and maintains the Edge-family User-Agent, single retry, and ~3s pacing in one place; the browser never talks to Edge directly.
- **Edge TTS connection** — The upstream Microsoft Edge online text-to-speech WebSocket endpoint the backend speaks to. Protocol facts (Sec-MS-GEC token, UA gating) are researched and maintained in the backend.
- **Voice** — The neural voice used for synthesis. Defaults are `en-US-AriaNeural` for English, `ja-JP-KeitaNeural` for Japanese, and `zh-CN-YunxiNeural` for Chinese. The client chooses the voice from **Language detection**; Edge TTS does not auto-detect language.
- **Rate** — Optional SSML speech rate passed to the TTS API (e.g. `+0%`, `-50%`). The active **Rate preset** supplies the value.
- **Rate preset** — One of six learner-selectable speech rates — 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2× — mapped linearly to SSML rates (`-50%`, `-25%`, `+0%`, `+25%`, `+50%`, `+100%`; 2× is the upstream +100% ceiling). One global preset applies to all passages and languages and persists across sessions. Selecting a preset re-synthesizes the current sentence at that rate.
- **Rate control** — The Reader bottom-bar control that opens a menu of the six **Rate presets** and shows the active preset as its label (e.g. `1×`). Selecting a preset while audio is playing, loading, or paused cancels it and restarts the current sentence at the new rate; in **Loop-all mode** and **Loop-one mode** the loop continues at the new rate.
- **Server audio cache** — *Web*: the backend's cache of MP3 bytes keyed by the SHA-256 hash of `text|voice|rate`, shared by all family devices. A speed layer only — it never carries the offline promise.
- **Audio cache** — *Web*: the Service Worker's device-level cache of played audio, keyed by the `text|voice|rate` request URL. It exists while at least one **History entry** references it and is purged when the last referencing entry is removed — whether the learner deletes the entry or **History trimming** evicts it.
- **Offline replay** — Playing an audio-cached sentence without an active network connection. Only possible for sentences fetched while their History entry was alive — and only at the rate they were fetched at. Not offline TTS: no on-device synthesis exists.
- **Playback controls** — **Previous** (select and play the sentence before the selected one), **Replay** (play the current sentence again), **Play/Pause** (start or suspend playback), **Next** (select and play the sentence after the selected one), the **Loop toggle**, and the **Rate control**. While the Loop toggle is Off, every control plays exactly one sentence.
- **Loop toggle** — The three-state playback-mode switch in the Reader bottom bar. Each tap cycles **Off → Loop-all → Loop-one → Off**. Default Off; the mode persists across sessions and applies globally to any passage. Restoring a persisted mode never auto-resumes playback. It is the single authority over the Reader's playback mode and doubles as the mode indicator.
- **Loop-all mode** — An opt-in Reader playback mode. While on, Play starts continuous playback from the **selected sentence** through the end of the text, then wraps to the first sentence and repeats until paused or toggled off. Pause suspends the loop without leaving the mode; toggling off finishes the current sentence then stops. Tapping a sentence card, Next, or Previous during a loop jumps to that sentence and the loop continues. The list uses **visual follow** to keep the playing sentence visible. A playback failure stops the loop, surfaces the usual error, and leaves the failed sentence selected so Play resumes from the failure point.
- **Loop-one mode** — An opt-in Reader playback mode. While on, the **selected sentence** repeats indefinitely until paused or the toggle moves on. Tapping a sentence card, Next, or Previous jumps to that sentence and the loop continues there. Switching the toggle mid-playback never interrupts the current sentence: the new state applies when the sentence finishes. A playback failure stops the loop, surfaces the usual error, and keeps the mode with the failed sentence selected, so Play retries that sentence.
- **Visual follow** — The Reader's auto-scroll behavior during playback: the sentence list stays still while the **currently playing sentence** is fully visible, and scrolls it to the top of the viewport only when it is not fully visible (page-turn style). Forward page-turns animate; targets above the viewport (loop wrap, upward retargeting) jump instantly.
- **Currently playing sentence** — The sentence whose audio is actively being fetched or played. Its card stays highlighted from tap through request and playback; while audio is being fetched the border animates as a loading ring.
- **Selected sentence** — The sentence the learner last tapped. It is the target for **Replay** and remains selected after playback completes until a different sentence is tapped.

## TTS contract

- **TTS exception** — The error vocabulary shared by backend and frontend: `empty_text`, `text_too_long`, `invalid_voice`, `invalid_rate`, `upstream_unavailable`, `upstream_timeout`, `network_failure`, `unknown`. The backend returns these as JSON error codes; the frontend maps them to learner-facing strings (wording carried over from the Android app).

## History

- **History** — A local, learner-visible list of texts submitted from the Paste screen, stored in IndexedDB. It survives sessions and is bounded to 50 entries.
- **History entry** — One record in History, containing the submitted text and a timestamp. Duplicate texts are collapsed into a single entry with the newest timestamp.
- **Delete history entry** — The learner-initiated removal of a History entry from the Paste screen. The entry disappears immediately; its audio cache entries are purged except those still referenced by other live entries.
- **History trimming** — Automatic removal of the oldest History entries when the 50-entry maximum is exceeded, without learner action. A trimmed entry's audio is purged exactly as if the entry had been deleted.

## Terms we avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| `phrase`, `clause`, `line` | `sentence` | The UI and splitter operate on sentence boundaries. |
| `player screen`, `listen screen` | `Reader screen` | Consistent with the two-screen model. |
| `speed` | `rate` | Matches SSML parameter naming. |
| `offline TTS`, `on-device synthesis` | — | Out of scope; do not imply it exists. |
| `offline mode`, `offline playback` | `offline replay` | Only replays previously fetched audio; never arbitrary text without network. |
| `account`, `favorites` | — | Out of scope. |
| `translation`, `furigana`, `quiz` | — | Out of scope. |
