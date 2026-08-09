# Domain glossary: LearnBuddy

LearnBuddy is a Web/PWA language reader for the whole family, deployed on claw: paste text → sentence segmentation → tap a sentence to hear it spoken. The repo contains both the frontend (vanilla ES modules + Service Worker, no build step) and the Python backend.

## Layout

- **Single-page layout** — The one layout of the app at every width and on every device: the **Reading area** on top, the **Editor** at the bottom. There is no view switching and no breakpoint — narrowing the window changes nothing. (ADR 0003)
- **Editor** — The text area for pasting, modifying, or appending the passage, with the **Paste from clipboard** button, the **Update** button, and the **History** tabs. At rest it collapses to a band at the bottom of the single page — one line on touch devices, two lines with a mouse. It expands to the lower half of the screen when opened (empty text at start-up, or the **History** button) and on touch devices takes over the full space above the virtual keyboard while focused. **Update**, blur, the collapse button, tapping a sentence, or Escape collapse it again.
- **Reading area** — The page region showing the **sentence cards** and the **Playback controls**. It occupies the top of the single page above the **Editor**; while the Editor is focused on a touch device it slides out of view until the Editor collapses.
- **Update** — The button that re-segments the edited text into sentences, commits the passage to **History**, and collapses the **Editor**. Re-segmentation keeps the **selected sentence** when its text still exists exactly; otherwise the first sentence is selected.

## Text and segmentation

- **Sentence** — A single chunk of text produced by **sentence segmentation**. The learner taps a sentence to hear it spoken.
- **Sentence card** — The UI representation of one sentence in the Reading area. Large enough to tap comfortably, highlighted with a border when the sentence is **selected** or **currently playing**; the border animates as a loading ring while audio is being fetched.
- **Sentence segmentation** — Splitting pasted text into sentences with a `SegmentationService` chosen by **Language detection**. The local implementation uses `Intl.Segmenter` (sentence granularity, en/ja/zh locales) behind the interface; the interface exists so a future AI segmentation backend can replace it without touching the Reading area.
- **SegmentationService** — The interface the app segments through. Today's implementation is local (`Intl.Segmenter` + **fallback chunking**); an AI-backed implementation is a planned future swap that must not change the Reading area.
- **Language detection** — Passage-level script triage of the pasted text: kana (Hiragana or Katakana) present → Japanese; Han ideographs present without kana → Simplified Chinese; otherwise English. It picks the segmentation locale for the whole passage and feeds the **Sentence voice locale**. Known limitation: a Japanese passage without kana (e.g. 日本) is detected as Chinese.
- **Sentence voice locale** — The locale a sentence is spoken in: Japanese when the sentence itself contains kana, otherwise the passage's **Language detection** result. Inheritance makes an all-kanji sentence inside a Japanese passage (e.g. 東京大学) still speak Japanese; only a whole passage without kana misdetects.
- **Fallback chunking** — A fixed-length fallback (250 characters) that splits overlong or unpunctuated text so the Reading area never produces an unusable card.

## Audio and TTS

