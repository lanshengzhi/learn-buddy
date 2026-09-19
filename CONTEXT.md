# Domain glossary: LearnBuddy

LearnBuddy is a Web/PWA language reader for the whole family, deployed on claw: upload an epub (or paste text) → read a chapter → tap a sentence to hear it spoken → long-press or hover a word to look it up. The repo contains both the frontend (vanilla ES modules + Service Worker, no build step) and the Python backend.

Learner records live **only on the server**, keyed by **Profile**: reading position, History, word states and playback preferences. The browser keeps one key (`lb.profile` — who is using this device) plus the Service Worker shell cache; no learner state and no audio. (ADR 0007)

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

- **TTS API** — The backend's `GET /tts?text&voice&rate` endpoint returning MP3 bytes. The backend owns the **TTS provider** layer — provider selection, retries, and pacing — in one place; the browser never talks to an upstream provider directly.
- **TTS provider** — The synthesis backend behind the **TTS API**. **Azure Speech** is primary when the server holds a key; **Edge TTS connection** is the automatic fallback (no key, or an Azure failure). The switch is invisible to the frontend.
- **Azure Speech** — Microsoft's neural TTS service, the primary **TTS provider** (ADR 0005). It accepts real SSML, so `<phoneme alphabet="sapi">` can control a word's **读音** *and* **声调** at once — the dual control kana text cannot provide.
- **Edge TTS connection** — The upstream Microsoft Edge online text-to-speech WebSocket endpoint the backend speaks to as the fallback **TTS provider**. Protocol facts (Sec-MS-GEC token, UA gating) are researched and maintained in the backend; it cannot take SSML reading hints (no `<phoneme>`), which is why the **Reading normalization** keeps a plain-text form for it.
- **Voice** — The neural voice used for synthesis. Defaults are `en-US-AriaNeural` for English, `ja-JP-KeitaNeural` for Japanese, and `zh-CN-YunxiNeural` for Chinese. The client chooses the voice from the sentence's **Sentence voice locale**; neither provider auto-detects language.
- **读音 (reading / yomi)** — Which kana a kanji maps to; the polyphonic (多音字) dimension of pronunciation. The TTS provider resolves readings from its own G2P and misreads some words (e.g. 定める read as ていめる instead of さだめる). Distinct from **声调**.
- **声调 (pitch accent)** — The high/low pitch contour of a word (頭高 / 中高 / 尾高 / 平板). Kanji text lets ja voices apply dictionary accents; kana text does not, which is why kana-ized audio loses correct accents. Azure's `<phoneme>` pins both **读音** and **声调**; the Edge fallback keeps only the reading. Distinct from **读音**: homophones like 雨/飴 share a reading but differ in accent.
- **Rate** — Optional SSML speech rate passed to the TTS API (e.g. `+0%`, `-50%`). The active **Rate preset** supplies the value.
- **Rate preset** — One of six learner-selectable speech rates — 0.5×, 0.75×, 1×, 1.25×, 1.5×, 2× — mapped linearly to SSML rates (`-50%`, `-25%`, `+0%`, `+25%`, `+50%`, `+100%`; 2× is the upstream +100% ceiling). One preset per **Profile** applies to every passage and language and persists across sessions; switching Profile switches the preset. Selecting a preset re-synthesizes the current sentence at that rate.
- **Rate control** — The Reading area bottom-bar control that opens a menu of the six **Rate presets** and shows the active preset as its label (e.g. `1×`). Selecting a preset while audio is playing, loading, or paused cancels it and restarts the current sentence at the new rate; in **Loop-all mode** and **Loop-one mode** the loop continues at the new rate.
- **Server audio cache** — The backend's cache of MP3 bytes keyed by the SHA-256 hash of `text|voice|rate` (for Japanese, the **Reading-normalized** text plus the normalization version), shared by all family devices and Profiles. It is the **only** audio cache: the browser stores no audio (ADR 0007), so replaying a sentence needs the LAN.
- **Reading normalization** — The backend's G2P stage (ADR 0004/0005) that
  corrects confirmed Japanese mispronunciations before synthesis. **Kanji-
  default**: the original text passes through untouched (kanji keeps the
  native pitch accent — kana input, in any form, was rejected by ear:
  katakana triggers the loanword head-high accent, hiragana loses the lexical
  accent), and only surfaces in the curated **replacement table** (words
  confirmed misread, e.g. 定める) are touched — wrapped in a `<phoneme>`
  carrying reading **and** accent for **Azure Speech**, and rewritten to
  their hiragana reading for the **Edge TTS connection** fallback. Runs only
  for Japanese voices (en/zh pass through) and never touches the displayed
  text.
