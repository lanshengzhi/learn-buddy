/**
 * ReaderController — the Reading area's playback state machine: sentence
 * selection, the audio job loop, Loop-all / Loop-one / Off, Rate preset
 * restart semantics, pause/resume, and TTS error mapping. DOM-free:
 * playback and TTS are injected adapters, so the whole machine is
 * node-testable.
 *
 * Deliberate deviation (fetch model): pausing while audio is *loading*
 * cancels the fetch and clears the playing sentence, leaving it selected —
 * Play restarts it. The playing index stays set in that transient state,
 * which the player can't resume anyway.
 */

import { detectLanguage, defaultVoiceFor } from './language.js';
import { nextLoopMode, LoopMode } from './loop-mode.js';
import { DEFAULT_RATE_PRESET } from './rate-presets.js';
import { TTS_ERROR_CODES, ttsErrorToMessage } from './errors.js';
import { TtsClientError } from './tts-client.js';

export class ReaderController {
  /**
   * @param {object} deps
   * @param {import('./segmentation.js').SegmentationService} deps.segmentation — { segment(text, locale) }
   * @param {object} deps.tts — { speak({text, voice, rate, signal}) -> Promise<Blob> }
   * @param {object} deps.player — { play(blobUrl) -> Promise, pause(), resume(), stop() }
   * @param {object} deps.prefs — { ratePreset(), loopMode(), saveRatePreset(p), saveLoopMode(m) }
   * @param {(blob: Blob) => string} [deps.makeObjectUrl=URL.createObjectURL]
   * @param {(url: string) => void} [deps.revokeObjectUrl=URL.revokeObjectURL]
   * @param {(index: number) => void} [deps.onHistoryProgress]
   * @param {(state: object) => void} [deps.onStateChange] — fired after every state mutation
   */
  constructor({ segmentation, tts, player, prefs, makeObjectUrl, revokeObjectUrl, onHistoryProgress, onStateChange }) {
    this.segmentation = segmentation;
    this.tts = tts;
    this.player = player;
    this.prefs = prefs;
    this.makeObjectUrl = makeObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.onHistoryProgress = onHistoryProgress ?? (() => {});
    this.onStateChange = onStateChange ?? (() => {});

    this.state = {
      sentences: [],
      selectedSentenceIndex: null,
      playingSentenceIndex: null,
      isLoading: false,
      isAudioLoading: false,
      isAudioPaused: false,
      loopMode: prefs.loopMode(),
      ratePreset: prefs.ratePreset(),
      errorMessage: null,
    };

    this.currentText = '';
    this.#generation = 0;
    this.#abort = null;
    this.#currentObjectUrl = null;
  }

  /**
   * Segments text into sentences; the first sentence (or a valid initial
   * index, e.g. restored from History) becomes the selected sentence.
   */
  async loadText(text, initialSelectedIndex = -1) {
    this.currentText = text;
    this.#set({ isLoading: true, errorMessage: null });
    try {
      const locale = detectLanguage(text);
      const sentences = this.segmentation
        .segment(text, locale)
        .map((sentenceText, index) => ({ index, text: sentenceText }));
      const selectedIndex = sentences.some((s) => s.index === initialSelectedIndex)
        ? initialSelectedIndex
        : sentences.length > 0
          ? sentences[0].index
          : null;
      this.#set({ sentences, isLoading: false, selectedSentenceIndex: selectedIndex });
      this.#progress(selectedIndex);
    } catch {
      this.#set({ isLoading: false, errorMessage: 'Could not split text into sentences.' });
    }
  }

  onSentenceClicked(index) {
    const sentence = this.#sentenceAt(index);
    if (sentence) this.#startAudioJob(sentence);
  }

  onPlayClicked() {
    const sentence = this.#sentenceAt(this.state.selectedSentenceIndex);
    if (sentence) this.#startAudioJob(sentence);
  }

  onReplayClicked() {
    const sentence = this.#sentenceAt(this.state.selectedSentenceIndex);
    if (sentence) this.#startAudioJob(sentence);
  }

  onNextClicked() {
    const { sentences } = this.state;
    if (sentences.length === 0) return;
    const currentPos = this.state.selectedSentenceIndex != null
      ? this.#positionOf(this.state.selectedSentenceIndex)
      : -1;
    const nextPos = Math.min(currentPos + 1, sentences.length - 1);
    this.#startAudioJob(sentences[nextPos]);
  }

  onPreviousClicked() {
    const { sentences } = this.state;
    if (sentences.length === 0) return;
    if (this.state.selectedSentenceIndex == null) return;
    const currentPos = this.#positionOf(this.state.selectedSentenceIndex);
    if (currentPos < 0) return;
    const previousPos = Math.max(currentPos - 1, 0);
    this.#startAudioJob(sentences[previousPos]);
  }

