/**
 * TTS exception — the error vocabulary shared by backend and frontend
 * (the backend returns these codes as JSON). ViewModels map codes to
 * learner-facing strings via ttsErrorToMessage.
 */

export const TTS_ERROR_CODES = Object.freeze({
  EMPTY_TEXT: 'empty_text',
  TEXT_TOO_LONG: 'text_too_long',
  INVALID_VOICE: 'invalid_voice',
  INVALID_RATE: 'invalid_rate',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  UPSTREAM_TIMEOUT: 'upstream_timeout',
  NETWORK_FAILURE: 'network_failure',
  UNKNOWN: 'unknown',
});

/** Learner-facing wording per TTS exception code. */
const ERROR_MESSAGES = {
  [TTS_ERROR_CODES.EMPTY_TEXT]: 'Selected sentence is empty.',
  [TTS_ERROR_CODES.TEXT_TOO_LONG]: 'Sentence is too long.',
  [TTS_ERROR_CODES.INVALID_VOICE]: 'Voice is not available.',
  [TTS_ERROR_CODES.INVALID_RATE]: 'Playback rate is invalid.',
  [TTS_ERROR_CODES.NETWORK_FAILURE]: 'Check your connection.',
  [TTS_ERROR_CODES.UPSTREAM_UNAVAILABLE]: 'Service is temporarily unavailable. Try again later.',
  [TTS_ERROR_CODES.UPSTREAM_TIMEOUT]: 'Service is temporarily unavailable. Try again later.',
  [TTS_ERROR_CODES.UNKNOWN]: 'Something went wrong. Please try again.',
};

/**
 * Maps a backend error code to the learner-facing string.
 * @param {string} code — one of TTS_ERROR_CODES
 * @returns {string}
 */
export function ttsErrorToMessage(code) {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[TTS_ERROR_CODES.UNKNOWN];
}

/**
 * API error — the same `{"error": code}` shape for the Book and Profile
 * endpoints (ADR 0007) and the lookup / AI layer (ADR 0008):
 * `bad_request`, `profile_not_found`, `book_not_found`, `chapter_not_found`,
 * `entry_not_found`, `not_found`, `too_large`, `not_epub`, `parse_failed`,
 * `lookup_unavailable`, `ai_not_configured`, `ai_upstream_error`, `ai_timeout`
 * (plus `unknown` and the TTS exception codes), and Chat (ticket #47):
 * `conversation_not_found`, `ai_usage_limit`.
 * The fixed NotebookLM StudyJob failures are
 * (`notebooklm_not_configured`, `notebooklm_auth_required`,
 * `notebooklm_unavailable`, `notebooklm_quota`, `notebooklm_source_rejected`,
 * `notebooklm_job_unknown`, and `artifact_download_failed`).
 */
export const API_ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  PROFILE_NOT_FOUND: 'profile_not_found',
  BOOK_NOT_FOUND: 'book_not_found',
  CHAPTER_NOT_FOUND: 'chapter_not_found',
  ENTRY_NOT_FOUND: 'entry_not_found',
  NOT_FOUND: 'not_found',
  TOO_LARGE: 'too_large',
  NOT_EPUB: 'not_epub',
  PARSE_FAILED: 'parse_failed',
  LOOKUP_UNAVAILABLE: 'lookup_unavailable',
  AI_NOT_CONFIGURED: 'ai_not_configured',
  AI_UPSTREAM_ERROR: 'ai_upstream_error',
  AI_TIMEOUT: 'ai_timeout',
  CONVERSATION_NOT_FOUND: 'conversation_not_found',
  AI_USAGE_LIMIT: 'ai_usage_limit',
  CLOUD_CONFIRMATION_REQUIRED: 'cloud_confirmation_required',
  NOTEBOOKLM_NOT_CONFIGURED: 'notebooklm_not_configured',
  NOTEBOOKLM_AUTH_REQUIRED: 'notebooklm_auth_required',
  NOTEBOOKLM_UNAVAILABLE: 'notebooklm_unavailable',
  NOTEBOOKLM_QUOTA: 'notebooklm_quota',
  NOTEBOOKLM_SOURCE_REJECTED: 'notebooklm_source_rejected',
  NOTEBOOKLM_JOB_UNKNOWN: 'notebooklm_job_unknown',
  ARTIFACT_DOWNLOAD_FAILED: 'artifact_download_failed',
  NOTEBOOK_REF_NOT_FOUND: 'notebook_ref_not_found',
});

