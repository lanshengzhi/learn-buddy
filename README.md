# LearnBuddy

LearnBuddy 是一个家庭使用的 Web/PWA 语言阅读器：粘贴文本 → 断句 → 点句听音。部署目标为 claw（家庭服务器）；本仓库同时包含前端与后端源码。

详见 `CONTEXT.md`（术语表）与 `docs/adr/0001-learnbuddy-web-architecture.md`（架构决策）。

## 结构

```
web/      静态前端（vanilla TS/ES modules，无构建；含 Service Worker 与 PWA manifest）
server/   Python 后端：GET /tts 代理（Azure/Edge，ADR 0005）+ 服务端音频缓存
          + 书籍/档案/学习记录 API（ADR 0007）+ 静态托管
          tts_server.py  路由与 HTTP；library.py 落盘；epub.py/textseg.py 书籍解析
tests/    node --test 前端纯逻辑测试（断句/语言检测/历史/语速/循环状态机/错误映射）
```

## 本地运行

```bash
python3 server/tts_server.py --port 8000
```

打开 http://localhost:8000/ 。参数：

- `--port`（默认 8000）
- `--static <dir>`（默认 `web/`，相对仓库根）
- `--cache-dir <dir>`（默认 `server/cache/`，已 gitignore）
- `--data-dir <dir>`（默认 `server/data/`：`profiles.json`、`state/`、`books/`，已 gitignore，部署排除）

首次启动会在数据目录里写入四个 seed 档案（`dad` / `mom` / `d1` / `d2`）。

**日语书的解析需要 SudachiPy**（分词与 ruby；en/zh 书不需要）：

```bash
python3 -m venv .venv
.venv/bin/pip install -r server/requirements.txt
.venv/bin/python server/tts_server.py --port 8000
```

## 测试

```bash
node --test          # 前端纯逻辑（断句对照、语言检测、历史、语速、循环状态机…）
# 后端：venv 里跑全量（含 fixture epub 的日语解析）
(cd server && ../.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v)
# 没有 sudachipy 时：日语解析用例 skip，其余全绿
(cd server && python3 -m unittest discover -s tests -p 'test_*.py' -v)
```

浏览器冒烟（需本机 playwright + chromium；先起后端）：

```bash
python3 server/tts_server.py --port 8123 &
node scripts/browser-smoke.mjs
```

冒烟覆盖：粘贴→断句→点听（真实 Edge TTS 合成）、循环/语速持久化、历史增删、Service Worker 注册、**离线回放**（断网后从 SW 音频缓存重播）。

## API

`GET /tts?text=<urlencoded>&voice=<voice>&rate=<rate>` → `audio/mpeg`（服务端缓存命中直接返回）。`voice` 省略时按 `lang`（en/ja/zh）取默认 Neural 声；均省略时用 en。日语（ja-JP 声）先经读音归一化（`server/reading.py`，ADR 0004）：汉字默认直通（保留 Edge 词典声调），仅替换已确认会读错的词（替换表）；en/zh 直通。错误以 JSON `{"error": "<code>"}` 返回：`empty_text` / `text_too_long` / `invalid_voice` / `invalid_rate` / `upstream_unavailable` / `upstream_timeout` / `network_failure`。

后端维护 Edge 上游的 UA 门控、单次重试、~3s 连接节奏与 403 时钟偏差重试。

### 书库 / 档案 / 学习记录（ADR 0007）

路径说明「要什么」，查询参数 `?profile=<id>` 说明「谁在问」（`GET /books/<id>` 除外）。响应均 `Cache-Control: no-store`。

| 方法 + 路径 | 作用 |
|---|---|
| `GET /profiles` | 档案清单（seed：dad/mom/d1/d2） |
| `GET|PUT /state?profile=` | 偏好小抽屉 `{rate_preset, loop_mode, lastBook}`；PUT 只发改的项，返回合并结果 |
| `GET|POST /history?profile=` | 粘贴记录（≤50，最新在前）；POST `{text}` → `{entry, trimmed}` |
| `PATCH|DELETE /history/<id>?profile=` | 改 `{favorite?, selectedIndex?}`；删 → 204 |
| `GET|POST /words?profile=` | 词表 `{words:["ja:食べる"]}`；POST `{add, remove}` |
| `GET /books?profile=` | 书单，每本带这个档案的 `reading:{chapter,sentence}`（没读过为 null） |
| `POST /books?profile=&name=x.epub` | 原始 epub 体直传（非 multipart）；新建 201 / 重复 200 + `duplicate:true` |
| `GET /books/<id>` | 书资料 + 目录（不含正文） |
| `GET /books/<id>/chapters/<n>?profile=` | 一章正文 + `reading:{sentence}` |
| `PUT /books/<id>/position?profile=` | `{chapter, sentence}` → 204 |

上传按字节 SHA-256 去重（书 id 与目录名），上限 100MB；解析在**上传时同步完成**，产物是句子 + 词长数组 + ruby 注解（JA 用 Sudachi，EN 规则切分）。落盘布局：

```
<data-dir>/profiles.json
<data-dir>/state/<profile>/{prefs,history,words}.json
<data-dir>/books/<sha256>/{book.epub,manifest.json,chapters/NNNN.json,positions/<profile>.json}
```

错误码（JSON `{"error": "<code>"}` + HTTP）：`bad_request`(400)、`profile_not_found` / `book_not_found` / `chapter_not_found` / `entry_not_found` / `not_found`(404)、`too_large`(413)、`not_epub`(415)、`parse_failed`(422)、`unknown`(500)。
