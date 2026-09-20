"""Sentence splitting and per-sentence word annotation for parsed Books.

The server bakes sentence boundaries and word boundaries into chapter JSON so
Reading positions and Lookups are stable across devices and browsers (ADR
0007): the browser does no segmentation of book text.

- Japanese goes through SudachiPy (`split_sentences` + `annotate`). Sudachi
  caps one input at 49,149 utf-8 bytes, so sentences longer than that are fed
  to it in chunks.
- Chinese goes through jieba (`tokenize_zh`, no ruby — readings belong to the
  zh lookup card); traditional text degrades to single characters, which the
  zh dictionary still resolves per character (its forms table carries both
  the traditional and the simplified form).
- Other languages use a rule tokenizer: Latin/number runs are words, CJK
  characters are one-character words, everything in between (spaces,
  punctuation) is its own segment, so the length array always reconstructs
  the sentence exactly.

All tokenizers produce the same shape: a `w` list of segment lengths whose
sum is `len(t)` and a `ruby` list of `[start, length, reading]` annotations
(empty outside Japanese).
"""

import re
import threading

# Mirrors MAX_SENTENCE_LENGTH in web/js/core/segmentation.js: sentence cards
# (and the 500-character TTS limit behind them) rely on overlong or
# unpunctuated text being cut into chunks.
MAX_SENTENCE_CHARS = 250

# SudachiPy refuses any single input above this many utf-8 bytes.
MAX_SUDACHI_BYTES = 49149

KANJI_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

_JA_TERMINATORS = "。！？!?…"
# 红楼梦 editions vary: the PG transcription (issue #10) uses `．`(U+FF0E)
# 21,290 times as its period against `。` 7,886 times.
_ZH_TERMINATORS = "。！？!?…．"
_EN_TERMINATORS = ".!?…"
# Characters that may follow a terminator and still belong to the sentence.
_CLOSERS = "\"'”’»)]}」』）】》〉〕"
# Characters a sentence may open with; the uppercase lookahead skips them.
_OPENERS = "\"'“‘«([「『（【《〈"

_EN_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "no",
    "fig", "vol", "ch", "p", "pp", "inc", "ltd", "co", "approx", "dept",
}

# Latin/number words (with internal apostrophes/hyphens) plus single CJK
# characters. Everything else is emitted as its own segment.
_RULE_WORD_RE = re.compile(
    r"[A-Za-z0-9]+(?:['’’\-][A-Za-z0-9]+)*"
    r"|[\u3400-\u9fff\u3040-\u30ff\uff66-\uff9f]"
)

_HIRAGANA_START = 0x3041
_KATAKANA_START = 0x30A1
_KATAKANA_END = 0x30F6


class TokenizerUnavailable(RuntimeError):
    """Raised when Japanese text needs SudachiPy but it is not installed."""


_tokenizer_lock = threading.Lock()
_tokenizer = None
_jieba_tokenizer = None


def _sudachi():
    """Lazily build the shared Sudachi tokenizer. Importing sudachipy at module
    import time would make every server start (and every test run) depend on
    the dictionary even when no Japanese book is parsed."""
    global _tokenizer
    if _tokenizer is None:
        with _tokenizer_lock:
            if _tokenizer is None:
                try:
                    from sudachipy import Dictionary, SplitMode
                except ImportError as error:  # pragma: no cover - env dependent
                    raise TokenizerUnavailable(
                        "sudachipy is required to parse Japanese books "
                        "(pip install -r server/requirements.txt)"
                    ) from error
                _tokenizer = (Dictionary().create(), SplitMode.C)
    return _tokenizer


def _is_ja(lang):
    return str(lang or "").lower().startswith("ja")


def _is_zh(lang):
    return str(lang or "").lower().startswith("zh")


