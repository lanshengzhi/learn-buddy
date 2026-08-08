/**
 * TTS client — the browser side of the TTS API contract
 * (`GET /tts?text&voice&rate` → MP3 blob, ADR 0001). Errors surface as
 * backend JSON codes mapped through errors.js; network-level failures map
 * to network_failure, unknown bodies to unknown.
 */

import { TTS_ERROR_CODES } from './errors.js';

export class TtsClientError extends Error {
  constructor(code, message = '') {
    super(message);
    this.code = code;
  }
}

export class TtsClient {
  /**
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchImpl] — seam for tests
   * @param {string} [options.baseUrl] — origin prefix, default '' (same origin)
   */
  constructor({ fetchImpl, baseUrl = '' } = {}) {
    // Bind fetch: a bare `fetch` reference loses its receiver when stored
    // and called as a method ("Illegal invocation").
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.baseUrl = baseUrl;
  }

  /**
   * Requests spoken audio for a sentence.
   * @param {object} request
   * @param {string} request.text — trimmed, ≤500 chars (enforced server-side)
   * @param {string} request.voice — neural voice name (short form)
   * @param {string} request.rate — SSML rate string like '+0%'
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Blob>} audio/mpeg blob
   */
  async speak({ text, voice, rate, signal }) {
    const params = new URLSearchParams({ text, voice, rate });
    const response = await this.fetchImpl(`${this.baseUrl}/tts?${params}`, { signal });
    if (!response.ok) {
      throw new TtsClientError(await this.#errorCode(response), `TTS request failed: ${response.status}`);
    }
    return response.blob();
  }

  async #errorCode(response) {
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') return body.error;
    } catch {
      // non-JSON body — fall through
    }
    return TTS_ERROR_CODES.UNKNOWN;
  }
}

/**
 * Builds the audio request URL the Service Worker caches offline replay by
 * (the `text|voice|rate` request URL). Deterministic: URLSearchParams
 * percent-encoding is canonical.
 */
export function ttsUrl({ text, voice, rate, baseUrl = '' }) {
  const params = new URLSearchParams({ text, voice, rate });
  return `${baseUrl}/tts?${params}`;
}