/** Learner-facing wording per API error code. */
const API_ERROR_MESSAGES = {
  [API_ERROR_CODES.BAD_REQUEST]: '请求格式不对。',
  [API_ERROR_CODES.PROFILE_NOT_FOUND]: '找不到这个档案——刷新后重新选择。',
  [API_ERROR_CODES.BOOK_NOT_FOUND]: '书不存在或已失效。',
  [API_ERROR_CODES.CHAPTER_NOT_FOUND]: '章节不存在。',
  [API_ERROR_CODES.ENTRY_NOT_FOUND]: '词典里没有这个词。',
  [API_ERROR_CODES.NOT_FOUND]: '请求的内容不存在。',
  [API_ERROR_CODES.TOO_LARGE]: '文件太大（epub 上限 100MB）。',
  [API_ERROR_CODES.NOT_EPUB]: '这不是一个 epub 文件。',
  [API_ERROR_CODES.PARSE_FAILED]: '这本 epub 无法解析。',
  [API_ERROR_CODES.LOOKUP_UNAVAILABLE]: '词典还没有就绪。',
  [API_ERROR_CODES.AI_NOT_CONFIGURED]: '未配置 AI 解释。',
  [API_ERROR_CODES.AI_UPSTREAM_ERROR]: 'AI 服务暂时不可用。',
  [API_ERROR_CODES.AI_TIMEOUT]: 'AI 响应超时，可在本卡内重试。',
  [API_ERROR_CODES.CONVERSATION_NOT_FOUND]: '这段对话不存在了。',
  // ADR 0013: 用量受限, never "quota exhausted" — the wall and a transient
  // throttle are indistinguishable, so the copy stays calm.
  [API_ERROR_CODES.AI_USAGE_LIMIT]: 'AI 用量受限，请稍后再试。',
  [API_ERROR_CODES.CLOUD_CONFIRMATION_REQUIRED]: '整本书需要明确确认后才会发送到云端处理。',
  [API_ERROR_CODES.NOTEBOOKLM_NOT_CONFIGURED]: 'NotebookLM 尚未配置；本地阅读不受影响。',
  [API_ERROR_CODES.NOTEBOOKLM_AUTH_REQUIRED]: 'NotebookLM 需要重新登录；本地阅读不受影响。',
  [API_ERROR_CODES.NOTEBOOKLM_UNAVAILABLE]: 'NotebookLM 暂时不可用；本地阅读不受影响。',
  [API_ERROR_CODES.NOTEBOOKLM_QUOTA]: 'NotebookLM 当前用量受限，请稍后再试。',
  [API_ERROR_CODES.NOTEBOOKLM_SOURCE_REJECTED]: 'NotebookLM 未能处理这本书或所选范围。',
  [API_ERROR_CODES.NOTEBOOKLM_JOB_UNKNOWN]: '远端结果未知；不会自动重复生成。',
  [API_ERROR_CODES.ARTIFACT_DOWNLOAD_FAILED]: '产物下载失败；本地阅读不受影响。',
  [API_ERROR_CODES.NOTEBOOK_REF_NOT_FOUND]: '请先明确确认并同步这本书到 NotebookLM。',
};

/**
 * Maps a backend error code to the learner-facing string.
 * @param {string} code — one of API_ERROR_CODES
 * @returns {string}
 */
export function apiErrorToMessage(code) {
  return API_ERROR_MESSAGES[code] ?? API_ERROR_MESSAGES[API_ERROR_CODES.NOT_FOUND] ?? '请求的内容不存在。';
}
