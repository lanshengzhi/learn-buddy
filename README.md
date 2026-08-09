# LearnBuddy

LearnBuddy 是一个家庭使用的 Web/PWA 语言阅读器：粘贴文本 → 断句 → 点句听音。部署目标为 claw（家庭服务器）；本仓库同时包含前端与后端源码。

详见 `CONTEXT.md`（术语表）与 `docs/adr/0001-learnbuddy-web-architecture.md`（架构决策）。

## 结构

```
web/      静态前端（vanilla TS/ES modules，无构建；含 Service Worker 与 PWA manifest）
server/   Python 后端（stdlib-only）：GET /tts 代理 Edge TTS + 服务端音频缓存 + 静态托管
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

## 测试

```bash
node --test          # 前端纯逻辑（断句对照、语言检测、历史、语速、循环状态机…）
(cd server && python3 -m unittest discover -s tests -p 'test_*.py' -v)   # 后端（无网络依赖）
```

浏览器冒烟（需本机 playwright + chromium；先起后端）：

```bash
python3 server/tts_server.py --port 8123 &
node scripts/browser-smoke.mjs
```

冒烟覆盖：粘贴→断句→点听（真实 Edge TTS 合成）、循环/语速持久化、历史增删、Service Worker 注册、**离线回放**（断网后从 SW 音频缓存重播）。

## API

`GET /tts?text=<urlencoded>&voice=<voice>&rate=<rate>` → `audio/mpeg`（服务端缓存命中直接返回）。`voice` 省略时按 `lang`（en/ja/zh）取默认 Neural 声；均省略时用 en。错误以 JSON `{"error": "<code>"}` 返回：`empty_text` / `text_too_long` / `invalid_voice` / `invalid_rate` / `upstream_unavailable` / `upstream_timeout` / `network_failure`。

后端维护 Edge 上游的 UA 门控、单次重试、~3s 连接节奏与 403 时钟偏差重试。
