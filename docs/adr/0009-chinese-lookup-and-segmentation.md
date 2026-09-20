# Chinese books: jieba word spans and a CC-CEDICT + Unihan lookup dictionary

ADR 0008 scoped the lookup map to English/Japanese and left zh "reserved for a
future Chinese effort". That effort is now started (ticket #21, acceptance
sample 《红楼梦》), and it ships three decisions: the tokenizer for Chinese
word spans, the dictionary sources behind `zh.sqlite`, and what deliberately
stays out (OpenCC, a zh TTS replacement table).

## Context

The research ticket #10 measured the Chinese data plane against the Project
Gutenberg 紅樓夢 epub (#24264, traditional, `．` U+FF0E used 21,290× as its
period): CC-CEDICT covers 4,259 of 4,268 distinct Han characters (9 misses +
5 non-BMP characters), Unihan `kMandarin` covers 100% of them, Edge TTS
misreads 9 rare characters (多音字 selection) and cannot take SSML hints, and
the transcription is a mixed tradition (4.46% simplified glyphs). The
dictionary runtime (ADR 0008) is read-only SQLite under `<data-dir>/dicts/`;
japanese word spans come from Sudachi (ADR 0007). The 主控 chose jieba for
Chinese word segmentation when asked.

## Decision

- **Word spans**: `tokenize_zh` runs jieba through a dedicated `Tokenizer`
  instance, lazily initialized under the same lock pattern as Sudachi (its
  `initialize()` is the thread-unsafe part). Injected as the `zh_tokenizer`
  seam, mirroring `ja_tokenizer`; a partition mismatch falls back to the rule
  tokenizer. **OpenCC 繁→简 is rejected inside the parse pipeline**: 繁→简
  conversion is not length-preserving across strings, so spans could not be
  mapped back onto the original text. Traditional books therefore tokenize
  per character more often — measured multi-character share ≈49% on the PG
  traditional text vs ≈48% on its simplified projection, so the degradation
  is negligible — and their single characters still resolve through the
  dictionary.
- **Dictionary**: `zh.sqlite` is built by `server/tools/build_dicts.py` from
  CC-CEDICT (MDBG daily export, CC BY-SA 4.0) plus Unihan (`Unihan_Readings.txt`:
  `kMandarin` + `kDefinition`). CC-CEDICT stores the traditional and
  simplified form of every entry in one row, so mixed-tradition text
  exact-matches either tradition without conversion; the **Word key is the
  simplified form** (`zh:宝玉`), so 我认识 marks share across traditions. The
  numbered pinyin is converted to tone-marked pinyin for the card's 读音. A
  single-Han-character miss falls back to the `hanzi` table (Unihan) — the zh
  counterpart of the ja KANJIDIC2 fallback, keeping 生僻字 lookable-up. There
  is no lemma chain: Chinese has no inflection, exact match suffices.
- **Sentence splitting**: Chinese always breaks at a terminator (like
  Japanese, no capitalization check): `。！？!?…` **plus `．`(U+FF0E)**, the
  PG transcription's period.
- **TTS**: zh stays a passthrough in the reading normalization stage. The
  Edge fallback keeps its 9 measured misreads of rare characters (拚 薵 琠 銋
  敠 蠀 怴 怚 𣬶); a zh replacement table and Azure's
  `<phoneme alphabet="sapi">` injection (documented, never empirically
  verified — §5.5 of research/rare-hanzi.md holds the 15-minute verification
  recipe) are deferred until a real 红楼梦 edition demands them and a key
  exists.

## Consequences

- `jieba==0.42.1` joins `server/requirements.txt`; zh.sqlite ≈ 17.5 MB
  (en+ja+kanji+zh ≈ 150 MB total, `scripts/deploy.sh` syncs or rebuilds it on
  claw).
- Proper names (宝玉 除外, e.g. 贾雨村/刘姥姥/黛玉) are absent from CC-CEDICT:
  the card shows 「词典里没有这个词。」 and the AI tab is the intended
  supplement; measured token hit rate over a chapter is ~46–70% depending on
  the sample, dominated by names and colloquial compounds.
- The frontend needed no structural change (`zh` flows through the generic
  Word key / check paths); the only code change was making reading-only
  (Unihan) cards markable 我认识.