- **Playback controls** — **Previous** (select and play the sentence before the selected one), **Replay** (play the current sentence again), **Play/Pause** (start or suspend playback), **Next** (select and play the sentence after the selected one), the **Loop toggle**, and the **Rate control**. While the Loop toggle is Off, every control plays exactly one sentence.
- **Playback bar** — The Reading area bottom bar that hosts the **Playback controls**. It sits directly below the sentence list in the single-page layout: the list scrolls above it and the bar never covers the list.
- **Loop toggle** — The three-state playback-mode switch in the Reading area bottom bar. Each tap cycles **Off → Loop-all → Loop-one → Off**. Default Off; the mode persists across sessions per **Profile** and applies to any passage that Profile reads. Restoring a persisted mode never auto-resumes playback. It is the single authority over the Reading area's playback mode and doubles as the mode indicator.
- **Loop-all mode** — An opt-in playback mode. While on, Play starts continuous playback from the **selected sentence** through the end of the text, then wraps to the first sentence and repeats until paused or toggled off. Pause suspends the loop without leaving the mode; toggling off finishes the current sentence then stops. Tapping a sentence card, Next, or Previous during a loop jumps to that sentence and the loop continues. The list uses **visual follow** to keep the playing sentence visible. A playback failure stops the loop, surfaces the usual error, and leaves the failed sentence selected so Play resumes from the failure point.
- **Loop-one mode** — An opt-in playback mode. While on, the **selected sentence** repeats indefinitely until paused or the toggle moves on. Tapping a sentence card, Next, or Previous jumps to that sentence and the loop continues there. Switching the toggle mid-playback never interrupts the current sentence: the new state applies when the sentence finishes. A playback failure stops the loop, surfaces the usual error, and keeps the mode with the failed sentence selected, so Play retries that sentence.
- **Visual follow** — The Reading area's auto-scroll behavior during playback: the sentence list stays still while the **currently playing sentence** is fully visible, and scrolls it to the top of the viewport only when it is not fully visible (page-turn style). Forward page-turns animate; targets above the viewport (loop wrap, upward retargeting) jump instantly. A sentence taller than the viewport counts as visible once its top reaches the viewport top.
- **Currently playing sentence** — The sentence whose audio is actively being fetched or played. Its card stays highlighted from tap through request and playback; while audio is being fetched the border animates as a loading ring.
- **Selected sentence** — The sentence the learner last tapped. It is the target for **Replay** and remains selected after playback completes until a different sentence is tapped.

## TTS contract

- **TTS exception** — The error vocabulary shared by backend and frontend: `empty_text`, `text_too_long`, `invalid_voice`, `invalid_rate`, `upstream_unavailable`, `upstream_timeout`, `network_failure`, `unknown`. The backend returns these as JSON error codes; the frontend maps them to learner-facing strings.
- **API error** — The same `{"error": code}` shape for the Book and Profile endpoints: `bad_request`, `profile_not_found`, `book_not_found`, `chapter_not_found`, `entry_not_found`, `not_found`, `too_large`, `not_epub`, `parse_failed`, and for the lookup / AI layer `lookup_unavailable`, `ai_not_configured`, `ai_upstream_error`, `ai_timeout` (plus `network_failure` and `unknown`; ADR 0008).

## Learners and records

- **Profile (档案)** — One member of the family using the app: *who is reading*. No password, no login, no data isolation — anyone may switch to anyone. The active Profile decides whose **Reading position**, **History**, **Word state** and playback preferences apply. The list is a read-only `profiles.json` on the server; the device remembers the last choice in `lb.profile`. (ADR 0007)
- **Word state** — A **Profile**'s mark on a word from a **Lookup**: 我认识 or unmarked, two states only. Stored per Profile and shared across all **Books**, keyed by the resolved **Word key** (`ja:食べる`, `en:run`), so inflected forms share one state; words marked 我认识 are the ones the 生词提示 machinery leaves alone.
- **Word key** — The storage identity of a looked-up word: the language prefix plus the **dictionary form** the lookup resolved to (`ja:食べる`, `en:run`). Inflected surfaces (食べられ, running) resolve to the same key, so a mark made on one form applies to all of them.

