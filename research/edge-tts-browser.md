# 浏览器直连 Edge TTS 可行性验证

> Research ticket: [浏览器直连 Edge TTS 可行性验证](https://github.com/lanshengzhi/learn-buddy/issues/2)
> 分支：`research/edge-tts-browser` · 日期：2026-08-08 · 复跑脚本：`research/edge-tts-browser/` 目录下
> 结论来源：本地实证（真实握手 + 完整合成）+ dasan Android 实现 + [rany2/edge-tts](https://github.com/rany2/edge-tts) 源码

## 一句话结论

**有条件可行，但不可作为家庭设备的默认路径。** 端点用 **User-Agent 门控**：只有**当前版本的 Microsoft Edge 系 UA**（`Edg/143`、`EdgA/143`、`EdgiOS/143`）能通过握手；Chrome、Firefox、iPhone Safari、curl 一律 403。浏览器无法在 WebSocket 握手时改自己的 UA，所以 iPhone Safari、Android/桌面 Chrome 的页面**无法直连**。可靠架构是**在 claw 上放一个很小的 WS 中继**（浏览器 → claw → Edge TTS，中继带上合法 Edge UA）。协议本身不需要自定义头（令牌全在查询串），且从明文 HTTP 页面发 `wss://` 被浏览器允许。

## 协议事实（与 Android/edge-tts 完全一致）

- 端点：`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
- 查询串携带全部令牌（**无自定义头要求**）：
  - `TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4`
  - `Sec-MS-GEC=<SHA-256 hex 大写>`，算法：`(当前 Unix 秒向下取整到 300s + 11644473600) × 10_000_000` 的整数串拼接 TrustedClientToken 后做 SHA-256，转大写十六进制
  - `Sec-MS-GEC-Version=1-143.0.3650.75`（当前 Chromium 143）
  - `ConnectionId=<32位hex>`
- 与 Android `EdgeTtsProtocol.kt` 和 edge-tts `drm.py`/`constants.py` 逐字段核对一致（含 `CHROMIUM_FULL_VERSION = "143.0.3650.75"`）。
- 建连后：先发 `speech.config`，再发 `ssml`（`X-RequestId`/`Content-Type:application/ssml+xml`/`Path:ssml`），收二进制帧（头 2 字节大端长度 → 头块含 `Path:audio` 与 `Content-Type:audio/mpeg` → MP3 数据）。实测拿到 **49 帧 / 34,848 字节合法 MPEG-1 Layer III 音频**（`ff f3` 帧同步，可播）。

## 实证矩阵（本机真实连接，2026-08-08，东京节点）

| UA | 握手结果 |
|---|---|
| `... Edg/143.0.0.0`（桌面 Edge，当前版） | **101**（5/5，含间隔节奏） |
| `... EdgA/143.0.0.0`（Android Edge） | **101** |
| `... EdgiOS/143.0.0.0`（iOS Edge） | **101** |
| `Chrome/143` 桌面 / Android mobile | **403** |
| `Chrome/126` 桌面 / Android mobile | **403** |
| `Firefox/127` | **403** |
| iPhone Safari（`Version/18.0`） | **403** |
| curl 默认 UA / `User-Agent: node` | **403** |

其他变量（不变项）：
- **Origin 不检查**：`Origin: chrome-extension://...`、`https://home-srv.tailf905b5.ts.net`、`http://192.168.3.28:8000`、甚至**缺省 Origin**，只要 UA 合格都是 101。
- `Sec-MS-GEC-Version` 参数与 UA 不强制匹配（`Edg/143` + `1-126.0.0.0` 也 101）。
- 握手只缺 UA 一项也可复用：无需 `Cookie: muid`、`Pragma`/`Cache-Control`、`Accept-Encoding`/`Accept-Language`（纯 `GET + Upgrade + Sec-WebSocket-Key + UA` 即通）。
- 从明文 HTTP 页面发 `wss://`：浏览器混合内容规则**允许**（`wss` 视为安全传输，从非安全页面发起不拦截；`ws://` 从 HTTPS 页面发起才被拦）。

## 噪声与不稳定

- **限流噪声**：快速连发（约 1 秒间隔连续打）会让合法 `Edg/143` 也间歇性 403；拉到 ~3 秒间隔后 5/5 通过。应用侧应避免高频重连（Android 现有实现逐句重连的模式在 Web 侧要谨慎，或靠中继集中管理连接）。
- **上游易变**：`Sec-MS-GEC` 令牌与版本常量、UA 门控策略均由微软侧不定期调整（edge-tts 社区靠升级常量维持）。中继化后升级点集中在一处。

## 对架构票（issue #3）的关键提示

1. **放弃"零后端静态 SPA"前提**：直连只对 Edge 系浏览器成立；家庭设备（iPhone Safari、Android Chrome、桌面 Chrome）直连必 403。
2. **推荐：claw 上跑一个单用途 WS 中继**（浏览器 `ws://192.168.3.28:<port>/tts` 或 `wss://home-srv.tailf905b5.ts.net/tts` → claw 用合法 Edge UA 连 Edge TTS → 原样转发帧）。中继很小（协议透传），claw 只有 Python 3.14，可考虑 `uv` + `websockets`/`edge-tts` 实现（部署细节归「claw 部署与运行」票）。
3. **降级选项**：Edge 系浏览器可走直连（页面按 `navigator.userAgent` 检测 `Edg/`），其余浏览器走中继 —— 但这增加两套路径；家庭场景建议统一走中继。Web Speech API（系统 TTS）仅可作无网/应急兜底，音质与语速档位与 Edge TTS 不等价。
4. 中继也让未来的协议升级（令牌算法、版本常量）只改一处。

## 复跑方法

- `research/edge-tts-browser/raw-ws-client.js`：无依赖 Node 脚本，自定义头 + 完整 speech.config/ssml 流程，产出 `/tmp/edge-tts-e2e.mp3`（**已验证产出 34,848 字节合法 MP3**）。
- `research/edge-tts-browser/ws-test.js`：`new WebSocket(url)`（浏览器约束，无法自定义头）—— 预期失败（UA 为 `node`），用于演示"纯浏览器调用"边界。
- `research/edge-tts-browser/echo-server.js`：本地回显服务器，用来观察 WHATWG WebSocket 实际发送的握手头（无 Origin、`user-agent: node`）。
- 单测握手矩阵用 `curl --http1.1` + `Upgrade: websocket` + 随机 `Sec-WebSocket-Key` + 新鲜 `Sec-MS-GEC` 即可复现 101/403。

## 一手来源

- [rany2/edge-tts `src/edge_tts/constants.py`](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/constants.py)（BASE_URL/TRUSTED_CLIENT_TOKEN/WSS_URL/SEC_MS_GEC_VERSION/UA 常量）
- [rany2/edge-tts `src/edge_tts/drm.py`](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py)（`generate_sec_ms_gec` 算法、`WIN_EPOCH=11644473600`、5 分钟取整）
- [rany2/edge-tts `src/edge_tts/communicate.py`](https://github.com/rany2/edge-tts/blob/master/src/edge_tts/communicate.py)（`WSS_URL&ConnectionId&Sec-MS-GEC&Sec-MS-GEC-Version` 拼接）
- dasan Android 实现：`~/Work/dasan/android/app/src/main/java/com/example/languagereader/data/tts/EdgeTtsProtocol.kt`（与上列逐字段一致）
- 本机实证：见上方矩阵（端点 2026-08-08 实际行为）