- **TTS API** — The backend's `GET /tts?text&voice&rate` endpoint returning MP3 bytes. The backend holds the Edge TTS connection and maintains the Edge-family User-Agent, single retry, and ~3s pacing in one place; the browser never talks to Edge directly.
- **Edge TTS connection** — The upstream Microsoft Edge online text-to-speech WebSocket endpoint the backend speaks to. Protocol facts (Sec-MS-GEC token, UA gating) are researched and maintained in the backend.
- **Voice** — The neural voice used for synthesis. Defaults are `en-US-AriaNeural` for English, `ja-JP-KeitaNeural` for Japanese, and `zh-CN-YunxiNeural` for Chinese. The client chooses the voice from the sentence's **Sentence voice locale**; Edge TTS does not auto-detect language.
- **Rate** — Optional SSML speech rate passed to the TTS API (e.g. `+0%`, `-50%`). The active **Rate preset** supplies the value.
- **Rate preset** — One of six learner-selectable speech rates — 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2× — mapped linearly to SSML rates (`-50%`, `-25%`, `+0%`, `+25%`, `+50%`, `+100%`; 2× is the upstream +100% ceiling). One global preset applies to all passages and languages and persists across sessions. Selecting a preset re-synthesizes the current sentence at that rate.
- **Rate control** — The Reading area bottom-bar control that opens a menu of the six **Rate presets** and shows the active preset as its label (e.g. `1×`). Selecting a preset while audio is playing, loading, or paused cancels it and restarts the current sentence at the new rate; in **Loop-all mode** and **Loop-one mode** the loop continues at the new rate.
- **Server audio cache** — The backend's cache of MP3 bytes keyed by the SHA-256 hash of `text|voice|rate` (for Japanese, the **Reading-normalized** text plus the normalization version), shared by all family devices. A speed layer only — it never carries the offline promise.
- **Reading normalization** — The backend's G2P stage (ADR 0004) that rewrites Japanese kanji into their kana reading before synthesis. Edge TTS cannot take furigana or SSML reading hints, so the only lever is text rewriting; the rewrite runs only for Japanese voices (en/zh pass through) and never touches the displayed text. Uses SudachiPy context disambiguation (銀行→ギンコウ but 行く→イク) plus a **corrections table** for the analyzer's known date/number failures (一日中→イチニチジュウ, 二十日→ハツカ, 一昨日→オトトイ).
- **Audio cache** — The Service Worker's device-level cache of played audio, keyed by the `text|voice|rate` request URL. It exists while at least one **History entry** references it and is purged when the last referencing entry is removed — whether the learner deletes the entry or **History trimming** evicts it.
- **Offline replay** — Playing an audio-cached sentence without an active network connection. Only possible for sentences fetched while their History entry was alive — and only at the rate they were fetched at. Not offline TTS: no on-device synthesis exists.
- **Playback controls** — **Previous** (select and play the sentence before the selected one), **Replay** (play the current sentence again), **Play/Pause** (start or suspend playback), **Next** (select and play the sentence after the selected one), the **Loop toggle**, and the **Rate control**. While the Loop toggle is Off, every control plays exactly one sentence.
- **Playback bar** — The Reading area bottom bar that hosts the **Playback controls**. It sits directly below the sentence list in the single-page layout: the list scrolls above it and the bar never covers the list.
- **Loop toggle** — The three-state playback-mode switch in the Reading area bottom bar. Each tap cycles **Off → Loop-all → Loop-one → Off**. Default Off; the mode persists across sessions and applies globally to any passage. Restoring a persisted mode never auto-resumes playback. It is the single authority over the Reading area's playback mode and doubles as the mode indicator.
- **Loop-all mode** — An opt-in playback mode. While on, Play starts continuous playback from the **selected sentence** through the end of the text, then wraps to the first sentence and repeats until paused or toggled off. Pause suspends the loop without leaving the mode; toggling off finishes the current sentence then stops. Tapping a sentence card, Next, or Previous during a loop jumps to that sentence and the loop continues. The list uses **visual follow** to keep the playing sentence visible. A playback failure stops the loop, surfaces the usual error, and leaves the failed sentence selected so Play resumes from the failure point.
- **Loop-one mode** — An opt-in playback mode. While on, the **selected sentence** repeats indefinitely until paused or the toggle moves on. Tapping a sentence card, Next, or Previous jumps to that sentence and the loop continues there. Switching the toggle mid-playback never interrupts the current sentence: the new state applies when the sentence finishes. A playback failure stops the loop, surfaces the usual error, and keeps the mode with the failed sentence selected, so Play retries that sentence.
- **Visual follow** — The Reading area's auto-scroll behavior during playback: the sentence list stays still while the **currently playing sentence** is fully visible, and scrolls it to the top of the viewport only when it is not fully visible (page-turn style). Forward page-turns animate; targets above the viewport (loop wrap, upward retargeting) jump instantly. A sentence taller than the viewport counts as visible once its top reaches the viewport top.
- **Currently playing sentence** — The sentence whose audio is actively being fetched or played. Its card stays highlighted from tap through request and playback; while audio is being fetched the border animates as a loading ring.
- **Selected sentence** — The sentence the learner last tapped. It is the target for **Replay** and remains selected after playback completes until a different sentence is tapped.

## TTS contract

- **TTS exception** — The error vocabulary shared by backend and frontend: `empty_text`, `text_too_long`, `invalid_voice`, `invalid_rate`, `upstream_unavailable`, `upstream_timeout`, `network_failure`, `unknown`. The backend returns these as JSON error codes; the frontend maps them to learner-facing strings.

## History

- **History** — A local, learner-visible list of texts submitted from the **Editor**, stored in IndexedDB. It survives sessions and is bounded to 50 entries.
- **History entry** — One record in History, containing the submitted text, a timestamp, the last selected sentence index, and a **Favorite** flag. Duplicate texts are collapsed into a single entry with the newest timestamp.
- **Favorite** — The star flag a learner sets on a **History entry**. Favorited entries are exempt from **History trimming**; the non-favorite bound stays at 50. Favorites appear in the History **favorites filter** and can still be deleted.
- **Delete history entry** — The learner-initiated removal of a History entry from the History list. The entry disappears immediately; its audio cache entries are purged except those still referenced by other live entries.
- **History trimming** — Automatic removal of the oldest non-favorite History entries when the 50-entry maximum is exceeded, without learner action. **Favorite** entries are never trimmed. A trimmed entry's audio is purged exactly as if the entry had been deleted.

## Terms we avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| `phrase`, `clause`, `line` | `sentence` | The UI and splitter operate on sentence boundaries. |
| `player screen`, `listen screen` | `Reading area` | The reading surface is the Reading area. |
| `speed` | `rate` | Matches SSML parameter naming. |
| `offline TTS`, `on-device synthesis` | — | Out of scope; do not imply it exists. |
| `offline mode`, `offline playback` | `offline replay` | Only replays previously fetched audio; never arbitrary text without network. |
| `account`, `starred`, `bookmarked` | — | Out of scope; the star flag is called **Favorite**. |
| `translation`, `furigana`, `quiz` | — | Out of scope. |
