/**
 * HtmlAudioPlayer — the browser audio adapter behind the ReaderController's
 * injected player. play(url) resolves when playback reaches 'ended',
 * rejects on playback errors, and resolves with null when cancelled via
 * stop() (e.g. a rate change or navigation).
 */

export class HtmlAudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this._resolvePlay = null;
    this._rejectPlay = null;
  }

  /** Starts (or restarts) playback of a blob URL; resolves on 'ended'. */
  play(url) {
    return new Promise((resolve, reject) => {
      this._resolvePlay = resolve;
      this._rejectPlay = reject;
      this.audio.src = url;

      const onEnded = () => {
        this.#clearHandlers();
        const resolveEnd = this._resolvePlay;
        this._resolvePlay = null;
        this._rejectPlay = null;
        if (resolveEnd) resolveEnd();
      };
      const onError = () => {
        this.#clearHandlers();
        const rejectPlay = this._rejectPlay;
        this._resolvePlay = null;
        this._rejectPlay = null;
        if (rejectPlay) rejectPlay(new Error('Audio playback failed'));
      };
      this.audio.addEventListener('ended', onEnded, { once: true });
      this.audio.addEventListener('error', onError, { once: true });
      this.audio.play().catch((error) => {
        this.#clearHandlers();
        const rejectPlay = this._rejectPlay;
        this._resolvePlay = null;
        this._rejectPlay = null;
        if (rejectPlay) rejectPlay(error);
      });
    });
  }

  #clearHandlers() {
    // 'ended'/'error' handlers were registered with { once: true } and fire
    // exactly once; nothing further to clear.
  }

  pause() {
    this.audio.pause();
  }

  resume() {
    this.audio.play().catch(() => {
      // Resume can fail under autoplay policy edge cases; the next user
      // gesture retries. Real-device acceptance covers this.
    });
  }

  /** Cancels the current play promise (resolves null); used on restart. */
  stop() {
    this.audio.pause();
    if (this._resolvePlay) {
      const resolve = this._resolvePlay;
      this._resolvePlay = null;
      this._rejectPlay = null;
      resolve(null);
    }
  }

  release() {
    this.stop();
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