## History

- **History** — A per-**Profile**, learner-visible list of texts submitted from the **Editor**, stored on the server. It survives sessions and devices, and is bounded to 50 entries. Books are never History entries.
- **History entry** — One record in History, containing the submitted text, a timestamp, the last selected sentence index, and a **Favorite** flag. Duplicate texts are collapsed into a single entry with the newest timestamp.
- **Favorite** — The star flag a learner sets on a **History entry**. Favorited entries are exempt from **History trimming**; the non-favorite bound stays at 50. Favorites appear in the History **favorites filter** and can still be deleted.
- **Delete history entry** — The learner-initiated removal of a History entry from the History list. The entry disappears immediately, for that Profile on every device.
- **History trimming** — Automatic removal of the oldest non-favorite History entries when the 50-entry maximum is exceeded, without learner action. **Favorite** entries are never trimmed.

## Books and lookup

- **Library (书库)** — The family's shared set of uploaded **Books** (`<data-dir>/books/`; the data dir defaults to `server/data/` and is set with `--data-dir`). Not a bookshelf: no covers, categories, search, or parallel reading.
- **Book** — One uploaded epub in the **Library**, with its own **Chapter** structure and a **Reading position** per **Profile**. The app opens one Book at a time; reopening the app returns to the last one opened by the active Profile.
- **Chapter** — A section of a **Book**, taken from the epub's own navigation; the unit of reading, playback, and progress.
- **Reading position** — Where in a **Book** a **Profile** last stopped, stored on the server as a chapter plus sentence index (with the sentence's opening text for re-anchoring after a re-parse), so it follows that Profile across devices; the app returns there when the Book is opened again.
- **Lookup (查义)** — An on-demand query on a character or word for its reading and meaning, served by the server over build-time SQLite dictionaries (`en`/`ja` + kanji fallback under `<data-dir>/dicts/`; ADR 0008). The card first shows the local dictionary entry (读音 + senses); the AI context explanation is an optional layer *on top of* it (separate tab), never part of the Lookup itself. A word missing from the dictionary is a card state (「词典里没有这个词。」), never a hidden failure.
- **生词提示 (word highlight)** — The Reading surface's optional vocabulary cue over a **Chapter**'s word spans, in three modes: 标生词 (default; a soft underline on words present in the dictionary and not yet marked 我认识), 淡已认识 (known words dimmed), and 关. Presence is resolved by lazy batch checks for visible sentences (`POST /lookup/check`), never by baking at upload time; the mode is a per-Profile preference (`/state`'s `hl_mode`).
- **Dictionary form resolution** — The server's lookup chain (ADR 0008): English resolves by lowercase exact match with mechanical lemma fallback (suffix strips); Japanese walks surface → normalized → dictionary form → reading (Sudachi) with a single-kanji KANJIDIC2 fallback; other languages miss for now (zh stays reserved for the future Chinese effort).
- **生僻字 (rare character)** — A Han character outside everyday literacy, which common fonts and ordinary dictionaries may not cover. The quality bar for this project is that such characters can be *displayed*, *looked up*, and *read aloud*.

## Terms we avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| `phrase`, `clause`, `line` | `sentence` | The UI and splitter operate on sentence boundaries. |
| `player screen`, `listen screen` | `Reading area` | The reading surface is the Reading area. |
| `speed` | `rate` | Matches SSML parameter naming. |
| `offline TTS`, `on-device synthesis` | — | Out of scope; do not imply it exists. |
| `offline mode`, `offline playback` | `offline replay` | Only replays previously fetched audio; never arbitrary text without network. |
| `account`, `login`, `user` | `Profile` | No authentication exists: a Profile is only *who is reading*; passwords and permissions are out of scope. |
| `starred`, `bookmarked` | — | Out of scope; the star flag is called **Favorite**. |
| `offline replay`, `offline mode`, `device cache` | — | Removed (ADR 0007): the browser keeps no learner state and no audio. |
| `translation`, `furigana`, `quiz` | — | Out of scope. |