def split_sentences(text, lang="en"):
    """Split `text` into sentences. Paragraph breaks (newlines) are
    boundaries; within a paragraph, terminators end a sentence. Japanese and
    Chinese always break at a terminator (scripts have no capitalization to
    check); other languages break only when the next non-space character
    starts a new sentence. Sentences longer than MAX_SENTENCE_CHARS are cut
    into fixed-length chunks."""
    if not text:
        return []
    if _is_ja(lang):
        terminators, always_break = _JA_TERMINATORS, True
    elif _is_zh(lang):
        terminators, always_break = _ZH_TERMINATORS, True
    else:
        terminators, always_break = _EN_TERMINATORS, False
    sentences = []
    for paragraph in text.split("\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        for sentence in _split_paragraph(paragraph, terminators, always_break):
            sentences.extend(_chunk_overlong(sentence))
    return sentences


def annotate(sentence, lang="en", ja_tokenizer=None, zh_tokenizer=None):
    """Word-length array + ruby annotations for one sentence.

    `ja_tokenizer` / `zh_tokenizer` are the parse pipeline's injectable seams
    (default to `tokenize_ja` / `tokenize_zh`). Returns `{"t", "w", "ruby"}`;
    `sum(w) == len(t)` always holds — a tokenizer that does not partition the
    sentence falls back to the rule tokenizer rather than emit an annotation
    the client cannot index."""
    if _is_ja(lang):
        lengths, ruby = (ja_tokenizer or tokenize_ja)(sentence)
    elif _is_zh(lang):
        lengths, ruby = (zh_tokenizer or tokenize_zh)(sentence)
    else:
        lengths, ruby = tokenize_rule(sentence)
    if sum(lengths) != len(sentence):
        lengths, ruby = tokenize_rule(sentence)
    return {"t": sentence, "w": lengths, "ruby": ruby}


def tokenize_rule(text):
    """Rule tokenizer for non-Japanese text: `w` partitions the sentence into
    word and separator segments."""
    lengths = []
    position = 0
    for match in _RULE_WORD_RE.finditer(text):
        if match.start() > position:
            lengths.append(match.start() - position)
        lengths.append(match.end() - match.start())
        position = match.end()
    if position < len(text):
        lengths.append(len(text) - position)
    return lengths, []


def tokenize_zh(text):
    """jieba tokenization for Chinese: word-length segments, no ruby. Uses a
dedicated Tokenizer instance (`_jieba`) so the shared dictionary never
touches jieba's global state; `initialize()` is jieba's thread-unsafe part
and runs once under the module lock, `cut()` only reads afterwards."""
    tokenizer = _jieba()
    lengths = [len(word) for word in tokenizer.cut(text)]
    if sum(lengths) != len(text):
        return tokenize_rule(text)
    return lengths, []


def _jieba():
    """Lazily build the shared jieba tokenizer — the same lazy-lock pattern
as `_sudachi`: no module import of jieba at import time, so server starts
(and test runs) never depend on the dependency being present until a
Chinese book is actually parsed."""
    global _jieba_tokenizer
    if _jieba_tokenizer is None:
        with _tokenizer_lock:
            if _jieba_tokenizer is None:
                try:
                    import jieba
                except ImportError as error:  # pragma: no cover - env dependent
                    raise TokenizerUnavailable(
                        "jieba is required to parse Chinese books "
                        "(pip install -r server/requirements.txt)"
                    ) from error
                tokenizer = jieba.Tokenizer()
                tokenizer.initialize()
                _jieba_tokenizer = tokenizer
    return _jieba_tokenizer


def tokenize_ja(text, max_bytes=MAX_SUDACHI_BYTES):
    """Sudachi tokenization with ruby readings for kanji-bearing tokens.
    Input is chunked to stay under Sudachi's per-call byte limit."""
    tokenizer, split_mode = _sudachi()
    lengths = []
    ruby = []
    offset = 0
    for chunk in _utf8_chunks(text, max_bytes):
        tokens = tokenizer.tokenize(chunk, split_mode)
        for token in tokens:
            surface = token.surface()
            length = len(surface)
            lengths.append(length)
            if KANJI_RE.search(surface):
                reading = _katakana_to_hiragana(token.reading_form())
                ruby.append([offset, length, reading])
            offset += length
    if sum(lengths) != len(text):
        return tokenize_rule(text)
    return lengths, ruby


def _split_paragraph(paragraph, terminators, always_break):
    sentences = []
    start = 0
    index = 0
    length = len(paragraph)
    while index < length:
        char = paragraph[index]
        if char not in terminators:
            index += 1
            continue
        end = _consume_terminators(paragraph, index, terminators)
        if not always_break:
            next_index = end
            while next_index < length and paragraph[next_index].isspace():
                next_index += 1
            if next_index < length and not _starts_new_sentence(paragraph, index, next_index):
                index = end
                continue
        sentence = paragraph[start:end].strip()
        if sentence:
            sentences.append(sentence)
        if always_break:
            start = end
        else:
            start = next_index
        index = start
    tail = paragraph[start:].strip()
    if tail:
        sentences.append(tail)
    return sentences


def _consume_terminators(paragraph, index, terminators):
    """Advance past a run of terminators plus closing quotes/brackets."""
    length = len(paragraph)
    end = index
    while end < length and (
        paragraph[end] in terminators or paragraph[end] in _CLOSERS
    ):
        end += 1
    return end


def _starts_new_sentence(paragraph, terminator_index, next_index):
    """English lookahead: only break when the next non-space character starts a
    new sentence (uppercase or an opening quote), and never after an
    abbreviation or an initialism like U.S.A."""
    if paragraph[terminator_index] == ".":
        if re.search(r"(?:[A-Za-z]\.){2,}$", paragraph[:terminator_index + 1]):
            return False
        # Initialism still being spelled out: "U.S.A." has no space between
        # the period, the next letter, and its own period.
        if (
            terminator_index + 2 < len(paragraph)
            and paragraph[terminator_index + 1].isalpha()
            and paragraph[terminator_index + 2] == "."
        ):
            return False
        word = re.search(r"([A-Za-z]+)$", paragraph[:terminator_index])
        if word and word.group(1).lower() in _EN_ABBREVIATIONS:
            return False
    while next_index < len(paragraph) and paragraph[next_index] in _OPENERS:
        next_index += 1
    if next_index >= len(paragraph):
        return True
    return paragraph[next_index].isupper()


def _chunk_overlong(text, max_chars=MAX_SENTENCE_CHARS):
    if len(text) <= max_chars:
        return [text]
    chunks = []
    for start in range(0, len(text), max_chars):
        chunk = text[start:start + max_chars].strip()
        if chunk:
            chunks.append(chunk)
    return chunks


def _utf8_chunks(text, max_bytes):
    """Yield substrings whose utf-8 encoding is at most max_bytes. Always
    makes progress, even for a single character bigger than max_bytes."""
    index = 0
    length = len(text)
    while index < length:
        size = 0
        end = index
        while end < length:
            width = len(text[end].encode("utf-8"))
            if size + width > max_bytes:
                break
            size += width
            end += 1
        if end == index:
            end = index + 1
        yield text[index:end]
        index = end


def _katakana_to_hiragana(text):
    return "".join(
        chr(ord(char) - (0x60)) if _KATAKANA_START <= ord(char) <= _KATAKANA_END else char
        for char in text
    )
