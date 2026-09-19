# 《红楼梦》生僻字实测：字集、字体、词典与 TTS 覆盖

Ticket: [#10](https://github.com/lanshengzhi/learn-buddy/issues/10) · Part of #9 · branch `research/rare-hanzi` · file `research/rare-hanzi.md`
Status: **all six required items measured**; item 5 is measured on **Edge TTS only** — no Azure Speech key
exists in this environment, so the Azure half of item 5 is **documented from Microsoft's own reference, not
empirically verified** (see §5.4 and §5.5). No application code, `CONTEXT.md` or map body was touched.

---

## 0. TL;DR — the numbers that decide scope

| Question | Measured answer |
|---|---|
| Total characters / non-whitespace characters in the sample | 901,980 / **860,953** |
| Han characters (all ideographs) | **724,669** (84.17 % of non-whitespace text) |
| Distinct Han characters | **4,268** |
| BMP URO (U+4E00–9FFF) | **724,669 = 100.000 %** of Han text (4,268 distinct) |
| Ext A (U+3400–4DBF) | **0** in the PG epub; **5 occurrences / 3 distinct** in the Wikisource 匯校本 |
| Ext B and above (U+20000+) | **0** in the PG epub; **4 occurrences / 2 distinct** in the Wikisource 匯校本 |
| Chars outside 《通用规范汉字表》一级+二级 (6,500) | 1,418 distinct, **177,368 occ. = 24.48 %** of Han text — but **1,366 of those are ordinary traditional forms**. Real out-of-scope residue: **52 distinct / 237 occ. = 0.033 %** |
| Chars outside GB2312 | 1,393 distinct / 177,264 occ. = 24.46 % (same traditional-form caveat) |
| Are those chars missing from common fonts? | **All 52 BMP ones are present in every font tested.** Only the 5 non-URO chars are missing anywhere: 䰖/䀉/㔩 (Ext A) missing from XP-era SimSun 2.10; 𣬠/𣬶 (Ext B) missing from **all six** common fonts tested |
| CC-CEDICT coverage | **4,259 / 4,268 distinct (99.9988 %)**; 9 distinct chars (9 occurrences) not found, + the 5 Wikisource-only rare chars |
| Unihan `kMandarin` coverage | **4,268 / 4,268 = 100 %**, including all 5 non-URO rare chars |
| Edge TTS on 57 out-of-scope chars (single char) | **48 correct (84 %) / 9 wrong reading (16 %) / 0 skipped** |
| Edge TTS in a carrier sentence | **all 57 pronounced** (own word boundary); only unpronounceable code points are dropped |
| Web-font cost | Noto Serif CJK SC: full **24.5 MB OTF / 8.26 MB WOFF2** → subset to the 4,473 chars actually used: **1.54 MB OTF / 1.09 MB WOFF2** (−94 %); Ext B supplement (Plangothic, 2 chars) = **904 B WOFF2** |

**Recommendation.** For a Chinese book the *display* problem is basically a non-problem (every rare BMP
character a real 红楼梦 contains is in every shipping CJK font), the *dictionary* problem is a
small residual list (≤14 chars in the whole book), and the *reading* problem is the real one: Edge TTS
misreads ≈1 in 6 of the rare characters (16 %), and no font renders the two Ext B characters at all.
The cheap, high-value moves are therefore:
1. **Do not ship a full CJK web font.** Ship a book-subset (≈1.1 MB WOFF2 for the whole book, and it drops
   further per chapter) and let the OS font handle everything else; add a ~1 KB Ext B supplement only if the
   edition has Ext B characters.
2. **Treat TTS misreads as data, not bugs** — the existing ADR 0004/0005 `JA_REPLACE_READINGS` mechanism is
   already the right shape for Chinese too; a `zh` replacement table seeded with the 9 measured misreads
   (plus human listening) is the fix. Edge TTS **cannot** take `<phoneme>` at all (measured: empty audio,
   §5.3), so on the Edge path the only lever is text rewriting — the same conclusion ADR 0004 reached for
   Japanese.
3. **Azure `<phoneme alphabet="sapi">` with pinyin is documented to work for zh-CN** (§5.4) and is the
   proper fix once a key exists — this is a 15-minute job (§5.5).

---

## 1. Sources (exact, with licence)

### 1.1 Primary sample — the epub

| | |
|---|---|
| Title | 紅樓夢 (`#24264`), Cao Xueqin / 曹雪芹 |
| Source | Project Gutenberg, https://www.gutenberg.org/ebooks/24264 |
| File used | `https://www.gutenberg.org/ebooks/24264.epub3.images` (EPUB3, 1,228,135 bytes) |
| Plain-text cross-check | `https://www.gutenberg.org/cache/epub/24264/pg24264.txt` (`pg24264.txt`) |
| Released | 2008-01-12; most recently updated 2021-12-22 |
| Credits | Wei-yi Kao |
| Language / script | `zh`, **traditional**, 120 chapters (第一回 … 第一二零回) |
| Licence | **Public domain in the USA** + Project Gutenberg License (header text shipped inside the file) |
| Base edition | **Not stated by Project Gutenberg.** No 程甲/程乙/庚辰 attribution appears in the file's header or metadata. So *no* edition-level claim is made here. |

The epub has 12 content XHTML files (`OEBPS/*24264-0-{0..11}.txt.xhtml`); file `-0-` carries the PG header
plus the start of 第一回, `-11` is the PG licence. I cut the body between the
`*** START OF THE PROJECT GUTENBERG EBOOK 紅樓夢 ***` and `*** END OF THE PROJECT GUTENBERG EBOOK 紅樓夢 ***`
markers — the same convention as the plain-text file. Both derivations agree on **724,669 Han chars and
4,268 distinct Han chars** (the raw byte counts differ by 0.5 % because of whitespace/line-break
differences in the XHTML wrapper).

**This transcription is lossy for exactly the characters under study.** 397 positions carry a `□`
(U+25A1) placeholder where the source had a character the transcriber could not encode, e.g.

* `……身上穿著縷金百蝶穿花大紅洋緞窄□襖` (the reading text is 窄**裉**襖)
* `……一邊是金□彝，一邊是玻璃□` (金**蜼**彝 … 玻璃**㝚**)
* `……頭上只散挽著\n儿` — the character was dropped outright; the Wikisource text has 散挽著**䰖**兒

So **the PG epub is a lower bound for rare characters, not a witness**. That is why a second source was used.

### 1.2 Second source — Wikisource 匯校本 (for the rare-character inventory)

| | |
|---|---|
| Title | 紅樓夢 (page + 120 subpages `紅樓夢/第001回` … `/第120回`) |
| Source | Wikimedia 維基文庫, https://zh.wikisource.org/wiki/紅樓夢 (fetched via `zh.wikisource.org/w/api.php`) |
| Edition note (from the page header) | 「这是紅樓夢（数字化文本），120回，是不包括批語的匯校本，前八十回以**庚辰本**為底本，後四十回以**程甲本**為底本」 |
| Licence | Wikimedia project content, CC BY-SA 4.0 |
| Measured | 731,616 Han chars, 4,473 distinct; 0.0012 % outside the BMP |

### 1.3 Reference data

| Dataset | Version / date | Licence | Used for |
|---|---|---|---|
| 《通用规范汉字表》 | 国务院 国发〔2013〕23号, 2013-06-05 (published 2013-08-19), https://www.gov.cn/zwgk/2013-08/19/content_2469793.htm | 国务院公告 | 一级(3500)/二级(3000)/三级(1605) membership |
| machine-readable 规范字表 | `leonsilicon/table-of-general-standard-chinese-characters` (JSON `tier1/tier2/tier3`) **and** `jaywcjlove/table-of-general-standard-chinese-characters` (`data/characters.json`, 8,105 chars) | repo licences | the two digitizations agree byte-for-byte on set membership (tier1⊂, tier2⊂, tier3⊂ the 8,105) — used as a cross-check on the official counts 3500/3000/1605 |
| GB2312 | enumerated from Python 3.14's `gb2312` codec (all 2-byte codes A1A1–F7FE) = **6,763 Han** | — | 「不在 GB2312」 |
| Unihan | **Unicode 18.0.0**, `Unihan_Readings.txt` dated 2026-07-31, https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip | Unicode Terms of Use | `kMandarin`, `kHanyuPinyin`, `kDefinition`, `kTotalStrokes`, `kSimplifiedVariant`, `kIICore` |
| CC-CEDICT | MDBG export `cedict_1_0_ts_utf-8_mdbg.zip`, downloaded 2026-09-19, 125,073 entries / 198,120 distinct headwords | **CC BY-SA 4.0** | headword coverage |
| OpenCC | system `opencc` 1.3.2 (`t2s` / `s2t` configs) | Apache-2.0 | simplified projection, trad↔simp classification |
| Fonts | see §3 | — | cmap inspection |

### 1.4 What was **not** available

* **No user book samples.** `claw:/srv/learnbuddy/books/` does not exist; `find /srv -iname '*.epub'` and a
  local search returned nothing. Ticket #13 (提供真实书样) has not been completed, so **all numbers here are
  public-sample numbers**. There are no user-file findings to separate out.
* **No `AZURE_SPEECH_KEY` anywhere** — see §5.4.

---

## 2. Item 1 — character-set distribution, with real numbers

All counts below are over the novel body only (PG header and licence excluded).

### 2.1 Han characters by Unicode block

| Block | Gutenberg epub #24264 (traditional) | Wikisource 匯校本 |
|---|---|---|
| BMP URO U+4E00–9FFF | **724,669 occ. / 4,268 distinct = 100.000 %** | 731,607 / 4,468 = 99.9988 % |
| Ext A U+3400–4DBF | 0 / 0 | **5 / 3 = 0.0007 %** |
| Ext B+ U+20000–2FFFF | 0 / 0 | **4 / 2 = 0.00055 %** |
| CJK Compatibility Ideographs U+F900–FAFF | 0 | 0 |
| **Total Han** | **724,669 / 4,268** | **731,616 / 4,473** |

The whole body of the PG epub is BMP: the largest code point anywhere in it is **U+FF1F** (fullwidth `？`).
There is no astral character at all.

The five non-URO characters in the Wikisource text, in context:

| char | U+ | block | occ. | context (Wikisource) | Unihan `kMandarin` |
|---|---|---|---|---|---|
| 䰖 | U+04C16 | Ext A | 3 | 頭上只散挽著**䰖**兒 / 頭上挽著漆黑油光的**䰖**兒 / 挽著個**䰖** | zuǎn |
| 𣬠 | U+23B20 | Ext B | 2 | 女兒樂，一根**𣬠𣬶**往裡戳 / 并沒有輸丟了**𣬠𣬶** | jī |
| 𣬶 | U+23B36 | Ext B | 2 | (same two lines) | bā |
| 䀉 | U+04009 | Ext A | 1 | 妙玉斟了一**䀉**與黛玉 | qiáo |
| 㔩 | U+03529 | Ext A | 1 | 拾翠**㔩**於塵埃 | è |

**Headline: 《红楼梦》 is a BMP-only book.** There is no extended-plane character in the PG epub, and only
9 occurrences across 731,616 Han characters in the fuller Wikisource text (0.0012 %). The "rare hanzi"
problem for this book is entirely a *rare BMP + rare reading* problem, not an astral-plane problem.

### 2.2 Non-Han characters (running text share)

| Range | occ. | share of non-whitespace text |
|---|---|---|
| URO U+4E00–9FFF (Han) | 724,669 | 84.1706 % |
| Halfwidth & Fullwidth Forms U+FF00–FFEF | 96,882 | 11.2529 % |
| General Punctuation U+2000–206F | 23,516 | 2.7314 % |
| CJK Symbols & Punctuation U+3000–303F | 8,356 | 0.9706 % |
| ASCII | 7,128 | 0.8279 % |
| other BMP | 402 | 0.0467 % |

Two transcription artefacts worth knowing about before writing any sentence splitter for this corpus:
the text uses **`．` U+FF0E 21,290 times as the sentence terminator** while `。` U+3002 appears only 7,886
times, and **`□` U+25A1 appears 397 times** (see §1.1). The most frequent characters overall are
`，` 58,958, `．` 21,290, `：` 11,654, `“` 10,929, `。` 7,886, `”` 7,779, `—` 4,738, `"` U+0022 4,642,
`？` 3,075, `！` 1,887.

### 2.3 The "out-of-scope" set (item 2)

Definition used, and why it needs two of them:

* **TGSCC 一级+二级** (6,500 chars) is a *simplified*-character table. Measured against the traditional PG
  text it flags 1,418 distinct chars / 177,368 occurrences (24.48 % of Han text) — but **1,366 of those are
  merely the traditional forms of ordinary 一级/二级 characters** (來/来, 說/说, 這/这, 寶/宝 …). That
  number is a false alarm and should not be quoted as "24 % of the book is out of scope".
* **GB2312** (6,763 Han) fails the same way for a traditional text: 1,393 distinct / 177,264 occ. (24.46 %).

The honest residue — characters that are not 一级/二级 **and** are not just the traditional form of a
一级/二级 character — is **52 distinct characters, 237 occurrences = 0.033 % of Han running text**.
Adding the 5 Wikisource-only non-URO chars gives **57 distinct characters** in total.

| # | char | U+ | occ. (PG epub) | in GB2312 | 规范字表 level | `kMandarin` | strokes | in CC-CEDICT | class |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 舖 | U+8216 | 125 | **no** | — | pù | 15 | yes | not in 规范字表 |
| 2 | 黹 | U+9EF9 | 13 | yes | 三级 | zhǐ | 12 | yes | 三级 |
| 3 | 咭 | U+54AD | 12 | yes | — | jī | 9 | yes | not in 规范字表 |
| 4 | 舡 | U+8221 | 12 | yes | — | chuán | 9 | yes | not in 规范字表 |
| 5 | 吒 | U+5412 | 6 | yes | 三级 | zhā | 6 | yes | 三级 |
| 6 | 拚 | U+62DA | 6 | yes | — | pàn | 8 | yes | not in 规范字表 |
| 7 | 揎 | U+63CE | 4 | yes | — | xuān | 12 | yes | not in 规范字表 |
| 8 | 楞 | U+695E | 4 | yes | 三级 | léng | 13 | yes | 三级 |
| 9 | 暉 | U+6689 | 3 | **no** | — | huī | 13 | yes | trad. form of 三级 |
| 10 | 蘼 | U+863C | 3 | yes | 三级 | mí | 22 | yes | 三级 |
| 11 | 鹺 | U+9E7A | 2 | **no** | — | cuó | 20 | yes | trad. form of 三级 |
| 12 | 琠 | U+7420 | 2 | **no** | — | tiǎn | 12 | yes | not in 规范字表 |
| 13 | 筅 | U+7B45 | 2 | yes | 三级 | xiǎn | 12 | yes | 三级 |
| 14 | 唪 | U+552A | 2 | yes | 三级 | fěng | 11 | yes | 三级 |
| 15 | 欹 | U+6B39 | 2 | yes | 三级 | qī | 12 | yes | 三级 |
| 16 | 翦 | U+7FE6 | 2 | yes | 三级 | jiǎn | 15 | yes | 三级 |
| 17 | 覿 | U+89BF | 2 | **no** | — | dí | 22 | yes | trad. form of 三级 |
| 18 | 囍 | U+56CD | 1 | **no** | — | xǐ | 24 | yes | not in 规范字表 |
| 19 | 衒 | U+8852 | 1 | **no** | 三级 | xuàn | 11 | yes | 三级 |
| 20 | 窶 | U+7AB6 | 1 | **no** | — | jù | 16 | yes | trad. form of 三级 |
| 21 | 唚 | U+551A | 1 | **no** | — | qìn | 10 | yes | not in 规范字表 |
| 22 | 黌 | U+9ECC | 1 | **no** | — | hóng | 24 | yes | trad. form of 三级 |
| 23 | 荈 | U+8348 | 1 | **no** | — | chuǎn | 9 | yes | not in 规范字表 |
| 24 | 薵 | U+85B5 | 1 | **no** | — | chóu | 17 | **no** | t2s → non-URO |
| 25 | 酴 | U+9174 | 1 | yes | 三级 | tú | 14 | yes | 三级 |
| 26 | 槅 | U+69C5 | 1 | **no** | — | gé | 14 | **no** | not in 规范字表 |
| 27 | 蠾 | U+883E | 1 | **no** | — | zhú | 27 | **no** | t2s → non-URO |
| 28 | 銋 | U+928B | 1 | **no** | — | rén | 14 | **no** | not in 规范字表 |
| 29 | 祕 | U+7955 | 1 | **no** | 三级 | mì | 9 | yes | 三级 |
| 30 | 敁 | U+6541 | 1 | **no** | — | diān | 9 | yes | not in 规范字表 |
| 31 | 敠 | U+6560 | 1 | **no** | — | duō | 12 | **no** | not in 规范字表 |
| 32 | 蠀 | U+8800 | 1 | **no** | — | cī | 19 | **no** | t2s → non-URO |
| 33 | 怴 | U+6034 | 1 | **no** | — | xù | 8 | **no** | not in 规范字表 |
| 34 | 峔 | U+5CD4 | 1 | **no** | — | mǔ | 9 | **no** | not in 规范字表 |
| 35 | 鬯 | U+9B2F | 1 | yes | 三级 | chàng | 10 | yes | 三级 |
| 36 | 榪 | U+69AA | 1 | **no** | — | mà | 14 | yes | trad. form of 三级 |
| 37 | 芏 | U+828F | 1 | yes | 三级 | dù | 6 | yes | 三级 |
| 38 | 鰷 | U+9C37 | 1 | **no** | — | tiáo | 21 | yes | trad. form of 三级 |
| 39 | 怚 | U+601A | 1 | **no** | — | jù | 8 | yes | not in 规范字表 |
| 40 | 醑 | U+9191 | 1 | yes | 三级 | xǔ | 16 | yes | 三级 |
| 41 | 窀 | U+7A80 | 1 | yes | 三级 | zhūn | 9 | yes | 三级 |
| 42 | 穸 | U+7A78 | 1 | yes | 三级 | xī | 8 | yes | 三级 |
| 43 | 欷 | U+6B37 | 1 | yes | — | xī | 11 | yes | not in 规范字表 |
| 44 | 芰 | U+82B0 | 1 | yes | 三级 | jì | 7 | yes | 三级 |
| 45 | 薴 | U+85B4 | 1 | **no** | — | níng | 17 | yes | trad. form of 三级 |
| 46 | 愍 | U+610D | 1 | yes | 三级 | mǐn | 13 | yes | 三级 |
| 47 | 鈽 | U+923D | 1 | **no** | — | bū | 13 | yes | not in 规范字表 |
| 48 | 揲 | U+63F2 | 1 | yes | — | dié | 12 | yes | not in 规范字表 |
| 49 | 錹 | U+9339 | 1 | **no** | — | kěn | 16 | **no** | not in 规范字表 |
| 50 | 詘 | U+8A58 | 1 | **no** | — | qū | 12 | yes | trad. form of 三级 |
| 51 | 敉 | U+6549 | 1 | yes | 三级 | mǐ | 10 | yes | 三级 |
| 52 | 祧 | U+7967 | 1 | yes | 三级 | tiāo | 10 | yes | 三级 |
| 53 | 䰖 | U+4C16 | 0 (WS only) | **no** | — | zuǎn | 16 | **no** | not in 规范字表 |
| 54 | 𣬠 | U+23B20 | 0 (WS only) | **no** | — | jī | 11 | **no** | not in 规范字表 |
| 55 | 𣬶 | U+23B36 | 0 (WS only) | **no** | — | bā | 10 | **no** | not in 规范字表 |
| 56 | 䀉 | U+4009 | 0 (WS only) | **no** | — | qiáo | 12 | **no** | not in 规范字表 |
| 57 | 㔩 | U+3529 | 0 (WS only) | **no** | — | è | 12 | **no** | not in 规范字表 |

The 52-char residue is a **flat tail**: 1 character above 100 occurrences (舖, 125), 4 above 10, and 41 of
the 52 occur exactly once in a 725k-character novel. Any UI/list built for this should therefore be
built for "a handful of one-off lookups", not for volume.

---

## 3. Item 3 — font coverage (real `cmap` data, `fontTools`)

Method: every font file was opened with `fontTools` and its Unicode `cmap` subtables unioned. Fonts were
obtained as-is from the sources below; **no glyph rasterisation, only cmap membership**, so the claim is
exactly "the font has a glyph mapped to this code point", which is what decides tofu vs no tofu.

Fonts and provenance:

| label | file | where from |
|---|---|---|
| SimSun 2.10 (XP/2000-era) | `SimSun.ttf` | `StellarCN/scp_zh` repo copy |
| SimSun 5.03 | `simsun.ttc` | widely-mirrored copy of the Windows `Simsun.ttc` (Microsoft's own font-list page names `Simsun.ttc` for the SimSun & NSimSun family: https://learn.microsoft.com/en-us/typography/font-list/simsun) |
| SimSun-ExtB 5.03 | `simsunb.ttf` | mirrored Windows `Simsunb.ttf` (same MS font-list page lists `Simsunb.ttf` as part of the family) |
| Microsoft YaHei 0.75 | `msyh.ttf` | `breezecloud/font_msyh` copy |
| PingFang SC (OTF, `17.d1e2`) | `PingFangSC-Regular.otf` | `jimmyctk/PingFang-OTF-Fonts` |
| PingFang SC (ttf, `Version 1.20 January 5, 2016`) | `PingFang-SC-Regular.ttf` | `vzxxbacq/PingFang_Font_For_Linux` |
| Noto Sans CJK SC 2.004 | TTC face #2 of `/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc` | distro `noto-cjk` package |
| Noto Serif CJK SC 2.003 | TTC face #2 of `/usr/share/fonts/noto-cjk/NotoSerifCJK-Regular.ttc` | distro `noto-cjk` package |
| Plangothic P1 6.400 (Ext B supplement, open) | `PlangothicP1-Regular.ttf` | https://github.com/Fitzgerald-Porthmouth-Koenigsegg/Plangothic_Project release V2.9.5795 |

### 3.1 Block coverage

| font (version as tested) | cmap size | URO 4E00–9FFF | Ext A 3400–4DBF | Ext B 20000–2A6DF | 䰖 U+4C16 | 𣬠𣬶 U+23B20/36 |
|---|---|---|---|---|---|---|
| SimSun (XP-era) 2.10 | 22,075 | 20,902 | **0** | 0 | **NO** | **NO** |
| SimSun 5.03 | 28,715 | 20,910 | 6,582 | 0 | yes | **NO** |
| SimSun-ExtB 5.03 | 47,293 | 0 | 0 | 42,711 | **NO** | yes |
| Microsoft YaHei 0.75 | 29,066 | 20,909 | 6,582 | 8 | yes | **NO** |
| PingFang SC (OTF, 17.d1e2) | 35,708 | 20,932 | 6,582 | 5,432 | yes | **NO** |
| PingFang SC (ttf, v1.20) | 29,923 | 20,910 | 6,582 | 289 | yes | **NO** |
| Noto Sans CJK SC 2.004 | 44,810 | 20,976 | 6,582 | 2,108 | yes | **NO** |
| Noto Serif CJK SC 2.003 | 44,777 | 20,992 | 6,592 | 2,057 | yes | **NO** |
| Plangothic P1 6.400 (Ext B ext.) | 65,440 | 1,083 | 69 | 42,720 | **NO** | yes |

### 3.2 Coverage of the 57 out-of-scope characters

* **All 52 BMP characters are present in all six "consumer" fonts** — SimSun, Microsoft YaHei, both
  PingFang SC builds, and Noto Sans/Serif CJK SC. There is **no missing-glyph problem for any rare BMP
  character a 红楼梦 actually contains.**
* **䰖 (U+4C16), 䀉 (U+4009), 㔩 (U+3529) — Ext A.** Present in Microsoft YaHei, both PingFang SC builds,
  Noto Sans/Serif CJK SC, and SimSun **5.03**; **absent from the XP-era SimSun 2.10** (Ext A coverage 0)
  and, of course, from SimSun-ExtB. So on an old Windows box using 宋体, three characters of the book
  render as tofu; on anything current they render.
* **𣬠 (U+23B20) and 𣬶 (U+23B36) — Ext B.** **Absent from every one of the six consumer fonts tested**,
  including SimSun 5.03, YaHei, both PingFang builds and both Noto CJK SC faces. They are present in
  **SimSun-ExtB 5.03** and in the open **Plangothic P1** (Ext B coverage 42,720 code points).
  Windows ships SimSun-ExtB as part of the SimSun family; Apple ships no obvious Ext B fallback for SC.

Practical read: the "black square" risk in a 红楼梦 reader is **2 characters, 4 occurrences**, and only in
editions that keep 𣬠𣬶. It is not worth shipping a general CJK font for; either accept it or append a
<1 KB Ext B supplement.

### 3.3 Web-font cost: full vs subset

Measured with `fontTools.subset` (`--layout-features='' --no-hinting`), Noto Serif CJK SC as the reference
family:

| artefact | bytes | vs full |
|---|---|---|
| Noto Serif CJK SC, full face (OTF) | 24,543,056 (24.54 MB) | — |
| Noto Serif CJK SC, full face (WOFF2) | 8,259,380 (8.26 MB) | — |
| …subset to the **4,268** chapters' distinct Han chars (OTF) | 1,537,560 (1.54 MB) | −93.7 % |
| …subset to the **4,473** chars of the Wikisource charset incl. the 5 rare (WOFF2) | 1,086,340 (**1.09 MB**) | −86.8 % |
| Noto Sans CJK SC 16,437,340 → subset to the same 4,268 chars (WOFF2) | 779,000 (0.78 MB) | −95.3 % |
| Plangothic P1 subset to just **𣬠𣬶** (WOFF2) | **904 B** | — |

Because a book is opened chapter-by-chapter, the per-chapter subset is smaller still — a chapter of
红楼梦 is ~6,000 Han chars → the 一级/二级-heavy subset a chapter actually needs is well under 300 KB.
**Recommendation: subset per book (or per chapter), never ship the full face.**

---

## 4. Item 4 — dictionary coverage (CC-CEDICT and Unihan `kMandarin`)

### 4.1 Whole-book coverage

| source | distinct Han covered | occurrence coverage |
|---|---|---|
| CC-CEDICT headword (any length, matching the character as a headword) | 4,259 / 4,268 | 724,660 / 724,669 = **99.9988 %** |
| Unihan `kMandarin` | **4,268 / 4,268** | **100.0000 %** |
| Unihan `kDefinition` (English gloss) | 4,260 / 4,268 | 99.9989 % |

**Unihan `kMandarin` covers the entire book, including all five non-URO characters.** That is the single
most useful fact in this section: a reading can always be offered, even when a dictionary entry cannot.

### 4.2 What cannot be found — CC-CEDICT

Exactly **9 distinct characters (9 occurrences)** in the PG epub have no CC-CEDICT entry:

| char | U+ | occ. | `kMandarin` | `kDefinition` (Unihan) |
|---|---|---|---|---|
| 薵 | U+85B5 | 1 | chóu | *(simplified form of 薵) name of a variety of…* |
| 槅 | U+69C5 | 1 | gé | *(no definition)* |
| 蠾 | U+883E | 1 | zhú | *(no definition)* |
| 銋 | U+928B | 1 | rén | *(no definition)* |
| 敠 | U+6560 | 1 | duō | to weigh; cut; come without being invited |
| 蠀 | U+8800 | 1 | cī | *(no definition)* |
| 怴 | U+6034 | 1 | xù | *(no definition)* |
| 峔 | U+5CD4 | 1 | mǔ | *(no definition)* |
| 錹 | U+9339 | 1 | kěn | *(no definition)* |

Plus **5 more** that CC-CEDICT also lacks and that only the Wikisource text contains: 䰖, 𣬠, 𣬶, 䀉, 㔩
(Unihan *does* have definitions for the last three: 「food containers (bowl; basin, etc.)…」, 「hair ornaments
used in old time」, 「fine hair; luster of hair…」).

So the worst case for "查不到": **≤14 characters in the whole of 红楼梦**, 5 of which are non-BMP.

### 4.3 Caveat

`kMandarin` gives **one** modern Mandarin reading per character. For a Qing novel, polyphones and
literary readings will differ (e.g. 舖 → pù, but 拚 is read pàn in 拚命 contexts and pīn elsewhere — see
§5.2, where the engine chose pīn). A dictionary card should therefore present `kHanyuPinyin`
(the fuller Unihan reading list) rather than a single `kMandarin` value, or mark the reading as
"modern standard".

---

## 5. Item 5 — TTS behaviour

### 5.1 Method (and why it is trustworthy)

Judging "读对/读错/跳过" without human ears needs an objective instrument. Two were used, and the
instrument itself was validated.

**Instrument A — word-boundary metadata (for "skipped vs spoken").**
The Edge read-aloud protocol accepts `"wordBoundaryEnabled":"true"` in `speech.config`, and then returns
`audio.metadata` frames carrying, for every token it actually synthesised, `Offset` and `Duration`
(100 ns ticks) plus the source text span. Repeating the same request three times gave **byte-identical
boundaries** (`這`/1,000,000/2,125,000, `是`/3,125,000/1,000,000, `紅字`/4,250,000/4,875,000 on all
three runs) — the timing layer is deterministic even though the MP3 container bytes vary slightly
between calls. A character with no boundary was **not spoken**.

**Instrument B — phonetic nearest-neighbour by audio equality (for "read correctly or not").**
Edge/Azure neural voices render a given phoneme string to (near-)identical audio, so character readings
can be compared by rendering reference characters whose readings are known from Unihan and measuring
DTW distance on MFCC+Δ+F0 features. Distances were sharply bimodal: **≈0.000 for "same reading",
≈6–15 for "different reading"** — e.g. 䰖 vs 纂 gave max PCM difference 0.0003 (mean 1e-5), while a
genuinely different syllable is 6–15. Threshold used: 0.5.

**Control.** The same classifier was run on 40 common characters with known readings. **37/40 "correct"**;
the three misses are artefacts, not errors — 了 (neutral-tone `le`) had no reference character available,
大's reference candidates failed to synthesise, and 地 was flagged only because `kMandarin` lists `de`
first while the engine (correctly, in isolation) said `dì`. Excluding those, the classifier was **37/37**.

**"Unknown character" baseline.** A character Edge cannot pronounce produces **no audio at all**:

| input | single character | inside a sentence (「妙玉斟了一X與黛玉。」) |
|---|---|---|
| U+E000 (private use) | `EdgeTtsError: TTS upstream returned no audio` | **silently dropped** — no word boundary, sentence 0.19 s shorter |
| U+FFFD, □ U+25A1 | same error | **silently dropped** |
| Tangut U+17000, Ext G U+30000, Ext H U+31350 | same error | — |
| 😀 U+1F600 | audio produced | — |

That is the important operational asymmetry: **standalone, an unpronounceable character makes the whole
request fail; inside a sentence it silently disappears.** Since 397 characters of the PG epub are `□`,
the deployed app would read those 397 places with a missing character and no error.

### 5.2 Result — 57 characters, Edge TTS, voice `zh-CN-YunxiNeural`, rate `+0%`

**48 / 57 correct (84 %) · 9 / 57 wrong reading (16 %) · 0 skipped.**
Verdict = automated (Instrument B), validated by the 37/40 control above; the MP3s are in
`/tmp/rh/audio/` on the research box, keyed by `md5(voice+char)[:16].mp3`, for human re-listening.

| # | char | code point | occ. in book | Unihan `kMandarin` | Edge says | verdict | spoken in context | word boundary seen |
|---|---|---|---|---|---|---|---|---|
| 1 | 舖 | U+8216 | 125 | pù | pù | ✔ | yes | 舖字 |
| 2 | 黹 | U+9EF9 | 13 | zhǐ | zhǐ | ✔ | yes | 黹字 |
| 3 | 咭 | U+54AD | 12 | jī | jī | ✔ | yes | 咭 |
| 4 | 舡 | U+8221 | 12 | chuán | chuán | ✔ | yes | 舡字 |
| 5 | 吒 | U+5412 | 6 | zhā | zhā | ✔ | yes | 吒 |
| 6 | **拚** | U+62DA | 6 | pàn | **pīn** | ✘ | yes | 拚字 |
| 7 | 揎 | U+63CE | 4 | xuān | xuān | ✔ | yes | 揎字 |
| 8 | 楞 | U+695E | 4 | léng | léng | ✔ | yes | 楞字 |
| 9 | 暉 | U+6689 | 3 | huī | huī | ✔ | yes | 暉字 |
| 10 | 蘼 | U+863C | 3 | mí | mí | ✔ | yes | 蘼字 |
| 11 | 鹺 | U+9E7A | 2 | cuó | cuó | ✔ | yes | 鹺字 |
| 12 | **琠** | U+7420 | 2 | tiǎn | **tiàn** | ✘ (tone) | yes | 琠字 |
| 13 | 筅 | U+7B45 | 2 | xiǎn | xiǎn | ✔ | yes | 筅字 |
| 14 | 唪 | U+552A | 2 | fěng | fěng | ✔ | yes | 唪字 |
| 15 | 欹 | U+6B39 | 2 | qī | qī | ✔ | yes | 欹 |
| 16 | 翦 | U+7FE6 | 2 | jiǎn | jiǎn | ✔ | yes | 翦 |
| 17 | 覿 | U+89BF | 2 | dí | dí | ✔ | yes | 覿字 |
| 18 | 囍 | U+56CD | 1 | xǐ | xǐ | ✔ | yes | 囍字 |
| 19 | 衒 | U+8852 | 1 | xuàn | xuàn | ✔ | yes | 衒字 |
| 20 | 窶 | U+7AB6 | 1 | jù | jù | ✔ | yes | 窶字 |
| 21 | 唚 | U+551A | 1 | qìn | qìn | ✔ | yes | 唚字 |
| 22 | 黌 | U+9ECC | 1 | hóng | hóng | ✔ | yes | 黌字 |
| 23 | 荈 | U+8348 | 1 | chuǎn | chuǎn | ✔ | yes | 荈字 |
| 24 | **薵** | U+85B5 | 1 | chóu | **zhòu** | ✘ | yes | 薵字 |
| 25 | 酴 | U+9174 | 1 | tú | tú | ✔ | yes | 酴字 |
| 26 | 槅 | U+69C5 | 1 | gé | gé | ✔ | yes | 槅字 |
| 27 | 蠾 | U+883E | 1 | zhú | zhú | ✔ | yes | 蠾字 |
| 28 | **銋** | U+928B | 1 | rén | **rěn** | ✘ (tone) | yes | 銋字 |
| 29 | 祕 | U+7955 | 1 | mì | mì | ✔ | yes | 祕字 |
| 30 | 敁 | U+6541 | 1 | diān | diān | ✔ | yes | 敁字 |
| 31 | **敠** | U+6560 | 1 | duō | **què** | ✘ | yes | 敠字 |
| 32 | **蠀** | U+8800 | 1 | cī | **jí** | ✘ | yes | 蠀字 |
| 33 | **怴** | U+6034 | 1 | xù | **xuè** | ✘ | yes | 怴字 |
| 34 | 峔 | U+5CD4 | 1 | mǔ | mǔ | ✔ | yes | 峔字 |
| 35 | 鬯 | U+9B2F | 1 | chàng | chàng | ✔ | yes | 鬯 |
| 36 | 榪 | U+69AA | 1 | mà | mà | ✔ | yes | 榪字 |
| 37 | 芏 | U+828F | 1 | dù | dù | ✔ | yes | 芏 |
| 38 | 鰷 | U+9C37 | 1 | tiáo | tiáo | ✔ | yes | 鰷字 |
| 39 | **怚** | U+601A | 1 | jù | **qū** | ✘ | yes | 怚字 |
| 40 | 醑 | U+9191 | 1 | xǔ | xǔ | ✔ | yes | 醑字 |
| 41 | 窀 | U+7A80 | 1 | zhūn | zhūn | ✔ | yes | 窀字 |
| 42 | 穸 | U+7A78 | 1 | xī | xī | ✔ | yes | 穸字 |
| 43 | 欷 | U+6B37 | 1 | xī | xī | ✔ | yes | 欷字 |
| 44 | 芰 | U+82B0 | 1 | jì | jì | ✔ | yes | 芰 |
| 45 | 薴 | U+85B4 | 1 | níng | níng | ✔ | yes | 薴字 |
| 46 | 愍 | U+610D | 1 | mǐn | mǐn | ✔ | yes | 愍字 |
| 47 | 鈽 | U+923D | 1 | bū | bū | ✔ | yes | 鈽字 |
| 48 | 揲 | U+63F2 | 1 | dié | dié | ✔ | yes | 揲字 |
| 49 | 錹 | U+9339 | 1 | kěn | kěn | ✔ | yes | 錹字 |
| 50 | 詘 | U+8A58 | 1 | qū | qū | ✔ | yes | 詘字 |
| 51 | 敉 | U+6549 | 1 | mǐ | mǐ | ✔ | yes | 敉字 |
| 52 | 祧 | U+7967 | 1 | tiāo | tiāo | ✔ | yes | 祧字 |
| 53 | 䰖 | U+4C16 | Wikisource only | zuǎn | zuǎn | ✔ | yes | 䰖 |
| 54 | 𣬠 | U+23B20 | Wikisource only | jī | jī | ✔ | yes | 𣬠 |
| 55 | **𣬶** | U+23B36 | Wikisource only | bā | **ba** (neutral) | ✘ (tone) | yes | 𣬶 |
| 56 | 䀉 | U+4009 | Wikisource only | qiáo | qiáo | ✔ | yes | 䀉 |
| 57 | 㔩 | U+3529 | Wikisource only | è | è | ✔ | yes | 㔩 |

The nine misreads, grouped:

* **Wrong syllable (5):** 拚 pàn→pīn, 薵 chóu→zhòu, 蠀 cī→jí, 怴 xù→xuè, 怚 jù→qū. Four of the five
  correspond to *another* reading the character legitimately has (拚 pīn, 薵 zhòu, 怴 xuè, 怚 qū) — i.e.
  the engine picked a valid-but-wrong polyphone, which is exactly the failure mode ADR 0004 fixed for
  Japanese with a curated replacement table.
* **Wrong tone only (3):** 琠 tiǎn→tiàn, 銋 rén→rěn, 𣬶 bā→ba (neutral).
* 蠀 cī→jí is the outlier: `jí` is listed for 蠀 in Unihan too, so it is again a polyphone pick.

Two characters were **unidentifiable against any Unihan reading of that character** (琠's audio matched
`tiàn`, which is one of its own readings; the earlier, coarser pass had 4 unidentified — 琠/薵/敠/怴 —
which the wider reference set then resolved for 3 of them). Net: **no character produced audio that could
not be matched to some real Mandarin syllable.**

### 5.3 Edge TTS cannot take `<phoneme>` — measured on the live endpoint

The ADR 0004 premise ("Edge TTS cannot take SSML reading hints") was re-tested directly against
`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` by sending a custom SSML
body (the same envelope `server/edge_tts.py` builds) with a `<phoneme>` element:

| SSML body sent | result |
|---|---|
| `<prosody …>舖</prosody>` (plain) | 11,232 bytes of MP3, full `turn.start → response → audio.metadata → turn.end` |
| `<phoneme alphabet="sapi" ph="pu4">舖</phoneme>` | **0 bytes** — only `turn.start`, then `turn.end`. **No error, no audio.** |
| `<phoneme alphabet="sapi" ph="pu2">舖</phoneme>` | **0 bytes** — same silent failure |
| `<phoneme alphabet="ipa" ph="pʰu⁵¹">舖</phoneme>` | **0 bytes** — same silent failure |
| plain text `pu4` | 11,232 bytes (the endpoint interprets it as text, not as a reading hint) |

So on the Edge path **`<phoneme>` is not merely ignored — it silently kills the whole turn**, and
`server/edge_tts.py` would surface that as `upstream_unavailable` ("TTS upstream returned no audio").
ADR 0004's conclusion holds, now with a reproducer. The only Edge-side lever remains **text rewriting**
(the ADR 0005 kana-style mechanism, applied to a `zh` replacement table).

### 5.4 Azure Speech — ⚠️ documented, **not empirically verified**

**There is no Azure key in this environment.** Read-only evidence:

* `claw:/etc/systemd/system/learnbuddy.service` has **no** `Environment=` / `EnvironmentFile=` line;
  `systemctl show learnbuddy --property=Environment` → `Environment=` (empty); no drop-ins.
* `grep -r AZURE_SPEECH_KEY /etc /srv /root /home` on claw → nothing; no `*.env` under `/srv/learnbuddy`.
* Locally: not in the environment, not in dotfiles, 1Password CLI reports "No accounts configured".
  The LearnBuddy session history contains only ADR/ticket prose, with the Azure account still flagged
  as a family action ("需要家庭先创建 Azure 账号拿 key").
* Consequence: `server/azure_tts.py` raises `upstream_unavailable` on claw today; **claw is running the
  Edge fallback only**.

The supervisor confirmed no key is obtainable and asked for the documented path instead. What Microsoft's
own reference says about the fix, quoted verbatim:

> For some locales, Speech service defines its own phonetic alphabets… The locales that support the
> Microsoft Speech API (SAPI, or `sapi`) are en-US/en-CA, fr-FR/fr-CA/fr-BE/fr-CH, de-DE/de-AT/de-CH,
> es-ES, ja-JP, **zh-CN**, zh-HK/yue-CN, and zh-TW.
> …
> **zh-CN** — The Speech service phone set `sapi` for zh-CN uses notation based on the native Pinyin
> phone set. **Important:** In SSML, set the phoneme element's `alphabet` attribute to `sapi`, **not**
> `pinyin`. For example: `<phoneme alphabet="sapi" ph="ni 3 hao 3">你好</phoneme>`.
> — https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-ssml-phonetic-sets

and, from the pronunciation reference (https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-pronunciation):

> `ph` … Each locale supports a specific phone set. **If the specified string contains unrecognized
> phones, text to speech service will return http 400 error for invalid SSML.**

So the documented answer to "does `<phoneme alphabet="sapi">` pinyin injection work as a fix?" is:
**yes for zh-CN**, using pinyin initials/finals/whole syllables each followed by a tone digit 1–5
(5 = neutral), e.g. `<phoneme alphabet="sapi" ph="pu 4">舖</phoneme>` for 舖, or
`<phoneme alphabet="sapi" ph="zu 3">䰖</phoneme>` for 䰖; it is `sapi`, **not** `pinyin`; and a malformed
`ph` fails the whole request with HTTP 400. The tone table (bā/ba 1 … ba/ba 5) and phone tables are in the
same page. **None of this was executed** — treat the ph strings as "documented format", not "known-good
values".

### 5.5 How to verify in ~15 minutes, once a key exists

```bash
# on any machine with the repo checked out
export AZURE_SPEECH_KEY='<32-hex key>'
export AZURE_SPEECH_REGION='japaneast'      # ADR 0005 default; must match the key's region
```

```bash
# 1) ADR 0005 path, unmodified: this is the exact request the app makes.
curl -sS -o /tmp/azure_probe.mp3 \
  -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" \
  -H "Content-Type: application/ssml+xml" \
  -H "X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3" \
  -H "User-Agent: LearnBuddy/1.0 (family TTS proxy)" \
  --data-binary '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)"><prosody rate="+0%">舖</prosody></voice></speak>' \
  "https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
file /tmp/azure_probe.mp3     # expect: MPEG ADTS / MP3
```

```bash
# 2) the phoneme-injection experiment: same envelope, body replaced with a <phoneme>.
#    Expect HTTP 200 + audio if pinyin injection works; 400 if the ph string is malformed.
for ph in "pu 4" "zu 3" "ba 1"; do
  echo "--- ph=$ph"
  curl -sS -o /tmp/ph.mp3 -w '%{http_code} %{size_download}\n' \
    -H "Ocp-Apim-Subscription-Key: $AZURE_SPEECH_KEY" \
    -H "Content-Type: application/ssml+xml" \
    -H "X-Microsoft-OutputFormat: audio-24khz-48kbitrate-mono-mp3" \
    --data-binary "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"zh-CN\"><voice name=\"Microsoft Server Speech Text to Speech Voice (zh-CN, YunxiNeural)\"><prosody rate=\"+0%\"><phoneme alphabet=\"sapi\" ph=\"$ph\">舖</phoneme></prosody></voice></speak>" \
    "https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
done
```

```bash
# 3) repeat the 57-char run against Azure instead of Edge, then diff the two verdicts:
#    update server/azure_tts.py's AZURE_SPEECH_KEY and rerun the same classifier
#    (the research harness is described in §7; /tmp/rh/final_tts.py + /tmp/rh/audio/).
```

Also worth doing in the same session: install the key into `claw` as a systemd `Environment=` line (per
ADR 0005 the key is BYOK and must not be committed), restart `learnbuddy.service`, and
`curl 'http://192.168.3.28/tts?text=舖&lang=zh'` twice — once with the key set (Azure) and once without
(Edge) — to confirm the provider switch and the cache key are untouched.

### 5.6 In-context behaviour (Edge)

For every one of the 57 characters, the carrier sentence 「這是X字。」 was synthesised with
`wordBoundaryEnabled`. **All 57 produced a word boundary containing the character — none was skipped.**
Only unpronounceable code points (□ U+25A1, U+E000) vanish silently (see §5.1). Examples showing how the
metadata exposes the read: 舖 → `舖字` (6,125,000 ticks = 0.6125 s for both characters, i.e. it read 舖 as
a word onset), 咭 → its own boundary `咭` (0.275 s), 𣬠 → own boundary (0.275 s), 𣬶 → own boundary
(0.200 s), 䀉 → own boundary (0.350 s), 㔩 → own boundary (0.225 s).

---

## 6. Item 6 — traditional vs simplified

### 6.1 The PG "traditional" text is actually a hybrid

Measured against OpenCC `s2t`/`t2s`:

| | distinct | occurrences | share of Han text |
|---|---|---|---|
| characters that are a traditional form (`t2s(c) ≠ c`) | 1,383 | 177,162 | 24.45 % |
| characters that are a **simplified** form (`s2t(c) ≠ c`) | **119** | **32,333** | **4.46 %** |

So ~4.5 % of the running text of this "traditional" ebook is written with simplified characters, e.g.:

| simplified form used | occ. | traditional |
|---|---|---|
| 儿 | 6,022 | 兒 |
| 里 | 5,090 | 裏 |
| 么 | 3,644 | 麼 |
| 听 | 3,254 | 聽 |
| 吃 | 1,444 | 喫 |
| 几 | 1,391 | 幾 |
| 后 | 1,381 | 後 |
| 气 | 1,113 | 氣 |
| 与 | 1,050 | 與 |
| 云 | 733 | 雲 |
| 并 | 633 | 並 |
| 于 | 561 | 於 |

Concrete mixed lines: 「街東是**宁**國府，街西是榮…」(should be 寧, and elsewhere the same string
appears as 寧), 「樂得**与**二三同志」, 「不可**胜**數」, 「仔細肚**里**面筋作怪」, 「**這**里雨村」.
The Wikisource 匯校本 has the same habit (137 simplified-form characters). This is a property of
older Chinese digital transcriptions, and it means **"traditional edition" is not a clean label** — a
reader that assumes "traditional text ⇒ no simplified characters" will be wrong on ~4.5 % of characters.

### 6.2 Which problems appear in only one

| problem | traditional only | simplified only | both |
|---|---|---|---|
| Font: Ext A characters 䰖/䀉/㔩 missing on old SimSun 2.10 | ✔ (these chars have no simplified counterpart) | — | |
| Font: Ext B 𣬠𣬶 missing everywhere | ✔ | — | |
| Dictionary: 9 CC-CEDICT misses (薵 槅 蠾 銋 敠 蠀 怴 峔 錹) | — | — | ✔ (same characters in both, they are not simplified/traditional variants) |
| TTS: misreads 拚/薵/琠/銋/敠/蠀/怴/怚 | — | — | ✔ |
| **TTS: whole-book reading path** | **only traditional text needs a zh-TW/zh-HK voice decision** or 繁→简 bearing before synthesis | simplified text goes straight to `zh-CN-YunxiNeural` | |
| **Sentence splitting** | the traditional sample uses `．` U+FF0E as period | (a real simplified edition would use `。`) | |
| **Character count** | 4,268 distinct Han | projection: 4,255 distinct | |

The clearest traditional-only finding: **the rare-character inventory itself.** Of the 57 characters,
the PG traditional text never contains the five non-URO ones — they were *lost in transcription*, and
they only exist in the traditional 庚辰/程甲 匯校本. A simplified reading path does not meet them at all
(a simplified edition would render 䰖 as 髒? no — 纂/髒 is unrelated; the correct simplification of these
five is not always defined). Converting the PG text with OpenCC `t2s` produced **3 non-BMP characters
(䓓 U+44D3, 𧑏 U+2744F, 𧏗 U+273D7)** — but inspection shows all three come from **corrupted input
positions** (garbled strings like 「山噢薵W之間」 and 「炫蠾Y」), so this is an artefact of the PG text's
transcription noise, **not** a general "simplification creates astral characters" effect.

Simplified-only finding: after `t2s` projection the out-of-scope set shrinks to **50 distinct / 230
occurrences (0.0317 %)** and the GB2312-missing set to **18 distinct / 143 occurrences (0.0197 %)** —
i.e. **a simplified edition of 红楼梦 is measurably easier** on both counts, mostly because
traditional-only forms like 暉/鹺/覿/窶/黌/榪/鰷/詘 disappear.

---

## 7. Reproduction

Everything ran in a throwaway working directory (`/tmp/rh`) with a venv
(`venv/bin/python`, `fontTools 4.65.0`, `numpy 2.5.3`, `scipy 1.18.1`, `opencc-python-reimplemented`),
plus the repo's own stdlib Edge client copied verbatim from `server/edge_tts.py`. Download commands are
in §1; the analysis steps were:

1. `epub_body()` — unzip `hlm.epub`, concatenate the 12 `*24264-0-*.txt.xhtml` files in order, strip
   tags, cut on the PG START/END markers.
2. `is_han` / `bucket` — block classification (the same predicates used throughout).
3. `Counter` → totals, per-block counts, per-block share of non-whitespace text.
4. Fonts: `fontTools.ttLib.TTFont` / `TTCollection`, union of all `cmap` subtables, per-range counts.
5. Subsetting: `pyftsubset <face> --text-file=charset.txt --flavor=woff2 --layout-features='' --no-hinting`.
6. Dictionaries: CC-CEDICT regex `^(TRAD)\s+(SIMP)\s+\[PINYIN\]\s+/gloss/`; Unihan TSV field extraction.
7. TTS: `EdgeTtsSynthesizer.speak(char, 'zh-CN-YunxiNeural', '+0%')` for each character and for a
   reference bank; DTW classifier over MFCC+Δ+F0; separate pass with
   `"wordBoundaryEnabled":"true"` for skip detection.

Caveat to repeat for any follow-up: the classifier is an *automated proxy*. It is sharp (0 vs 6–15) and it
passed a 37/40 control, but a human ear is still the authority on the nine misreads and on the
tone-only cases. The MP3s are on disk for that.

---

## 8. What could **not** be verified

1. **Azure Speech behaviour (items 5's first half)** — no key exists on claw or locally. Everything about
   Azure here is quoted from Microsoft's reference docs and clearly labelled as unverified; §5.5 is the
   script to close it out.
2. **User book samples (ticket #13)** — `claw:/srv/learnbuddy/books/` does not exist and no epub was found
   anywhere on claw or locally, so there are **no user-file findings**; every number above is a
   public-sample number.
3. **The PG epub's base edition** — PG does not state 程甲/程乙/庚辰, so nothing here is edition-specific;
   the rare-character inventory comes from the Wikisource 匯校本 (庚辰 for ch. 1–80, 程甲 for ch. 81–120)
   and a different edition could contain a different set.
4. **The 397 `□` positions** — 344 distinct contexts; the underlying characters were not recovered
   (each would need collation against a full-text edition). The count is a floor on the rare-character
   inventory.
5. **Old-Windows SimSun 2.10 vs current SimSun 5.03** — both were tested, but "which SimSun a given
   family machine has" was not; if the reading device is an older Windows, Ext A is a real risk.
6. **SimSun/Microsoft YaHei/PingFang provenance** — the files are third-party mirrors of proprietary
   Microsoft/Apple fonts (versions recorded in §3). The cmaps are the real ones (named-table versions
   reproduce the vendors' release strings), but they are not vendor-distributed downloads.
7. **Tone-sandhi/prosody in real sentences** — the in-context test established *presence* per character,
   not reading identity; in-context reading identity would need aligned-segment comparison and is left
   for the TTS-table work.

---

## 9. Handoff note (kept separate, per supervisor instruction)

This ticket is **out of scope for the current map** (MVP = English/Japanese books). The findings that are
reusable *now* for the map are: the sentence-splitting hazards already visible in a real Chinese book
(`．` U+FF0E as the terminator; `□` placeholders; mixed traditional/simplified text), the confirmation
that **Edge TTS cannot take SSML hints** (so any Chinese reading fix must be a text/substitution table,
exactly like ADR 0004/0005), and the font conclusion (subset, never ship the full CJK face).
The Chinese-book-specific follow-ups — Azure key + `<phoneme alphabet="sapi">` verification, a `zh`
replacement table seeded from §5.2, and an Ext B font supplement — should live on a separate
future-Chinese-book ticket, not on #9.