  onPauseClicked() {
    if (this.state.isAudioPaused) {
      this.player.resume();
      this.#set({ isAudioPaused: false });
    } else if (this.state.isAudioLoading) {
      this.#cancelJob();
      this.player.stop();
      this.#set({ isAudioLoading: false, playingSentenceIndex: null });
    } else {
      this.player.pause();
      this.#set({ isAudioPaused: true });
    }
  }

  onLoopToggleClicked() {
    // The toggle is the single authority over the playback mode. Switching
    // mid-playback never interrupts the current sentence: the new state
    // applies when it finishes.
    const nextMode = nextLoopMode(this.state.loopMode);
    this.#set({ loopMode: nextMode });
    this.prefs.saveLoopMode(nextMode);
  }

  /**
   * Selects a Rate preset. Presets are synthesized server-side (SSML rate),
   * so any in-flight work — playing, loading, or paused — is cancelled and
   * the current sentence restarts at the new rate. When nothing is active,
   * the preset simply applies to the next play.
   */
  onRateSelected(preset) {
    const wasActive = this.state.playingSentenceIndex != null ||
      this.state.isAudioLoading ||
      this.state.isAudioPaused;
    this.#set({ ratePreset: preset });
    this.prefs.saveRatePreset(preset);
    if (wasActive) {
      const sentence = this.#sentenceAt(this.state.selectedSentenceIndex);
      if (sentence) this.#startAudioJob(sentence);
    }
  }

  dispose() {
    this.#cancelJob();
    this.player.stop();
    this.#set({ playingSentenceIndex: null, isAudioLoading: false, isAudioPaused: false });
  }

  // --- internals -----------------------------------------------------------

  #generation = 0;
  #abort = null;
  #currentObjectUrl = null;

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.state);
  }

  #progress(index) {
    if (index != null) this.onHistoryProgress(index);
  }

  #sentenceAt(index) {
    return this.state.sentences.find((s) => s.index === index) ?? null;
  }

  #positionOf(index) {
    return this.state.sentences.findIndex((s) => s.index === index);
  }

  #sentenceAfter(sentence) {
    const { sentences } = this.state;
    if (sentences.length === 0) return null;
    const position = this.#positionOf(sentence.index);
    if (position < 0) return null;
    return sentences[(position + 1) % sentences.length];
  }

  /** Cancels the in-flight job (fetch + playback) and revokes the object URL. */
  #cancelJob() {
    this.#generation += 1;
    if (this.#abort) {
      this.#abort.abort();
      this.#abort = null;
    }
    if (this.#currentObjectUrl != null) {
      this.revokeObjectUrl(this.#currentObjectUrl);
      this.#currentObjectUrl = null;
    }
  }

  #startAudioJob(sentence) {
    this.#cancelJob();
    this.player.stop();
    void this.#runAudioLoop(sentence);
  }

  async #runAudioLoop(startSentence) {
    const gen = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    let current = startSentence;
    try {
      while (current && this.#generation === gen) {
        const target = current;
        this.#set({
          selectedSentenceIndex: target.index,
          playingSentenceIndex: target.index,
          isAudioLoading: true,
          isAudioPaused: false,
          errorMessage: null,
        });
        this.#progress(target.index);
        const locale = detectLanguage(target.text);
        const blob = await this.tts.speak({
          text: target.text,
          voice: defaultVoiceFor(locale),
          rate: this.state.ratePreset.ssmlRate,
          signal: abort.signal,
        });
        if (this.#generation !== gen) return;
        const url = this.makeObjectUrl(blob);
        this.#currentObjectUrl = url;
        this.#set({ isAudioLoading: false });
        await this.player.play(url);
        if (this.#generation !== gen) return;
        if (this.#currentObjectUrl === url) {
          this.revokeObjectUrl(url);
          this.#currentObjectUrl = null;
        }
        current = this.#nextTarget(target);
      }
      if (this.#generation === gen) {
        this.#set({ playingSentenceIndex: null, isAudioPaused: false });
      }
    } catch (error) {
      if (this.#generation !== gen || error.name === 'AbortError') return;
      this.#set({
        playingSentenceIndex: null,
        isAudioLoading: false,
        isAudioPaused: false,
        errorMessage: this.#mapError(error),
      });
    }
  }

  /** Advances the loop; null ends playback (Loop Off). */
  #nextTarget(justPlayed) {
    switch (this.state.loopMode) {
      case LoopMode.All:
        return this.#sentenceAfter(justPlayed);
      case LoopMode.One:
        return justPlayed;
      default:
        return null;
    }
  }

  #mapError(error) {
    if (error instanceof TtsClientError) return ttsErrorToMessage(error.code);
    return `Playback failed: ${error.message ?? error}`;
  }
}
