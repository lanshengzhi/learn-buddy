# 查义引擎选型：中日英离线词典数据与分词器

Ticket: [#11](https://github.com/lanshengzhi/learn-buddy/issues/11)（`wayfinder:research`）
方法：一手来源（词典官方下载页/仓库、工具官方文档与 PyPI/npm 元数据）+ 在临时 venv 里真装真跑。所有数字都是本次实测，命令见文末附录。

---

## 0. 结论（TL;DR）

**v1 最小组合**（claw 上要装的东西）：

1. **Python 依赖只加一个**：`pip install sudachipy sudachidict_core`（Apache-2.0，cp314 预编译 wheel，claw 上 46 秒装完）。日文查词**必须**要形态素分析（活用还原），这是唯一一个非装不可的分析器。
2. **词典数据全部落成 4 个 SQLite 文件**（构建期生成，运行期零依赖）：`zh.sqlite` 18.3 MB（CC-CEDICT + Unihan）、`ja.sqlite` 49.8 MB（JMdict）+ `kanji.sqlite` 0.9 MB（KANJIDIC2）、`en.sqlite` 81.8 MB（ECDICT），合计 **≈ 151 MB**。
3. **中文不需要 jieba**。按"点哪个字→查包含它的词"的查义流程，中文用「窗口内 CC-CEDICT 最长匹配」（纯 Python，0 依赖，100% 命中词典）或前端已有的 `Intl.Segmenter('zh')`（Node/ICU 实测 2.77 M chars/s）即可；jieba 只在将来要做"整段词语标注"时才需要（代价：+42 MB 磁盘、+77 MB 常驻内存、claw 上初始化 3.7 秒）。
4. **存储只用 stdlib `sqlite3` 的普通 B-tree 索引，v1 不要 FTS5**。实测：单次查询 p50 **10.5 µs**（本机）/ **79.6 µs**（claw，Celeron J1900）；而 FTS5 对中文是错工具——`unicode61` 把整段 CJK 当一个 token（`石油` 查不到任何东西），`trigram` 至少要 3 个字（`石油` 仍然 0 命中）。
5. 运行期内存：只装 Sudachi 时进程 ~130 MB；把 4 个库都 mmap 预热后峰值 ~330 MB（claw 空闲内存 837 MB，可用但不算宽裕）。

**可以以后再加，不进 v1**：jieba、wiki 级 康熙字典 数据集（没有许可干净、可直接机读的版本）、WordNet/Open English WordNet、汉-汉释义（教育部《重编国语辞典》是 **CC BY-ND（禁止改作）**，只能原样展示）、FTS5 释义全文检索、拼音索引。

---

## 1. 测试环境（本报告所有实测数字的来源）

| | 开发机（本机） | claw（部署目标） |
|---|---|---|
| OS / kernel | Omarchy（ID_LIKE=arch）, 7.2.3-arch1-3 | Arch Linux, 7.0.11-arch1-1 |
| Python | **3.14.7** (GCC 16.1.1) | **3.14.5** (GCC 16.1.1) |
| SQLite（stdlib `sqlite3.sqlite_version`） | 3.53.4，`ENABLE_FTS5=1` | 3.53.1，`ENABLE_FTS5=1` |
| CPU / RAM / 磁盘 | — | Intel Celeron **J1900 @1.99 GHz**（4 核）, 1841 MB RAM（空闲 837 MB）, `/` 48 GB 可用 |
| Node（前端对照） | v26.7.0，ICU 78.3 | — |

claw 是 2013 年的 Atom 级 SoC：同一份 Python 代码，**单次查询延迟约为本机的 4–5 倍**，分词吞吐约为本机的 1/3–1/5（见 §2.4）。所有"够不够快"的判断都要按 claw 的数字来。

Python 3.14 的一个坑：`sqlite3.version` / `version_info` 已被删除（[What's New in Python 3.14 → Removed → sqlite3](https://docs.python.org/3.14/whatsnew/3.14.html)：*"Remove version and version_info from the sqlite3 module; use sqlite_version and sqlite_version_info"*），只能用 `sqlite3.sqlite_version`。

---

## 2. 数据源（内容范围 / 体积 / 格式 / 更新 / 许可 / 下载地址）

### 2.1 中文

#### CC-CEDICT（英汉·汉英，繁+简并列）

| 项 | 值（实测） |
|---|---|
| 内容 | **125,073** 条；繁/简双列，**122,494** 个繁体头 / **121,311** 个简体头（去重）；其中 **14,399** 个单字头，110,789 条多字词 |
| 体积 | 下载 `cedict_1_0_ts_utf-8_mdbg.txt.gz` **3.97 MB** → 解压 **9.85 MB** 文本 |
| 格式 | 每行 `繁 简 [pin1 yin1] /gloss/gloss/`，UTF-8 纯文本，头部带 `#! entries= / date= / license=` 元数据 |
| 更新 | 滚动发布：本次拉到的文件头 `#! date=2026-09-19T09:05:23Z`，MDBG 页面同时刻显示 *"Latest release: 2026-09-19 09:05:23 GMT / Number of entries: 125073"*；页面说明投稿"checked and processed frequently and released for download"（[MDBG CC-CEDICT download](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)） |
| 许可 | **CC BY-SA 4.0**（文件头 `#! license=https://creativecommons.org/licenses/by-sa/4.0/`，MDBG 页面同述）——署名 + 相同方式共享 |
| 地址 | https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz |

繁简/异体映射就**自带**：每条 entry 的繁/简两列即可建映射表；实测拿《红楼梦》（繁体）正文里 **4,268** 个不同汉字去查，**4,259** 个能命中 CC-CEDICT 单字条（其余 9 个命中 Unihan），**OpenCC t2s 转换救回 0 个字**——也就是说繁体正文不需要转换，CC-CEDICT 的繁列就够。

#### Unihan（读音 / 字形 / 康熙索引 / 异体关系）—— 生僻字的兜底

| 项 | 值（实测，Unicode 18.0.0，文件日期 2026-07-31） |
|---|---|
| 内容 | 全库 **102,999** 字（均有笔画/部首，来自 `Unihan_IRGSources.txt`/`Unihan_DictionaryLikeData.txt`）：`kMandarin` **44,355** 字、`kDefinition`（英文释义）**23,310** 字、`kHanyuPinyin` **34,130** 字、`kKangXi`（康熙字典页码.位置）**70,343** 字、`kTraditionalVariant` 6,840 / `kSimplifiedVariant` 7,291 / `kZVariant` 159 |
| 分区块覆盖（kMandarin） | URO 基本区 20,924 / ExtA 5,787 / **ExtB 14,618** / ExtC-F 1,571 |
| 体积 | `Unihan.zip` **8.34 MB**（8 个 tab 分隔文本） |
| 格式 | UCD 文本 `U+XXXX<TAB>field<TAB>value` |
| 更新 | 随 Unicode 标准版本（[Unicode 18.0.0, 2026](https://www.unicode.org/versions/)）；文件自带 `# Date: 2026-07-31`、`# Unicode Version 18.0.0` |
| 许可 | **Unicode License V3**（[license.txt](https://www.unicode.org/license.txt)：copies 或文档中必须保留版权与许可声明，无其他限制） |
| 地址 | https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip |

**生僻字缺口有多大（实测交叉比对）**：把 Unihan 里"有读音/有释义/有异体关系"的 47,170 字与 CC-CEDICT 单字头对比，**32,801 字 CC-CEDICT 完全没有单字条**；其中 30,008 字有 `kMandarin`（读音可得）、9,896 字有 `kDefinition`（释义可得）、1,283 字可以**经 Unihan 异体关系**指回一个 CC-CEDICT 有收录的字（例：`𠂝 → 匝 / 眾`）。另 22,186 字有拼音但**没有**英文释义——这就是"能读不能释义"的部分。

具体样例（ExtB，CC-CEDICT 无收录、Unihan 有）：`𠀁 hē "(original form of 七)"`、`𠀅 hài "(variant of 亥)"`、`𠀉 qiū "(same as 丘) a hill; elder; empty; a name"`。

#### 康熙字典系（开放数据集）

**结论：没有"许可干净 + 可机读 + 在维护"的数据集，v1 不做。** 逐一核实：

| 候选 | 内容/体积 | 许可 | 问题 |
|---|---|---|---|
| [7468696e6b/kangxiDictText](https://github.com/7468696e6b/kangxiDictText) | `kangxizidian-v3f.txt` **14.1 MB** 纯文本（UTF-8，含御製序） | MIT（Copyright 2020） | 未做条目级解析验证；txt 无结构，要自己切字头；仓库 2020 年后基本静止 |
| [samsonhoi/kangxi-dictionary](https://github.com/samsonhoi/kangxi-dictionary) | `kx_full.xlsx` **6.4 MB**（仓库自述 48,710 笔记录） | MIT（2021） | xlsx，要 pandas/openpyxl 读；内容质量未验证 |
| [ksanaforge/kangxizidian](https://github.com/ksanaforge/kangxizidian) | 是个 JS 前端应用，数据在别处 dump | **GPL-3.0** | 2016 年后无更新，不是可直接用的数据集；GPL 传染 |
| Wikisource《康熙字典》 | 原文公有领域（1716），站点 pageid 180491 | 站点 CC BY-SA 4.0 + 原文 PD | 要自己做 proofread 页面抽取 |
| Unihan `kKangXi` | **70,343 字**的"页码.位置"指针（例：`U+3400 → 0078.010`） | Unicode License V3 | 只有**指针**，没有释义正文 |

康熙字典释义是文言文，对家庭读者本身也需要再解释；性价比低于 Unihan + CC-CEDICT，**不进 v1**。

#### OpenCC（繁简 / 地区异体，含字表与词表）

| 项 | 值 |
|---|---|
| 内容 | `data/dictionary/` 下 **26** 个文本表，合计 **1.31 MB**（`STPhrases.txt` 1.0 MB、`TSCharacters.txt` 104 KB、`STCharacters.txt` 36 KB、`TW/HK/JP` 变体表等） |
| 许可 | **Apache-2.0**（[BYVoid/OpenCC](https://github.com/BYVoid/OpenCC)） |
| 更新 | 活跃（仓库最近 push 2026-09-19） |
| 用法 | `pip install opencc`（官方 C++ 绑定）：**cp314 wheel 存在**，装 **4 秒**，转 905,609 字用 **0.07 s = 12.56 M chars/s**；`pip install opencc-python-reimplemented`（纯 Python，Apache）只有 **610 K chars/s**，慢 20 倍 |

> 注意两个 pip 包**同模块名 `opencc`**，不能共存；要用就装官方那个。

#### （以后可选）汉-汉释义：教育部《重编国语辞典》

[g0v/moedict-data](https://github.com/g0v/moedict-data) 把它转成 JSON，仓库 2026-07 仍在更新；但 README 明确：*"依教育部之解释，『创用CC-姓名标示-禁止改作 台湾3.0版授权条款』之改作限制标的为文字资料本身"* —— **CC BY-ND，禁止改作**。原样展示可以，编辑/重排正文（哪怕是格式转换以外的处理）有授权风险；本项目若要用，只能"只读展示"。不进 v1。

### 2.2 日文

#### JMdict（日英词典；读音 + 词性 + 释义 + 活用）

| 项 | 值（实测，2026-09-19 版） |
|---|---|
| 内容 | **218,786** 条 entry；**499,151** 条「表记形式」（汉字 + 假名读音）；**253,614** 个义项（含 POS / misc / field / 英文 gloss） |
| 体积 | `JMdict_e.gz` **10.57 MB** → XML **60.2 MB** |
| 格式 | XML（`edrdg.org/pub/Nihongo/JMdict_e.gz`），另有 [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) 的 JSON 版：`jmdict-eng-3.6.2+20260914172325.json.tgz` **11.5 MB**（全量）、`jmdict-eng-common-...json.tgz` **1.4 MB**（常用词子集，将来做前端词库有用） |
| 更新 | **每日**——EDRDG 说明 *"Dictionary files such as JMdict, Kanjidic, etc. will still be updated daily"*（[EDRDG 00INDEX](https://www.edrdg.org/pub/Nihongo/00INDEX.html)）；本次文件头 `JMdict created: 2026-09-19` |
| 许可 | **CC BY-SA 4.0**（[EDRDG General Dictionary Licence](https://www.edrdg.org/edrdg/licence.html)：*"The dictionary files are made available under a Creative Commons Attribution-ShareAlike Licence (V4.0)"*，要求在使用方文档/站点/App 里致谢并提供许可副本） |
| 地址 | https://www.edrdg.org/pub/Nihongo/JMdict_e.gz |

#### KANJIDIC2（汉字级读音/义/级别）

**13,108 字**（JIS X 0208/0212/0213），含 on/kun 读音、英文义、`grade`、`stroke_count`、`frequency`、classical radical、JLPT。`kanjidic2.xml.gz` **1.49 MB** → XML 14.9 MB，`database_version` 2026-262（=2026 年第 262 天，**每日更新**），许可同上 EDRDG（CC BY-SA 4.0）。落库后仅 **0.9 MB**。
地址：https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz

#### 分词器词典：SudachiDict（small / core / full）

- 与 SudachiPy 配套的词典包，PyPI `sudachidict_core` **20260723.1**，Apache-2.0；**72.3 MB wheel → 安装后 208 MB**（本地实测）。
- [SudachiDict README](https://github.com/WorksApplications/SudachiDict)：Small=仅 UniDic 词汇 / Core=基本词汇（默认）/ Full=含大量专名；**二进制格式 V1 自 v202610 起，SudachiPy 必须 ≥0.7**，而 PyPI 上 SudachiPy 最新为 **0.6.11**（配 V0 词典，即当前 20260723 这套）。**版本要成对升**，否则加载失败。
- [LEGAL](https://github.com/WorksApplications/SudachiDict/blob/develop/LEGAL)：全部文件 Apache-2.0；其中 `small_lex.csv`/`matrix.def` 部分来自 UniDic（Copyright 2011-2013 The UniDic Consortium，BSD 三条款式），保留声明即可。

### 2.3 英文

#### ECDICT（英汉双解，首选）

| 项 | 值（实测） |
|---|---|
| 内容 | **770,611** 条；字段：word / phonetic / **definition(英文)** / **translation(中文)** / pos / collins / oxford / tag(中考·高考·CET4…) / bnc / frq / **exchange(词形变化+lemma)** |
| 体积 | `ecdict.csv` **65.9 MB**（仓库内直接给 csv，另有 release 里的 sqlite/StarDict 包） |
| 更新 | 仓库最近 push **2025-03-28**（约一年半未更新）；最新 release 仍是 2017 年的 1.0.28 |
| 许可 | 仓库声明 **MIT**（`LICENSE`, Copyright (c) 2025 Linwei） |
| 地址 | https://github.com/skywind3000/ECDICT |
| ⚠️ 风险 | README 自述词库是**多方拼合**：EDictAZ.txt、四六级/GRE 词表、`cdict-1.0-1.rpm`（Linux cdict）、爬来的音标、BNC 词频、WordNet/NodeBox 生成变形。**"仓库 MIT" 不等于"释义原文版权干净"**。家用没问题；若要对外分发要评估。 |

`exchange` 字段直接给了英文查义最需要的**词形还原**（[README 词形变化](https://github.com/skywind3000/ECDICT#%E8%AF%8D%E5%BD%A2%E5%8F%98%E5%8C%96)：`p`过去式 `d`过去分词 `i`现在分词 `3`三单 `r`比较级 `t`最高级 **`0`原型(lemma)** `1`来源变形类型）。实测：`went → "0:go/1:p"`、`gone → "0:go/1:d"`、`studies → "0:study/1:s3"`——**无需词干化算法**。

#### WordNet 3.0 / Open English WordNet（英英，以后可选）

- **WordNet 3.0**：`WNdb-3.0.tar.gz` **10.5 MB** → 解压 **34 MB**（`data.noun` 15.3 MB 等）；许可为 **Princeton WordNet License**（官方 tarball 内 `WordNet-3.0/LICENSE` 原文：允许 use/copy/modify/distribute，"provided that you agree to comply with the following copyright notice and statements"，且 *"The name of Princeton University or Princeton may not be used in advertising or publicity"*）。数据 2006 年后冻结。地址 https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz
- **Open English WordNet**（活跃维护）：最新 **2025-edition（2025-12-31）**，`english-wordnet-2025.zip` **9.6 MB**、`-plus` 11.0 MB、XML/JSON/TTL 均有；许可 **CC BY 4.0**（README：*"Open English Wordnet is released under CC-BY 4.0"*）。地址 https://github.com/globalwordnet/english-wordnet/releases
- 对本项目：ECDICT 的 `definition` 已经给了英英释义、`translation` 给了中文，WordNet 主要多出**同义词集(synset)**，**不进 v1**。

### 2.4 数据源小结表

| 源 | 体积（下载 → 用） | 落库后 | 更新 | 许可 |
|---|---|---|---|---|
| CC-CEDICT | 3.97 MB → 9.85 MB txt | 18.3 MB（与 Unihan 合并库） | 滚动/当天 | CC BY-SA 4.0 |
| Unihan | 8.34 MB zip | 同上 | 随 Unicode 版本（年） | Unicode License V3 |
| 康熙字典（各开放集） | 6.4–14.1 MB | — | 停滞 | MIT / 不明 / GPL-3.0 | 
| OpenCC | 1.31 MB 表 + 2.4 MB wheel | 运行时 | 活跃 | Apache-2.0 |
| JMdict | 10.57 MB → 60.2 MB xml | 49.8 MB | **每日** | EDRDG CC BY-SA 4.0 |
| KANJIDIC2 | 1.49 MB → 14.9 MB xml | 0.9 MB | **每日** | EDRDG CC BY-SA 4.0 |
| SudachiDict-core | 72.3 MB wheel | 208 MB | 随 Sudachi 版本发布 | Apache-2.0 (+UniDic BSD) |
| ECDICT | 65.9 MB csv | 81.8 MB | 2025-03 后停滞 | MIT（内容来源存疑） |
| WordNet 3.0 | 10.5 MB → 34 MB | — | 冻结(2006) | Princeton License |
| OEWN 2025 | 9.6 MB zip | — | 年度 | CC BY 4.0 |

---

## 3. 切词

### 3.1 安装可行性（Python 3.14 实测）

全部在 `/tmp` 临时 venv 里真装真跑（本机；claw 上另建临时 venv，用完删除）：

| 工具 | 版本 | 安装方式 / 耗时 | 磁盘 | 3.14 状态 |
|---|---|---|---|---|
| jieba | 0.42.1 | pip（sdist 现场 build wheel，setuptools 只有 License 分类器警告），本机约 7 s | **42 MB**（其中 `dict.txt` 4.9 MB / 349,046 词，`posseg` 15 MB、`lac_small` 13 MB、`analyse` 6 MB 用不到） | ✅ 可跑 |
| SudachiPy | **0.6.11** | pip **cp314 wheel 存在**（`sudachipy-0.6.11-cp314-cp314-manylinux2014_x86_64...whl`） | 4.4 MB | ✅ |
| SudachiDict-core | 20260723 | pip（`sudachidict_core-20260723-py3-none-any.whl` 72.3 MB） | 208 MB | ✅ |
| Janome | 0.5.0 | pip（`py2.py3-none-any`，安装时现场建词典，README 警示"build 需约 500 MB 内存"）；实测 **20 s** | 257 MB | ✅ |
| fugashi | 1.5.2 | pip **cp314 wheel 存在**（`fugashi-1.5.2-cp314-cp314-manylinux...whl`） | 1.2 MB + 0.99 MB libs | ✅ |
| unidic-lite | 1.0.8 | pip（47.4 MB sdist → wheel）；连同 fugashi 共 **4 s** | 249 MB | ✅ |
| opencc（官方） | 1.4.2 | pip **cp314 wheel 存在** | ~2.4 MB | ✅ |
| opencc-python-reimplemented | 0.1.7 | pip | 1.2 MB | ✅ |
| pypinyin | 0.55.0 | pip（`py2.py3-none-any`） | 3.8 MB | ✅ |

**claw 上实测**（Arch，Python 3.14.5，J1900）：`python3 -m venv /tmp/lkvenv && pip install sudachipy sudachidict_core jieba` → **46 秒**，venv **266 MB**，`SudachiPy 0.6.11 + SudachiDict-core 20260723` 可用。
MeCab 本体在 Arch 官方仓库**没有**（`pacman -Si mecab` 无结果）；AUR 有 `mecab-git`、`mecab-ipadic`、`python-fugashi`（[AUR RPC 查询](https://aur.archlinux.org/rpc/v5/search/mecab)），但 pip 的 `fugashi` 已自带 MeCab，**不需要 pacman**。

### 3.2 速度 / 内存实测（本机；日文语料=夏目漱石《坊っちゃん》89,512 字，中文语料=《红楼梦》简体 200,000 字）

| 分词器 | 初始化 | 吞吐 | 峰值 RSS |
|---|---|---|---|
| jieba（默认 HMM） | 0.51 s（并在 `/tmp/jieba.cache` 写缓存） | **242,792 chars/s** | 89 MB |
| jieba（HMM=False，纯词典模式） | — | 526,075 chars/s | 96 MB |
| SudachiPy + core，SplitMode A | 0.01 s | 720,176 chars/s | 195 MB |
| SudachiPy + core，SplitMode B | 0.01 s | 847,717 chars/s | 195 MB |
| SudachiPy + core，SplitMode C | 0.01 s | **992,107 chars/s** | 195 MB |
| Janome（默认 ipadic） | 0.08 s | **25,400 chars/s** | 183 MB |
| fugashi + unidic-lite | ~0（import 期加载） | **737,919 chars/s** | 180 MB |

claw 上（J1900）：Sudachi 211,036 chars/s；jieba 初始化 **3.67 s**、吞吐 **45,384 chars/s**（约本机 1/5）。

> SudachiPy 有个**硬限制**：单次 `tokenize()` 输入 **≤ 49,149 字节**，否则 `SudachiError: "Error during tokenization": Input is too long`。UTF-8 汉字 3 字节/字，即一次最多约 16k 字，长文要切片调用。

### 3.3 中文按词查义：jieba vs 词典最长匹配 vs 只做单字

语料=《红楼梦》简体前 200,000 字（Han 段内部边界 72,205 个，作为对比基准）：

| 引擎 | Han token 数 | 命中 CC-CEDICT | 单字 token 占比 | 与 jieba 边界一致率 | 吞吐 |
|---|---|---|---|---|---|
| jieba | 101,139 | 78.8% | 49.9% | 基准 | 233–294 K chars/s |
| **CC-CEDICT 正向最长匹配**（≤19 字，按标点切段） | 124,325 | **100%** | 73.5% | 62.1% | **1.44 M chars/s** |
| `Intl.Segmenter('zh')`（Node 26 / ICU 78.3） | 91,363 | 92.2% | 70.7% | **91.9%** | **2.77 M chars/s** |
| 只做单字 | 200,000 | 79.6%（单字条） | 100% | 70.1% | 27.7 M chars/s |

质量样例（同一句）：

```
原文      林黛玉听了,不觉气怔在门外,待要高声问他,逗起气来,自己又回思一番
jieba     林黛玉/听/了/,/不觉/气/怔/在/门外/,/待要/高声/问/他/,/逗起/气来/,/自己/又/回思/一番
最长匹配  林黛玉/听/了/不觉/气/怔/在/门外/待要/高声/问/他/逗/起/气/来/自己/又/回/思/一/番
ICU(zh)   林黛玉/听/了/,/不觉/气/怔/在/门外/,/待/要/高声/问/他/,/逗/起/气来/,/自己/又/回/思/一番
原文      他在塔里木盆地发现了大量石油和天然气
jieba     他/在/塔里木盆地/发现/了/大量/石油/和/天然气
ICU(zh)   他在/塔里木盆地/发现/了/大量/石油/和/天然/气     ← 两处错
```

结论：**没有一个引擎全面最好**。
- jieba 边界最"像人"（`逗起/气来/回思`），但它的词表和 CC-CEDICT 不对齐，**21% 的 token 在词典里查不到**（要退化成单字/子串再查），并且要 +42 MB 磁盘 +77 MB 内存 + 3.7 s 初始化（claw）。
- CC-CEDICT 最长匹配**零依赖、100% 命中**，代价是边界更碎（把 `回思` 拆成 `回/思`），且它是"词典驱动"而非"语言学驱动"。
- 前端 `Intl.Segmenter('zh')` 速度最快、边界与 jieba 高度一致、92% token 能命中 CC-CEDICT，**零安装**；缺点是依赖浏览器 ICU 数据版本，且偶尔有 `他在`/`天然/气` 这类错误。

**查义流程的真正需求是"用户点到的那个字属于哪个词"，不是"整段完美分词"**——成熟阅读器（Yomitan / 10ten / Pleco）都是**以词典为准的最长匹配**。实测按此流程（取句中随机位置、在 ≤6 字窗口内做最长匹配再查库）：

| 流程 | 本机 p50 / p99 | claw p50 / p99 | 命中率 |
|---|---|---|---|
| 中文：点字 → 窗口最长匹配 → `SELECT ... WHERE simp=? OR trad=?` | **15.5 / 34.6 µs** | **79.6 / 155.7 µs** | 81.2%（其余退到单字 + Unihan） |

### 3.4 日文按词查义 + 活用还原

SplitMode C 下三种引擎的还原能力（同一句）：

```
原文      東京都に住んでいます。定める 食べられなかった 生僻
Sudachi   東京/都/に/住ん[住む,スン]/で/い[いる,イ]/ます/。/定める[定める,サダメル]/食べ[食べる,タベ]/られ/なかっ[ない]/た
Janome    東京/都/に/住ん[住む,スン]/で/い[いる]/ます/。/定める[定める,サダメル]/食べ[食べる]/られ/なかっ[ない]/た
fugashi   東京/都/に/住ん[住む,スン]/で/い[居る,イ](unidic lemma)/ます/。/定める[定める,サダメル]/食べ[食べる]/られ/なかっ[ない]/た
```

三者都能给出 `dictionary_form`（住む / 食べる / ない），**也都能正确读 定める→サダメル**（这一点对 ADR 0004 的读音归一化也有价值）。

用 Sudachi 把《坊っちゃん》整篇分词（58,005 token，C 模式，653 K chars/s），再统计**内容词（名詞/動詞/形容詞/副詞，23,219 个）在 JMdict 里的命中率**：

| 查询键 | 命中率 |
|---|---|
| 直接用 surface（表层形） | 83.7% |
| `normalized_form` | **98.0%** |
| `dictionary_form`（活用还原） | 96.8% |
| `reading_form`（假名） | 85.6% |

→ **查词链条：surface → normalized_form → dictionary_form → reading_form，逐级回退，实测端到端命中 93.4%**（claw p50 283 µs / p99 612 µs，含分词）。

> 生僻字在日文侧：Sudachi 会把 `生僻` 拆成 `生`+`僻`，JMdict 对这两字单独都有条目；整词查不到时按字回退即可（与中文同一策略）。

### 3.5 前端方案的对照（Kuromoji / BudouX / Intl.Segmenter）

| 方案 | 是什么 | 体积 | 许可 | 结论 |
|---|---|---|---|---|
| **`Intl.Segmenter`**（word 粒度） | 浏览器内建，[ECMA-402 规范](https://tc39.es/ecma402/#segmenter-objects)；MDN BCD 支持：Chrome 87 / Firefox 125 / Safari 14.1 / Node 16 | 0 | 内建 | **中文可用**（2.77 M chars/s，92.2% CEDICT 命中，边界与 jieba 91.9% 一致）；**日文不可用**：`東京都に住んでいます` → `東京/都/に/住/んで/い/ます`，既无词也无活用还原 |
| **Kuromoji.js** | JS 版 MeCab | npm `kuromoji@0.1.2` **unpackedSize 41.3 MB**（含 ipadic + doublearray） | Apache-2.0 | 41 MB 的 PWA 负载太重；npm 最后发布 **2018-03-19**，已停更 |
| **BudouX** | *不是*分词器——README 自述 "line break organizer tool"、"independent of word segmenters"，模型约 15 KB | npm `budoux@0.9.2` unpacked 2.69 MB | Apache-2.0 | 用于**断行禁则**可以，**不能用来查词** |

---

## 4. 存储与查询

### 4.1 `sqlite3` 与 FTS5（Python 3.14 实测）

- 本机：`sqlite3.sqlite_version = 3.53.4`，`sqlite_compileoption_used('ENABLE_FTS5') = 1`，`CREATE VIRTUAL TABLE ... USING fts5(...)` 成功。
- claw：`3.53.1`，同样 `ENABLE_FTS5 = 1`，建表成功。
- ⇒ **FTS5 可用**（Arch 的 system Python 带 `libsqlite3`/静态编译均含 FTS5；Python 3.14 也不影响）。

### 4.2 但 FTS5 对中文是错工具（实测 token 级证据）

```
unicode61  tokenize('塔里木盆地发现了大量石油') → ['塔里木盆地发现了大量石油']   ← 整段一个 token
           MATCH '石油' → 0 命中；MATCH '大量石油' → 0 命中
trigram    tokens → 塔里木 | 里木盆 | 木盆地 | 盆地发 | 地发现 | 现了大 | 发现了 | 了大量 | 大量石 | 量石油
           MATCH '里木盆' → 1 命中；MATCH '石油'（2 字）→ 0 命中
```

- `unicode61` 把连续 CJK 当成**一个** token → 任何子串查询都查不到；
- `trigram` 只能查 **≥3 字**的子串，**2 字词（绝大多数中文词）查不到**；
- 若将来真要做"释义全文检索"，正确做法是**入库前用 jieba/Sudachi 预分词、以空格连接存进 `unicode61` 列**，或把查询限制在 ≥3 字。

### 4.3 落库体积与构建耗时（实测，脚本见附录）

| 库 | 内容 | 体积 | 构建 |
|---|---|---|---|
| `zh.sqlite` | CC-CEDICT 125,073 行（`trad`/`simp` 两列各建索引）+ Unihan 102,999 字（cp/mandarin/definition/hanyu_pinyin/trad_var/simp_var/strokes/radical） | **18.3 MB** | **1.6 s** |
| `ja.sqlite` | JMdict 218,786 条 / 499,151 个形式 / 253,614 义项（`forms(text)` 建索引） | **49.8 MB** | **4.5 s** |
| `kanji.sqlite` | KANJIDIC2 13,108 字 | **0.9 MB** | 0.9 s |
| `en.sqlite` | ECDICT 770,611 条（`word` 为主键） | **81.8 MB** | **5.0 s** |
| （对照）`zh_fts5.sqlite` | 词条 gloss + Unihan 释义做 `trigram` FTS5，228,072 行 | **41.2 MB**（比不建 FTS5 的 18.3 MB 多 **+23 MB**） | 1.7 s |

### 4.4 单次查询延迟（实测 p50/p99，单位 µs）

| 查询 | 本机 p50 / p99 | claw p50 / p99 |
|---|---|---|
| `cedict` 按简体头 | 10.5 / 24.6 | — |
| `cedict` 按繁体头 | 10.5 / 31.3 | — |
| `char` 按码位（Unihan） | 9.5 / 30.0 | — |
| `cedict` 未命中（随机 1–3 汉字） | 8.7 / 25.1 | — |
| `forms` 按 JMdict 形式 | 10.6 / 27.4 | — |
| `ecdict` 按单词 | 10.9 / 26.2 | — |
| 中文端到端（点字→最长匹配→查询） | 15.5 / 34.6 | **79.6 / 155.7** |
| 日文端到端（点字→Sudachi C→JMdict） | 54.0 / 143.7 | **283.5 / 612.5** |
| 英文端到端（单词→ECDICT） | 11.3 / 19.2 | **62.5 / 121.1** |

**claw 上最坏 0.6 ms/次**，对"点一下等结果"完全无感；瓶颈不在数据库，在 J1900 的 CPU（Sudachi 分词占日文路径的大部分）。

### 4.5 内存（claw 实测，逐步累加 RSS）

```
fresh python                        13 MB
+ zh.sqlite (18 MB, mmap 预热)      16 MB
+ ja.sqlite (50 MB)                 28 MB
+ en.sqlite (82 MB)                 44 MB
+ SudachiPy core 词典加载          128 MB   (+84 MB)
+ jieba 初始化（并切 20 万字）      305 MB   (+177 MB)
（整套跑完后 VmHWM 峰值）           323 MB
```

本机同样组合（4 库 + Sudachi + CEDICT 词表 set）峰值 **335 MB**；不装 jieba 的 idle 常驻约 **130 MB**（Sudachi 是唯一大头）。mmap 的页面计入 RSS 但可回收，claw 当前空闲 837 MB，**装得下，但不是零成本**。

### 4.6 是否需要预计算拼音/读音索引？

- **v1 不需要**：CC-CEDICT 本身带 `[pinyin]` 字段（每条都有），Unihan 带 `kMandarin`（44,355 字），日文 JMdict 带假名读音，英文 ECDICT 带音标——**"查义顺带读音"不需要额外索引**。
- 只有当出现"按拼音反查"（输入 `shiyou` → 石油）或"按假名反查"时才需要：那时用 `pypinyin` 0.55.0（MIT，3.8 MB，实测 134,529 chars/s 批量、20,000 次单字查询 0.23 s）在构建期生成一列**去声调拼音**并建索引即可，代价约 +3.8 MB 依赖与几秒建库时间。

---

## 5. 推荐：最小 v1 与"以后再加"

### 5.1 v1 该在 claw 上装什么

| # | 内容 | 具体动作 | 代价（实测） |
|---|---|---|---|
| 1 | 日文分词器 | `pip install sudachipy sudachidict_core`（进应用 venv） | claw 上含 jieba 一起装 46 s；仅这两个约 **+220 MB 磁盘**、idle **+84 MB RSS** |
| 2 | 中文词典 | 构建期下载 `cedict_1_0_ts_utf-8_mdbg.txt.gz` → `zh.sqlite` | 3.97 MB 下载、1.6 s 构建、18.3 MB 落库 |
| 3 | 生僻字兜底 | 同一 URL 的 `Unihan.zip` 并进 `zh.sqlite` | 8.34 MB 下载、41k 读音 / 23k 释义、约 +6 MB |
| 4 | 日文词典 | `JMdict_e.gz` → `ja.sqlite`；`kanjidic2.xml.gz` → `kanji.sqlite` | 12 MB 下载、5.4 s 构建、50.7 MB 落库 |
| 5 | 英文词典 | `ecdict.csv` → `en.sqlite`（含 `exchange` lemma） | 65.9 MB 下载、5 s 构建、81.8 MB 落库 |
| 6 | 查词解析 | 中文=窗口内 CC-CEDICT 最长匹配（或前端 `Intl.Segmenter('zh')` 传词）；日文=Sudachi C + surface→normalized→dictionary→reading 回退；英文=小写精确匹配 + `0:lemma` 回退 | 纯 stdlib，0 依赖 |
| 7 | 存储 | stdlib `sqlite3` + 普通索引；**v1 不建 FTS5** | 省 23 MB（中文）与建库时间 |

**合计**：磁盘 ≈ **370 MB**（venv 220 + 数据 151），空闲内存 ≈ **130 MB**，最坏单词查询 < 1 ms（claw J1900 实测）。

### 5.2 明确不进 v1 的东西与它们的代价

| 选项 | 代价 | 什么时候才值得加 |
|---|---|---|
| jieba | +42 MB 磁盘、+77 MB RSS、claw 初始化 3.7 s、45 K chars/s | 需要"整段词语标注/词性"而不仅是"点查"时 |
| fugashi + unidic-lite | +250 MB 磁盘、+180 MB RSS（更快、活用/读音更细） | 觉得 Sudachi 的切分或读音不够用时（但 UniDic 是 2013 年旧版） |
| Janome | +257 MB、25 K chars/s（比 Sudachi 慢 ~40 倍） | 只有在"禁止编译依赖/必须纯 Python"时 |
| opencc（官方） | +2.4 MB、4 s 装、12.6 M chars/s | 想统一处理异体字/地区用字时（v1 有 Unihan 变体关系兜底 1,283 字） |
| WordNet / OEWN 2025 | 34 MB / 9.6 MB | 英文要同义词集、词义网络时 |
| 康熙字典数据集 | 6.4–14.1 MB，许可与结构都不干净 | 除非有人把 Unihan `kKangXi` 指针 + 可靠文本对齐好 |
| MOE《重编国语辞典》(g0v) | JSON，体量小 | 想要**汉-汉**释义时；注意 **CC BY-ND：只能原样展示** |
| FTS5 释义全文检索 | 中文 +23 MB，且需 ≥3 字或预分词 | 想"搜释义里的词"时（届时请预分词后存 `unicode61`） |
| 拼音/假名反查索引 | +pypinyin 3.8 MB + 建库时间 | 想支持输入拼音查词时 |
| `jmdict-eng-common` (1.4 MB JSON) | 极小 | 想把**日文常用词查义搬到前端**、离线也能查时 |

### 5.3 许可层面的必做动作（不是技术问题，但会咬人）

1. CC-CEDICT / JMdict / KANJIDIC2 都是 **CC BY-SA 4.0**：App 的"关于/致谢"页 + 后端文档里要**署名并附许可链接**；若把衍生词典再分发，衍生品必须同许可。
2. **Unicode License V3**：分发数据时需随附版权与许可声明。
3. SudachiDict 的 **LEGAL** 文本要保留（内含 UniDic 的 BSD 声明）。
4. ECDICT：仓库是 MIT，但内容是多来源拼合（README 自述），对外分发前要额外评估。
5. MOE 词典：**CC BY-ND（禁止改作）**——只读展示。

---

## 6. 没能验证 / 风险

1. **康熙字典系数据集未做条目级解析**：`kangxizidian-v3f.txt`（14.1 MB）与 `kx_full.xlsx`（6.4 MB）的**内容质量、字头切分、与 Unihan 的对齐**我没有验证，只核了体积与许可。上面的"不进 v1"是基于"没有维护中的机读版本 + 释义为文言文"的判断，不是基于解析结果。
2. **ECDICT 内容的底层版权来源**无法从一手来源确证（README 自述来自 EDictAZ/词表/cdict 等），只能确认仓库声明 MIT。
3. **前端 `Intl.Segmenter` 只在 Node 26 / ICU 78.3 上实测**；各浏览器 ICU 数据版本不同（尤其中文词表），中文边界质量需在目标设备（平板 Safari / Android WebView）复测。日文质量差是规范级现象（ICU 主要做断行而非词典切分），不太可能因版本改善。
4. **Janome / fugashi / unidic-lite / opencc 只在开发机真装真跑**；claw 上只实测了 `sudachipy + sudachidict_core + jieba`（同一 cp314 ABI、同一 Python 3.14 系列，wheel 均存在，但未在 J1900 上跑满整套）。
5. **Kuromoji.js 的 41.3 MB 是 npm 元数据 `unpackedSize`**，不是浏览器运行时实测内存/加载耗时。
6. **FTS5 部分的结论来自 token dump + 落库体积实测**（真实语料 228,072 行），没有做检索质量/召回率评估。
7. SudachiPy **49,149 字节/次** 的输入上限来自报错信息本身，官方文档条目我没有逐一核对。
8. **claw 现状的观察（非本次改动）**：`/srv/learnbuddy/.venv/lib/python3.14/site-packages` 里**已经存在** `sudachipy 0.6.11` + `sudachidict_core 20260723`（该 venv 226 MB），而仓库里**没有任何 requirements 文件**（后端 README 写的是 stdlib-only）。这看起来是一次遗留实验装进了生产 venv，建议在实现票里对齐"依赖如何声明与部署"（本次未改动 claw 上任何文件）。

---

## 附录：可复现命令

```bash
# 环境
python3 -V                      # 3.14.7 (dev) / 3.14.5 (claw)
python3 -c "import sqlite3; print(sqlite3.sqlite_version, sqlite3.connect(':memory:').execute(\"select sqlite_compileoption_used('ENABLE_FTS5')\").fetchone())"

# 临时 venv（用完删除）
python3 -m venv /tmp/lk/venv
/tmp/lk/venv/bin/pip install jieba sudachipy sudachidict_core janome fugashi unidic-lite pypinyin opencc-python-reimplemented
python3 -m venv /tmp/lk/v4 && /tmp/lk/v4/bin/pip install opencc      # 官方 OpenCC（C++ 绑定）

# 数据（一手地址）
curl -sSL -o cedict.gz  https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
curl -sSL -o Unihan.zip https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip
curl -sSL -o JMdict_e.gz https://www.edrdg.org/pub/Nihongo/JMdict_e.gz      # 注意：ftp.edrdg.org 证书 CN 不匹配，用 www.edrdg.org
curl -sSL -o kanjidic2.xml.gz https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz
curl -sSL -o ecdict.csv https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv
curl -sSL -o WNdb-3.0.tar.gz https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz   # 内含 WordNet-3.0/LICENSE

# 语料（公有领域）：红楼梦 https://www.gutenberg.org/cache/epub/24264/pg24264.txt
#                    坊っちゃん https://www.aozora.gr.jp/cards/000148/files/752_14964.html (Shift_JIS)

# 中文分词器对照（Node 侧）
node -e "const s=new Intl.Segmenter('zh',{granularity:'word'});console.log([...s.segment('他在塔里木盆地发现了大量石油和天然气')].map(x=>x.segment).join('/'))"

# FTS5 中文坑（token 级证据）
python3 - <<'EOF'
import sqlite3
c=sqlite3.connect(':memory:')
for tok in ('unicode61','trigram'):
    c.execute(f"CREATE VIRTUAL TABLE t USING fts5(body, tokenize='{tok}')")
    c.execute("INSERT INTO t(body) VALUES ('塔里木盆地发现了大量石油')")
    c.execute("CREATE VIRTUAL TABLE v USING fts5vocab(t,'row')")
    print(tok, [r[0] for r in c.execute('SELECT term FROM v')])
    print('  石油 →', c.execute("SELECT count(*) FROM t WHERE t MATCH '石油'").fetchone()[0])
    c.execute('DROP TABLE v'); c.execute('DROP TABLE t')
EOF
```

claw 上验证（实验在 `/tmp`，验完删除）：
```bash
ssh claw 'python3 -m venv /tmp/lkvenv && /tmp/lkvenv/bin/pip install -q sudachipy sudachidict_core jieba'   # 46 s
ssh claw '/tmp/lkvenv/bin/python -c "from sudachipy import Dictionary,SplitMode; print([ (m.surface(),m.dictionary_form()) for m in Dictionary(dict=\"core\").create().tokenize(\"住んでいます\",SplitMode.C)])"'
ssh claw 'rm -rf /tmp/lkvenv /tmp/lk /tmp/jieba.cache'
```
