# DSH 与 pi 的能力、凭据与成本对照

> Ticket: [#24](https://github.com/lanshengzhi/learn-buddy/issues/24)（`wayfinder:research`）· 父票 [#23](https://github.com/lanshengzhi/learn-buddy/issues/23)
> 分支：`research/dsh-vs-pi` · 日期：2026-09-22 · 方法：一手来源（两份代码的源码 + 本机实跑）为主，外部文档明确标注
> **本票不做「承载栈与壳的归属」决议**（那是 #29 的事）。这里只交事实、代价与不确定项。

一手来源清单：

| 代号 | 是什么 | 版本 / 位置 |
|---|---|---|
| **DSH‑src** | DSH 源码检出（只读） | `/home/lansy/Work/github/deepseek-harness` @ `ddefc45`，包版本 `0.1.6-alpha.2`；下文路径均相对此目录 |
| **DSH‑pub** | 本机 `dsh` CLI 实际运行的发布版 | `/home/lansy/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/*`，`0.1.5-rc.2` |
| **pi** | pi coding agent | `ai-service/node_modules/@earendil-works/pi-coding-agent` `0.85.1` |
| **pi‑ai** | pi 的 LLM 库（pi 的内嵌依赖） | `ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai` `0.85.1` |
| **LB** | LearnBuddy 工作检出 | `feat/quiet-reader-ui` @ `5e86e06`（`deploy/`、ADR 0010 尚未在 `origin/master` 上） |

本机环境：Node v26.7.0、Linux、`dsh --version` = `0.1.5-rc.2`。凡标 **[实测]** 的结论都有可复跑脚本（§6）。

---

## 0. 一句话结论（四条问题的短答）

1. **凭据**：**不能直接复用**。DSH 里没有任何一行代码读 pi 的 `auth.json` 或 agent dir（全仓库 grep 为空）；DSH 把凭据存在自己的 `$DSH_HOME/.credentials.yaml`，键是 `llm-pi-ai/<provider>`。但**迁移是一次性的机械搬运**：`auth.json` 里那条 openai-codex OAuth 记录塞进 DSH 的 grant 记录后，pi‑ai 原样认（[实测] payload 逐字段相等）。代价是**两边不能同时持有同一份 OAuth 凭据**——refresh token 会轮换，谁先刷新谁让另一个失效。
2. **能力边界**：Python SDK 是**"stdio 子进程 + 只有三个 RPC 方法"**的薄壳（`initialize`/`session/prompt`/`shutdown`），一个进程只能是**一个模型**。能开 N 个 session（线程并发），但只有**事件粒度**的流式（没有 token 增量）、**不能注册工具**、**不能续聊已存 session**、**不能取消**、**不能列/搜/导出 session**、**没有记忆原语**——这些全要 in-process TS/Cordis 插件或 profile row。详情 §2。
3. **常年家庭对话**：落盘与耐久性做得很好（一 session 一 JSONL、原子发布、每批 fsync、内核 flock 写租约），**一年几十 MB 量级、不是磁盘问题**；真正的问题是 **(a) 没有任何删除/裁剪/GC/保留策略，也没有 session 相关 CLI；(b) 只有 session 日志多进程安全，`ctx.storage`（workspace 注册表、投影缓存）是"后写覆盖先写"、跨进程无锁；(c) 一个 `$DSH_HOME` 就是一个信任域，profile 不是数据边界，多人要么分 home/分 OS 用户要么单写者；(d) 全文检索默认关闭且是纯词法。compaction 按 **0.8 × 上下文窗口**触发（DeepSeek 默认 1M ⇒ ~80 万 token），对家庭聊天基本不会触发。详情 §3。
4. **成本**：订阅路线**没有边际成本、也没有可观测的剩余额度**（pi‑ai 只在撞墙时从错误体读 `plan_type`/`resets_at`；`isSubscription` 只影响 UI 上的 `(sub)` 文案）；DSH **完全不携带价格表**（源码注释：no consumer reports spend），也不知道订阅路线不该算钱。**`token-meter` 今天做不了家庭配额**：配置类型为空、没有身份维度、没有硬配额；最接近的原语是"按 session 的 tokenUsage 投影 + `llm/stream` 瀑布钩子写新插件"，或者给每人分发不同的 API key（仅 API-key 类 provider 可行，codex 订阅只有一个 grant）。详情 §4。

---

## 1. 凭据复用（问题 1）

### 1.1 现役 pi 侧的事实

claw 上的 `claw:/var/lib/learnbuddy/ai-agent/` 有三个文件（`LB:ai-service/README.md:19-24`、`LB:docs/adr/0010-system-service-layout-and-runtime-user.md`）：`auth.json`（凭据）、`settings.json`（`defaultProvider`/`defaultModel`）、`models-store.json`（模型目录缓存）。服务侧不是靠 `$HOME` 找到它们的，而是把路径显式传进 pi：

- `LB:ai-service/index.mjs:56-59` — `DefaultResourceLoader({ agentDir: AGENT_DIR, ... })`
- `LB:ai-service/index.mjs:62-65` — `ModelRuntime.create({ authPath: <AGENT_DIR>/auth.json, modelsStorePath: <AGENT_DIR>/models-store.json })`

pi 自己的默认路径是 `<agentDir>/auth.json`、`<agentDir>/settings.json`，`agentDir` 默认 `~/.pi/agent`、可用环境变量覆盖（**pi**:`dist/core/auth-storage.js:19`、`dist/config.js:421-427,440-442`）——也就是说 **agent dir 是 pi 的概念，不是 pi‑ai 的**。

**`auth.json` 的磁盘格式**（**pi**:`dist/core/auth-storage.js:164-215`）：顶层是一个 JSON 对象，键 = provider id，值必须是二者之一：

```jsonc
{ "openai-codex": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1790000000000, "accountId": "…" },
  "some-api-provider": { "type": "api_key", "key": "…", "env": { "…": "…" } } }
```

本机（开发机，非 claw）`~/.pi/agent/auth.json` 现有 5 个 provider：`deepseek`、`kimi-coding`、`openai-codex`、`opencode-go`、`antigravity`；`openai-codex` 那条的字段是 `type, access, refresh, expires, accountId`（**[实测]**，只读、未打印任何 token 值）。注意多出来的 `accountId` 字段——pi‑ai 的 OAuth 凭据类型允许任意附加字段（**pi‑ai**:`dist/auth/types.d.ts:20-30` 的 `[key: string]: unknown`），这一点后面决定了迁移能不能"逐字段照搬"。

**pi 的写锁**（refresh 会原地重写 `auth.json`）：`proper-lockfile` 的**目录锁**，`{ realpath: false, retries: 0, stale: 30_000 }` + 自己的重试循环，锁被判定失联时走 `onCompromised`（**pi**:`dist/core/auth-storage.js:77-90`）。`stale` 是按 mtime 判定并靠后台 `utimes` 续期的，**持有者死掉后锁会自愈**（proper-lockfile `lib/lockfile.js:85,99-167`）。**[实测]** 用一个 mtime 过期的锁目录复现：`stale: 1000` 下 7 ms 就拿到锁。

### 1.2 DSH 侧：凭据存在哪、pi 的 agent dir 为什么看不见

- **DSH 完全不认 pi 的 agent dir。** 在 DSH‑src 全仓库搜 `auth.json` / `.pi/agent` / `agentDir`：`packages/`、`docs/` 里 **0 命中**（`packages/llm/llm-pi-ai` 的 `src/` 与 `README.md` 同样 0 命中）。
- 凭据写进 DSH 自己的凭据面：记录键是 `llm-pi-ai/<provider id>`（DSH‑src:`packages/llm/llm-pi-ai/src/auth.ts:29` `RECORD_SCOPE = 'llm-pi-ai'`；`:36-38` `recordKeyFor`），落在 `$DSH_HOME/.credentials.yaml`（DSH‑src:`packages/credentials/credentials-local/src/index.ts:61,90`；`$DSH_HOME` 缺省 `~/.dsh`，见 `packages/util/home-paths/src/index.ts:61-63,87-91`）。
- **grant 的 payload 对 DSH 是不透明 JSON**：`{ kind: 'grant', payload: unknown }`，凭据面"从不读取、不校验、不重塑 payload"（DSH‑src:`packages/credentials/credentials/src/types.ts:52-60`）。`llm-pi-ai` 写的时候把 pi‑ai 的 OAuth 凭据整个塞进去（`auth.ts:91-100`），读的时候整个还回去（`auth.ts:74-84`）。
- **路由必须先在 settings 里声明**：pi‑ai 适配器的 route 来自 `llm-pi-ai: providers:` 这个字典（DSH‑src:`packages/llm/llm-pi-ai/src/index.ts:161` 的 `resolveProfiles(raw.providers, 'deferred')`；README "The `providers` dictionary is the whole configuration surface"）。所以要用 codex 就得写一条 `providers: { openai-codex: … }`。
- **签名登录是"授权面"（authorization seam）里的一次人机对话**：pi‑ai 装了什么登录方式就提供什么（`src/login.ts:31-34`：`oauth` 优先级最高）；产出的凭据由 `modify()` 落到上面那个记录里。**没有 CLI 登录命令**：`dsh --help` 只有 `web` 和 `plugin` 两个子命令，`/login` 之类的命令行入口在仓库里也搜不到——即**登录要在 DSH 的界面里做**（Web GUI / TUI 的设置面）。
- **ambient 兜底对 codex 不存在**：pi‑ai 的 auth 解析规则是"有存储凭据就以存储凭据为准，只有什么都没有时才看 ambient（环境变量 / AWS profile / ADC 文件）"（**pi‑ai**:`dist/auth/resolve.js:20-55`）；而 DSH 给 pi‑ai 的 `AuthContext` 只会答"凭据面里的引用 + 启动环境变量"和"宿主文件系统上某路径存不存在"（DSH‑src:`packages/llm/llm-pi-ai/src/auth.ts:196-221`）。更关键的是 **openai-codex 这个 provider 根本没有 apiKey 通道**：它的 `auth` 只有 `oauth`（**pi‑ai**:`dist/providers/openai-codex.js:6-21`，且 `isSubscription: true`）。**结论：环境变量救不了它，只能走存储凭据。**

**DSH 上游自己的设计记录确认这是有意为之，不是遗漏**（所以别指望以后版本会加）：

- `.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md:48` 把"把 `~/.codex/auth.json` 读进一个 store"列进**被否决的备选**，理由原文："It makes Codex work without any of this, and pi-ai would own the refresh. It also **binds the harness to another tool's private file format** for one provider, and leaves every other login unbuilt."
- `.agents/notes/archived/bug-fix/2026-08-13-oauth-only-providers-withheld.md:12` 记录了当年的实际事故与结论："pi-ai's `resolveProviderAuth` reaches an OAuth provider through **one path** — a credential already in the collection's `CredentialStore` — and **has no ambient fallback for it**, while `openai-codex` is the one installed provider declaring `auth.oauth` with no `auth.apiKey` beside it."

### 1.3 [实测] DSH 看不见 pi 的 agent dir，但那条 payload 本身是通用的

脚本 `§6/pi-auth-probe/probe.mjs`（用 `$HOME` 指向一个只含 `.pi/agent/auth.json` 的临时目录，绝不碰真实 profile）：

```
provider.auth keys   = [ 'oauth' ]          # 没有 apiKey 通道
ambient fileExists(auth.json) = true        # 文件确实在，且能被看见
A) auth.json 在、CredentialStore 空  -> undefined        ← pi 的 agent dir 完全不可见
B) 同一条 payload 塞进 CredentialStore -> {"auth":{"apiKey":"…"},"source":"OAuth"}
```

`§6/pi-auth-probe/migrate.mjs` 把真实 `~/.pi/agent/auth.json` 里那条记录**只读**取出，渲染成 DSH 的 v1 文档格式，再用**发布版 DSH** 的解析器 `@deepseek-ai/dsh-credentials-local` 的 `parseCredentialsDocument()` 解回来：

```
openai-codex fields         = type, access, refresh, expires, accountId
DSH parse record kind       = grant
payload deep-equals pi entry= true          ← 逐字段相等，含 accountId
resolve with migrated-shaped payload = {"apiKey":"<redacted>"} | source = OAuth
```

即迁移后的文档长这样（`$DSH_HOME/.credentials.yaml`）：

```yaml
version: 1
records:
  llm-pi-ai/openai-codex:
    kind: grant
    payload: { type: oauth, access: …, refresh: …, expires: …, accountId: … }
```

**所以问题 1 的第一问的答案是：不能"直接复用"，但也不需要重新做一次 OAuth 登录——手工/脚本把那一坨 payload 搬过去即可，格式是同一份 pi‑ai 凭据。** 官方路径则是更干净的"在 DSH 界面里重新登录一次"，产出一条**独立的** grant。

### 1.4 但是：两个引擎不能长期共用同一份 OAuth 凭据

- refresh **会轮换 refresh token**：codex 的 token 响应里 `refresh_token` 是**必需字段**，pi‑ai 把它原样存回凭据（**pi‑ai**:`dist/auth/oauth/openai-codex.js:96-111`，`if (!json?.access_token || !json.refresh_token …)` / `refresh: json.refresh_token`）。pi‑ai 的注释也直说刷新会"rotated token"（`dist/auth/resolve.js:64-67`、`dist/auth/credential-store.d.ts` 顶部的 CredentialStore 契约：`Models.getAuth()` 在 `modify()` 里刷新，"concurrent requests cannot double-refresh a rotated token"）。
- 也就是说：**同一个 refresh token 的两份拷贝，谁先刷新谁把对方作废**。把 `auth.json` 复制进 DSH 是一次性的动作，之后两边各自续期就会互踢（后刷的那边大概率拿到 `invalid_grant`）。
- pi‑ai 的 `modify()` 只保证**同一份存储内**不会重复刷新（`resolve.js:77` 在 `credentials.modify` 里做 double-checked locking），跨存储/跨拷贝不在它的保护范围。
- 可选的干净做法：**在 DSH 里重新登录一次**，让两边各持自己的 grant。**未经证实**：同一 ChatGPT 账号是否允许两个并存的 Codex 授权、以及新登录会不会顶掉 pi 那条（OpenAI 侧策略，本次没有查一手文档）。

### 1.5 跨进程 refresh 锁在 systemd 下的行为（DSH vs pi）

DSH 的写者锁是一个 `wx` 独占创建的**兄弟文件** `<file>.lock`（内容写 pid），指数退避 20→200 ms，默认等 2 s（DSH‑src:`packages/util/atomic-write/src/index.ts:126,158-183`）。凭据面把等待时间**专门放大到 30 s**，理由写在注释里：记录写入会在**持锁期间做一次网络往返**（刷新 token）（DSH‑src:`packages/credentials/credentials-local/src/index.ts:112` `DOCUMENT_LOCK_WAIT_MS = 30_000`，`:705,724,785,855` 使用）。

**[实测]**（`§6/pi-auth-probe/lock.mjs`，直接用发布版 `@deepseek-ai/dsh-atomic-write`）：

```
1) 无竞争                -> acquired | 不残留锁
2) 孤儿锁（无人持有）, waitMs=1500 -> atomic-write: timed out waiting for the writer lock at …lock (1508 ms)
   stale lock still present = true | pid inside = 999999
3) 操作员删掉锁之后        -> acquired
```

systemd 下的实际含义（这是与 pi 最尖锐的一处差异）：

- **锁不自愈。** 源码注释明说"竞争者永远不会删掉已存在的锁，因为文件年龄无法证明持有者已经停止；孤儿锁的恢复是**操作员动作**"（DSH‑src:`packages/util/atomic-write/src/index.ts:151`）。如果进程在**持锁刷新 token 的那一瞬间**被 `SIGKILL`（OOM、`systemctl kill -s KILL`、`TimeoutStopSec` 超时后的强杀），`.credentials.yaml.lock` 会留在磁盘上。
- 之后每次凭据写入都要等满 30 s 然后**失败**（fail loud，不是静默损坏）。**读路径无锁**（同文件注释 "readers stay lock-free"），所以在 access token 过期前对话还能继续；一旦进入"距过期不足 5 分钟"的窗口（**pi‑ai**:`dist/auth/resolve.js:62,70-71`），每次请求都要刷新、每次刷新都撞锁 → **服务整体不可用，直到有人手动 `rm` 掉那个 `.lock`**。pi 那边因为用的是 mtime 判定的 `proper-lockfile`（stale 30 s），同样场景会**自己恢复**（§1.1 实测）。
- 另一处部署约束：凭据文档若带 group/other 权限位，DSH **在读取前就拒绝**（DSH‑src:`packages/credentials/credentials-local/src/index.ts:127` `assertOwnerOnly`）。ADR 0010 里 `auth.json` 是 `0600` 手工播种的（`LB:docs/adr/0010-...md`），迁移到 DSH 要沿用同一纪律；deploy 脚本覆盖权限会把服务打死。
- 路径提醒：DSH home 的解析顺序是 显式 config > `$DSH_HOME` > `~/.dsh`（DSH‑src:`packages/util/home-paths/src/index.ts:87-91`）。systemd 单元里 HOME 可能是 `/var/lib/learnbuddy`（ADR 0010 把 `learnbuddy` 的 HOME 挪到了那里），所以**显式设 `DSH_HOME` 比依赖 `~` 更稳**。

### 1.6 迁移/并存的代价清单（只列事实，不选路）

| 事项 | pi（现状） | DSH |
|---|---|---|
| 凭据位置 | `<agent dir>/auth.json`，`{providerId: Credential}` | `$DSH_HOME/.credentials.yaml`，`records["llm-pi-ai/<provider>"]` |
| 载入方式 | 进程内显式传 `authPath`（`ai-service/index.mjs:62-65`） | Cordis 凭据插件（`dsh-credentials-local`），可配 `path`/`dshHome` |
| 复用现役订阅 | — | 需一次性搬运 payload 或重新登录；**两边不能共用同一份 refresh token** |
| 登录入口 | `pi` CLI 内交互 | 只有 DSH 界面（无 CLI 子命令），headless 场景要有人开一次 GUI |
| 刷新写锁 | `proper-lockfile` 目录锁，mtime 续期，**孤儿锁自愈** | `wx` 锁文件，**孤儿锁需人工清理**；凭据写入等待上限 30 s |
| 失效半径 | 单进程 | 所有共享同一 `$DSH_HOME/.credentials.yaml` 的进程（多进程共享一份凭据是有意支持的） |

---

## 2. 能力边界：DSH Python SDK 到底能做什么（问题 2）

包名 `deepseek-harness-sdk`（DSH‑src:`python/sdk/pyproject.toml:6`，模块 `deepseek_harness`，Python ≥ 3.10）。下面每条都对着源码核过（DSH‑src @ `ddefc45`）。

### 2.1 它是什么形态：**stdio 子进程，不是连服务器**

- 传输只有一种：Python 进程 `subprocess.Popen` 拉起一个打包好的 runtime 可执行文件，走换行分隔的 JSON-RPC 2.0（`python/sdk/src/deepseek_harness/client.py:80-90,337`）。**没有 socket / HTTP / `--connect`**，`dsh` CLI 也没有 daemon 子命令（`apps/cli/src/args.ts:153-157`）。
- 线协议只有**三个方法**：`initialize`、`session/prompt`、`shutdown`（`packages/sdk/protocol/src/types.ts:114-119`）。
- profile / patch 在启动 argv 里给（`client.py:458-486`）；`dsh_home` 或 `DSH_HOME` **必填**，不会隐式用 `~/.dsh`（`client.py:471-479`）。
- **provider / model / reasoningEffort / maxTokens 是进程级握手参数**（`client.py:142-157`，协议 `packages/sdk/protocol/src/types.ts:16-27`），被该进程里**所有** session 继承；官方文档明说不支持中途 reinit（`packages/sdk/server/src/server.ts:70-74`）。→ **一个进程只能是一个模型**；要按人/按用途换模型就得换进程。

### 2.2 多会话与并发

- 一个 client 可以开 N 个 session，键是调用方给的字符串 id（`api.py:120-122,137`；runtime 侧 `Map` + 去重，`server.ts:82-83,259-292`）。
- **不是串行一问一答**：请求带 UUID、有 pending map、写锁、单独读线程做分发（`client.py:52-53,272-277,338-340,344-418`）；服务端文档明说请求可并发分发（`packages/sdk/server/README.md:48`），prompt 落到 `agent.followup(message)`（`server.ts:191`）。
- **Python 侧只有同步 + 线程**（`python/sdk/src` 里没有 `async def`/`asyncio`）。`Session.run()` 阻塞到该 session 的下一次整体 `idle`（`api.py:161-181`）——所以**同一个 session id 上并发两次 `run()` 语义未定义**；"多线程 + 每人一个 session id"是它支持的并行模型。并发上限没有文档 **[未找到]**。
- **没有取消/中止**：协议里没有 cancel，只有 `close()` → `shutdown` 把整个 runtime 关掉（`client.py:94-131`）。

### 2.3 流式输出：**到"事件"粒度，不是 token 粒度**

- 交付方式是同步回调 / 订阅队列（`api.py:129,143-159`；`client.py:226-238,539-577`），没有 async iterator。
- 通知只有四种：`session.event`、`session.status`(`idle|running`)、`subagent.started`、`subagent.finished`（`packages/sdk/protocol/src/types.ts:107-112`）。
- `session.event` 装的是完整的 session 事件日志（约 57 种事件：turn/step、user/assistant message、tool/call、tool/result、compaction/*、llm/retry、approval/*、goal/change…，`packages/core/session/src/known-event-types.ts:22-81`）。
- **没有 token 级增量**：助手文本第一次出现是在**已结算**的 `assistant/message` 里（整段流 + `usage`，`packages/core/session/src/types.ts:266-270,321-327`）。→ 家庭聊天要"打字机效果"，走 SDK 拿不到，得用 in-process / Host 的 HTTP+WebSocket 通道（`packages/host/webserver/README.md:12`）。
- 默认单轮**没有超时**（`api.py:34-35`）；runtime 死掉抛 `TransportClosedError` 并附 stderr 尾部（`client.py:420-456`）。

### 2.4 工具调用：**只能看，不能从 Python 提供**

- **能观察**：`tool/call {turn,step,callId,name,arguments}` 与 `tool/result`（`packages/core/session/src/types.ts:341,355-372`）作为 `session.event` 送达。
- **不能注册**：协议里没有工具方法（`types.ts:114-119`），Python 包里也没有工具 API。工具注册表是 in-process Cordis 的 `ctx.tools.register(defineTool(...))`（`packages/core/tools/README.md:28,41`），"profile 组合决定每个根 agent 的工具"（`packages/sdk/server/README.md:40`）。
- 变通路子：profile 里挂 `dsh-mcp-client`，Python 侧自己起一个 MCP server（`packages/mcp/mcp-client/README.md:12`；示例 `scripts/smoke-python-runtime.py:257-273`）——但 `sdk-minimal` profile 不带它（`packages/bundle/sdk-minimal/cordis.patch.yml:94-95`），要自己加 row。
- `HarnessClient.next_request()/respond()` 是通用的"服务端反向请求"通道，但 SDK server 里**没有一处使用**（`packages/sdk/server/src` 下没有 `transport.request(`）——是预留，不是工具钩子。

### 2.5 多人共用一个 DSH home

- **没有共享 daemon / 多客户端模型**：每个 Python 进程各自拉起一个 stdio runtime（`client.py:80`；`python/sdk/README.md:13`）——两个进程 = 两个 runtime 压在同一个 storage root 上。
- **不同 session：安全。** 每个 session 有内核 `flock(2)` 的 `session.lock`，"一个 session 只有一个活写者"，跨进程生效（`packages/session/session-persistence-jsonl/README.md:160`、`.../src/lease.ts:2-23,40`）。
- **同一个 session id 被两个活 runtime 打开：第二个会失败。** SDK server 永远走 `ctx.agents.create()`，从不 `resume()`；后端 `create()` 在该 root 下已存在同 id 日志时抛 `SessionAlreadyExistsError`（`packages/session/session-persistence-jsonl/src/index.ts:308-320`，id 扫描 `:1408-1423`），且没人 catch。**[源码核实，未实跑]**
- `dsh web` 是另一个 app，文档明说**不能**给 Python SDK 客户端当服务端（`docs/user/guide/python-sdk.md:182`）**[文档口径]**；SQLite 检索索引同一路径只能有一个进程持有（`packages/session-query/session-query-sqlite/README.md:12`），base profile 里默认就是 `path: ':memory:'`、`openAt: never`（`packages/bundle/base/cordis.patch.yml:136-139`）。

### 2.6 持久化与检索

- 落盘布局：`<root>/--<规范化cwd>--/<编码后的 id>/session.vN.jsonl[.zstd]`，**追加写、一行一事件、已提交的 generation 永不重写**（`packages/session/session-persistence-jsonl/README.md:54-70`；`docs/architecture.md:123`）；`root` 必填，`compression` 默认 `'zstd'`（同 README `:43,:48`）。root 指 `$DSH_HOME/sessions`（`packages/bundle/base/cordis.patch.yml:117-120`；`sdk-minimal` 里 `compression: none`，`sdk-minimal/cordis.patch.yml:154-158`）。
- **Python 只能"在活着的 runtime 里"创建/继续 session id**，**没有** list / resume / search / delete / export API；跨进程续聊不提供（`docs/user/guide/python-sdk.md:184` 只有"可复用同一个 harness/home/id"的说法）。
- 检索是 TS 专属：`ctx.sessionQuery` 提供 `listSessions/readSession/filterSessions/filterEvents/readEvent/traceSession/searchSessions/searchEvents`（`packages/session-query/session-query/README.md:34-43`）+ FTS5 后端（`session-query-sqlite/README.md:12`）+ `tool-session-query`，**都不在线协议里**。
- **没有任何东西会删除 session 文件**（`session-persistence-jsonl/README.md:159`）——见 §3。

### 2.7 记忆原语：**没有**

- 没有一等公民的 memory 抽象 **[未找到]**（`packages/*memory*` 不存在）。所谓"记忆"= 会话日志 + profile 里的 context/compaction 插件：AGENTS.md/CLAUDE.md 指令链（**65,536 字节预算**，`packages/context/agent-instructions/README.md:12`，row `base/cordis.patch.yml:275-278`）、上下文注入、compaction（`compaction/start|summary|end|prune`，`known-event-types.ts:32-35`；`dsh-compaction-basic` row `base/cordis.patch.yml:327-328`）、session title、skills。**这些全都不在 `sdk-minimal` profile 里**（`docs/user/guide/python-sdk.md:180`）。

### 2.8 一句话划线：Python 够到哪，哪里必须写 TS 插件

| 只用 Python SDK 就能做 | 必须 in-process（TS/Cordis 插件或 profile row） |
|---|---|
| 拉起 runtime（profile/patch/home）、选 provider/model/effort/maxTokens、开 N 个 session、发文本/含图 content blocks、收 4 种通知、读自己这轮的全量事件日志、shutdown | **注册工具**（或自己搭 MCP server）、session 列表/读取/检索/导出、**续聊一个已存 session**、**取消**在跑的轮次、**token 级流式**、compaction/指令/skills/subagent 配置、settings 与凭据管理 |

**这不是"Python SDK 是精简版 TS 客户端"**：TS 客户端用的是同样三个方法（`packages/sdk/client/src/client.ts:276-398`）。边界就在协议上，丰富度全在 runtime 的 Cordis 树（profile YAML/patch）里。

### 2.9 发布状态（能不能装到 claw 上）

- 仓库版本 `0.1.6-alpha.2` ⇒ Python 包版本 **0.1.6a2**（`scripts/build-python-release.py:104-131`，只在 `python-v*` tag 上发布，`.github/workflows/python-release.yml:92-98`）。
- 实测 PyPI：`pip index versions --pre deepseek-harness-sdk` → `0.1.5rc1, 0.1.2rc1, 0.1.2a3, 0.1.1rc1, 0.1.0rc7, 0.1.0rc6, 0.0.0.dev0`；**0.1.6a2 还没发**，当前可装的最新是 `0.1.5rc1`（该 wheel 的 5 个模块与本检出逐字节相同，`diff` 为空），所以上面的能力描述与今天能装到的东西一致。本机未安装 `deepseek_harness`。

---

## 3. 承载「一天几十轮、常年累积、多个人」（问题 3）

前提：这一节讲的是 **DSH 自己的 session/compaction/storage**。它不在 Python SDK 里（§2.6），但决定了"把家庭对话放进去"之后运维上要付什么代价。

### 3.1 落盘格式与耐久性：做得相当扎实

- **一个 session 一个文件**（不是一条消息/一个事件一个文件）：`<root>/--<规范化cwd>--/<编码 id>/session.vN.jsonl[.zstd]`，当前格式 **v3**（`packages/session/session-persistence-jsonl/src/format.ts:224-268`、`packages/core/session/src/types.ts:88`）。root 来自组合（`root: !!js dshHomePath('sessions')`，`packages/bundle/base/cordis.patch.yml:117-120`），即 `$DSH_HOME/sessions`。
- JSONL，**一行一事件**，第一行是 header（`format.ts:82-93,312-323`）；默认 **zstd** 压缩，压的是"每批追加一个独立 zstd 帧"的拼接（`src/index.ts:66,1206-1227`）。
- **没有 WAL，但每一次落盘都是原子的**：首次追加 = 临时文件 `wx` + `handle.sync()` + **`link()` 发布**（故意不用 `rename()`，这样同 id 竞争会 EEXIST 而不是覆盖已有日志）+ 父目录 fsync（`src/index.ts:1117-1157,1194-1204,1229-1238`）；后续追加 `'a'` 打开、写入、**每批 fsync**，失败回退截断（`:1246-1284`）；发现撕裂尾巴会先截断+fsync（`src/storage.ts:328-337`）。
- 默认还挂了 checkpoint 策略：**每次模型请求前、每个顶层工具调用前、每个 `agent/pre-step` 都会 flush**（`packages/bundle/base/cordis.patch.yml:398-400`、`packages/session/session-checkpoint-policy/src/index.ts:35,72,80`）。→ 断电最坏丢一次未 flush 的窗口（写批窗口 **200 ms**，`src/storage.ts:36`）。
- 写所有权是内核 `flock(2)`（`session.lock`），**持有者进程死掉锁立即释放**，"活但卡死的持有者会一直占着锁，这是有意的：没有过期时间可以剥夺一个卡住的写者"（`packages/session/session-persistence-jsonl/src/lease.ts:1-25`、README:160）。**[实测]** 本机 `~/.dsh/sessions/--home-lansy-Work-LearnBuddy--/<12 个 session 目录>/session.v3.jsonl.zstd` + 0 字节 `session.lock`，没有别的每-session 文件。

### 3.2 增长与代价

- **活着的 session 不会重读磁盘**：内存里就是 append-only 日志，`deriveMessages()` 有缓存、代价 O(新增节点)（`packages/core/session/src/index.ts:833-862`）。
- **冷读/恢复要整份读进内存**：`fs.readFile` + 逐行解码（`src/generation.ts:259-279`、`src/index.ts:697-708`）。**没有列表索引**：列 session 要遍历 root → project 目录 → session 目录逐个 stat、只读 header 帧（`src/index.ts:461-490,975-1006`）。
- **没有裁剪、没有轮转、没有删除 API**："**Nothing deletes session files** — logs accumulate under `root` until removed externally; the seam has no deletion API."（`session-persistence-jsonl/README.md:159`）。重复一遍：**只有追加，没有回收**。
- 每 session 还有一个 projection-cache 边车文件（**整份重写**），触发点是 `turn/end` + 每 200 事件 + 每 5000 ms（`packages/session/session-projection-cache/src/spec.ts:60-69,103`、`cordis.patch.yml:169-173`）；**[实测]** 每个 ~17–23 KB。
- **本机实测的真实体积**（操作者自己的 agent session，含工具调用）：199 事件 = 573,912 B 原始 / 188,814 B zstd（**2,884 B/事件原始、949 B/事件落盘**）；268 事件 = 1,516,510 B / 465,581 B（5,659 / 1,737）；11 份日志合计 2.36 MB，压缩比 ≈3.0–3.3×。
- **换算到家庭场景**：纯聊天的事件比带工具调用的 agent 事件小得多，按上面数字外推是**一年几十 MB 量级**（**[未验证]**：聊天专用的事件尺寸本机没有样本）。真正的代价不是磁盘，而是"**冷读成本随单会话长度线性增长 + 永不回收 + 没有 CLI 可以清理**"。

### 3.3 Compaction：按 token 压力，不按消息条数

- 触发条件：`agent/pre-step` 时 `totalTokens >= thresholdTokens`，`thresholdTokens = floor(contextWindow * 0.8)`（`packages/compaction/compaction-basic/src/index.ts:144,150,300-301`、`src/config.ts:20,144`）。**没有消息条数阈值、没有滞后窗口** **[未找到]**。
- **默认预算非常大**：DeepSeek 适配器的 `DEFAULT_CONTEXT_WINDOW = 1_000_000`（`packages/llm/llm-deepseek/src/common/defaults.ts:6`）⇒ 默认约 **80 万 token 才触发一次**。codex 走的是 pi‑ai 目录里的模型容量（另算，未逐一核对 **[未验证]**）。→ 对"一天几十轮"的家庭聊天，**compaction 基本不会被触发**；控制上下文长度实际上要靠**应用自己按会话/话题切 session**，而不是靠 harness 的 compaction。
- 摘要保留尾部 `retainRatio 0.16`、摘要输出上限 `8192` token、重试各 1 次（`config.ts:23,91,92-93`）。
- **产物是同一个 session 内的"表面替换"，不新开 session、不改写日志**：`compaction/start` → `compaction/summary`（记录 `shadowedRange`/`shadowedSeqs`）→ 一条带 `surfaceOp: {op:'replace', startSeq, endSeq}` 的 `user/message`（`docs/persistence-catalog.md:414-440,100-111`；折叠逻辑 `packages/core/session/src/surface.ts:520`）。
- **原始消息在磁盘上保留**，只是被标为 shadowed；检索侧能区分 `current`/`shadowed`/`log-only`（`packages/session-query/session-query/src/documents.ts:70-73`、`src/filters.ts:86-88,152-154`）。→ **对模型不可逆，对人和检索可逆。**
- **不能按 session 配置** **[未找到]**：只能按组合/preset 行 + 按 provider/model 的 `modelPolicies`（`config.ts:109-111`）；token-meter 拒绝一切配置（`packages/llm/token-meter/src/index.ts:88-92`）；base 里挂它时没给任何配置。
- 摘要调用是 `ctx.llm.stream(..., purpose:'compaction')`，**会重放该会话自己的 system prompt 与工具**（`summarizer.ts:119-179`、`:26-27,72-76`）——即压缩也要花钱/占额度。

### 3.4 多进程、多人：**这是最大的坑**

- **隔离单位是 `$DSH_HOME`（缺省 `~/.dsh`），也就是"一个 OS 用户"**（`packages/util/home-paths/src/index.ts:61-63,87-100`）。**profile 只是配置组合，不是数据边界**——所有 profile 共用同一个 `sessions/`、`storages/`、`attachments/`（`packages/boot/app-boot/src/profile.ts:1-12`）。**[未找到]** 任何 per-user/per-profile 数据隔离。
- **session 日志：多进程安全**（内核 flock，见 §3.1）。**`ctx.storage` 里的东西：不安全**——JSON 后端的原子写明确假设"**一个进程一个写者、后写覆盖先写**"，README 直书 "**No cross-process write locking** — two processes writing the same unit can interleave replacements"（`packages/storage/storage-json/README.md:142`、`src/atomic.ts:8-10,25-48`）。**[实测]** 12 个 session 目录共用一个可变的 `workspace.json`，`sessionIds` 数组无界增长且每次变更整份重写。
- 结论：**同一个 `$DSH_HOME` 上跑两个 DSH 进程，只有 session 日志是安全的，共享注册表/投影缓存会被互相覆盖。**"家庭里每人一个 agent"若都落在同一个 home 上，这是要正面解决的架构问题——要么每人一个 `DSH_HOME`（不同 OS 用户/systemd 单元），要么只让一个进程写。
- 会话 header 里**没有 owner/租户字段**（只有 `id, createdAt, cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset`，`format.ts:82-93`）；列表是 root 全局的（`src/index.ts:461`）。→ **血缘/归属只能靠应用层自己记。**

### 3.5 检索：默认是关的，而且是纯词法

- **全文检索默认关闭**：base 把 `session-query-sqlite` 挂成 `path: ':memory:'`、`openAt: never`（`packages/bundle/base/cordis.patch.yml:136-140`），调用会失败于 `SESSION_QUERY_SEARCH_DISABLED`（`.../src/index.ts:338-344`）。精确读取、标题、血缘仍可用。
- 打开后是**派生的 SQLite FTS5**，`tokenize = 'unicode61'`（**纯词法：没有子串、没有词干、没有向量/embedding**；`packages/session-query` 下 `embedding|vector` 0 命中）。中文/日文的分词要另说 **[未验证]**。
- 增量对账、不做全量重建（`session-query-sqlite/src/index.ts:454,469,510-522`）；排序是命中跨度数 + 文档长度，**没有 BM25**（`:671-679`）。
- **compaction 之前的（shadowed）事件也会被索引**（`session-query-sqlite/README.md:59`）——即"检索得到、模型看不到"。
- 检索是 **TS 专属**：模型侧有 5 个工具（`tool-session-query/src/index.ts:66,76,86,96,109`），Python SDK 拿不到（§2.6）。

### 3.6 运维面：几乎没有工具

- **CLI 只有一个子命令 `plugin`**（`apps/cli/src/args.ts:153-157,172`）。**[未找到]** session 的 list/prune/delete/gc/export/migrate/backup/restore 子命令；`/export` 是会话内斜杠命令。
- **全仓库唯一的保留策略是 spill 文件**：`cleanupPeriodDays` 默认 **30**（`packages/spill/spill-local/src/index.ts:66-69,95-101`）。**[未找到]** 对 session 日志、附件、projection cache、storage 单元的任何保留/GC/配额政策。
- 备份 = **手工备份整个 `$DSH_HOME`**（`sessions/`、`storages/`（含 `workspace.json`）、`attachments/`、`profiles/`、`.credentials.yaml`、`settings.yaml`）。**[未找到]** 任何迁移/恢复 runbook。
- **[实测]** 本机 `~/.dsh`：sessions 3,468,159 B / 24 文件；storages 267,943 B / 13 文件。规模本身不大，**但没有东西会删它们，超期的格式代际也不会被 GC**。

---

## 4. 成本模型（问题 4）

### 4.1 pi 订阅路线（现状）

- provider 定义：`openai-codex` 只有 OAuth、标记 `isSubscription: true`、base `https://chatgpt.com/backend-api`，目录里 8 个模型（**pi‑ai**:`dist/providers/openai-codex.js:8-17`、`dist/providers/data/openai-codex.json`）。
- **订阅没有"每 token 花费"这个量**：pi‑ai 的 `Usage` 只有 token 计数 + 按**目录标价**算出来的 `cost{input,output,cacheRead,cacheWrite,total}`（**pi‑ai**:`dist/types.d.ts:265-286`）；`isSubscription` 这个标记在 pi‑coding-agent 里**只用于 UI 文案**——TUI footer 判断"这是订阅"然后打印 `$…（sub）`（**pi**:`dist/core/model-runtime.js:330-335`、`dist/modes/interactive/components/footer.js:126-131`）。→ **pi 记的 dollar 是"目录价美元"，不是你付的钱。**
- **额度墙只能撞上去才知道**：命中 `usage_limit_reached|usage_not_included|rate_limit_exceeded` 或 429 时，pi‑ai 从错误体里读 `plan_type` 与 `resets_at`，生成 "You have hit your ChatGPT usage limit (…plan). Try again in ~N min."（**pi‑ai**:`dist/api/openai-codex-responses.js:1221-1243`），并以**裸 Error** 抛出（`:300`）。**主动查询剩余额度：不存在** **[未找到]**（搜过 wham/usage/credits/x-ratelimit 等）。终局配额错误不重试，普通 429 按 `retry-after-ms`/`retry-after` 退避（`:51-84`）。
- **LearnBuddy 现在看不见这个区别**：`ai-service/index.mjs:105-111` 把所有失败都塌成 `502 upstream_error` → 在 HTTP 边界上，"订阅额度撞墙"和"网络抖了一下"长得一模一样。

### 4.2 DSH 路线

- 适配器只有 `llm-deepseek`（API key，`DEEPSEEK_API_KEY`，`packages/llm/llm-deepseek/src/config.ts:13,28-29`）与 `llm-pi-ai`（暴露 pi‑ai 目录里的全部 provider，`packages/llm/llm-pi-ai/src/catalog.ts:15,191-193`）；`llm-retry` 是执行器不是路由，`token-meter` 是计量插件（§4.3）。
- **DSH 自己不携带任何价格表**：pi‑ai 目录模型的成本元数据被显式清零，代码注释写得很直白——"The harness never reads pi-ai's cost metadata — `replay.ts` zeroes it and **no consumer reports spend** — so this is the absence of a fact, not a configurable rate"（`packages/llm/llm-pi-ai/src/catalog.ts:32-37`，应用处 `:925`，清零处 `packages/llm/llm-pi-ai/src/replay.ts:64`）。→ **DSH 侧没有"这次请求花了多少钱"这个概念，也不知道订阅路线没有边际成本。**
- 有的分类学：`QUOTA`（"账户额度或余额耗尽"）与 `RATE_LIMIT` 两种稳定错误码，其中 `QUOTA` 是**按错误文案正则**识别的（`packages/llm/llm/src/error.ts:27-28,94-100`）；`LlmFailure` 里**没有任何"剩余额度"字段**（`packages/llm/llm/src/types.ts:40-58`）；重试策略默认 5 次、500 ms→10 s、`Retry-After` 优先（`packages/llm/llm/src/retry-policy.ts:14-24`）；pi‑ai 适配器按扁平化文本归为 AUTH → QUOTA → RATE_LIMIT → `PI_AI_ERROR`（`packages/llm/llm-pi-ai/src/stream.ts:42-67`）。
- **订阅路线在 DSH 里只能有一条**：`openai-codex` 是目录里唯一"没有 api-key 方法"的 OAuth-only provider（`packages/llm/llm-pi-ai/src/provider.ts:118-126`），凭据记录键是 `llm-pi-ai/openai-codex`——也就是说**家庭里"每人一份 codex 订阅"在同一个 DSH home 下无法用路由区分**（第二条自建 codex 路由会因为协议表里没有 `openai-codex-responses` 而抛 `PiAiCatalogError`，`provider.ts:47-51,177-183`）。按人隔离只对 **API-key 类 provider** 成立（不同 route + 不同 `apiKeyEnv`）。

### 4.3 同样对话量，两条路的差别（形状，不是金额）

| 维度 | pi 订阅路线（现状） | DSH provider 路由 |
|---|---|---|
| 边际成本 | 额度内 **0**；超额 = 撞墙（错误体带 `resets_at`） | API-key 路线 = token 数 × 官方价；codex 订阅路线同左栏 |
| 可知的用量 | token 计数（pi 自己记，`docs/session-format.md:87`；`usage-totals.js:18-51`） | token 计数（`token-meter` 投影，`src/projection.ts:13-18`） |
| 可知的花费 | 只有**目录标价**（≈不真实） | **没有价格表**（清零，`catalog.ts:32-37`） |
| 额度信号 | 429/错误文案 + `resets_at` | `RATE_LIMIT` + `providerRetryAfterMs`；`QUOTA` 靠文案正则 |
| 剩余额度 | **不可知** | **不可知** |
| 按人归属 | 无（per session/message） | 无（per session/turn/provider/model，`src/turn-usage.ts:7-10`） |
| 按人硬配额 | 无 | **无**（未随包发布任何预算插件） |

**能算的与不能算的，必须分清**：token 数两边都能精确拿到；**订阅的边际成本两边都算不出来**；任何"这次对话花了 X 元"的数字，在订阅路线上都只是目录价的假设值。

### 4.4 `token-meter` 能不能做家庭配额？**今天不能。**

- 它是 Cordis 服务插件（`export class TokenMeter extends Service`，服务名 `tokenMeter`，`packages/llm/token-meter/src/index.ts:101,106,111`），**配置类型是空的**：`TokenMeterConfig = Record<string, never>`、`static Config = z.object({})` + `validateConfigKeys` 拒绝一切键（`src/types.ts:12-13`、`src/index.ts:104,112`）——**没有任何地方能放费率、预算或上限**。
- 它**只记 token、不记钱**：`TokenMeasurement {totalTokens, surfaceTokens, nodes}`（`src/types.ts:22-35`）、`tokenUsage {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`（`src/projection.ts:13-18`）。README 自己声明"Occupancy is a reference figure, **not a billing record**"（`README.md:68`）。
- **没有身份维度**：粒度是 session + turn + (provider, model)（`src/turn-usage.ts:7-10`），请求信封里只有 `sessionId`（`packages/llm/llm/src/types.ts:484-488`）；DSH 里唯一的身份原语是每个 harness home 一个匿名 UUID（`packages/identity/anonymous-user-id/README.md:12`），凭据面是"一个 home 一份 `.credentials.yaml`"。→ **"谁用的"要靠应用自己在 session 命名/记账上体现。**
- **没有硬配额**：仓库里没有任何预算插件。最接近的可行原语是 **`llm/stream` 瀑布钩子**——它能包住每一次模型调用、可以自己 yield 分片来短路（`packages/llm/llm/src/index.ts:59-72`，分发点 `:1118-1123`）。要做"每人每天 N token 上限"，就是**写一个新插件**：读 per-session 的 `tokenUsage` 投影 + 在瀑布里拦截。
- 另外：`token-meter` 的估算器是启发式（`CHARS_PER_TOKEN = 4`，每块 +4、每角色 +4，`src/estimate.ts:13,16,19`），只有 provider 真返回 usage 时才是真数。

---

## 5. 明确未验证 / 开放的问题

1. **同一 ChatGPT 账号能否并存两个 Codex 授权**（DSH 里重新登录一次是否会顶掉 pi 那条）——本次只查了代码，没查 OpenAI 一手政策文档，也没做真实登录。**未验证。**
2. **订阅额度的真实窗口数值**（5 小时/每周等）——代码里只有"撞墙后的错误体含 `resets_at`/`plan_type`"，没有任何数值。外部文档：[apidog 的 Codex 限额整理](https://apidog.com/blog/codex-usage-limits/)（二手）、[OpenAI 帮助页 how-banked-codex-resets-work](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work)（抓取被 403）。**未验证。**
3. **"一行聊天事件"在 DSH 里的实际体积与年增量**——§3.2 的数字来自带工具调用的 agent session，纯聊天样本没有。**未验证。**
4. **同一 `$DSH_HOME` 上两个活 runtime 打开同一个 session id 会失败**（`SessionAlreadyExistsError`）是**源码推导，未实跑**。
5. **Codex 的额度错误文案落在 DSH 的哪个错误码**（`QUOTA` 还是 `PI_AI_ERROR`）——由两条正则推导，**未实跑**。
6. **codex 模型在 DSH 侧的 context window / 触发 compaction 的实际阈值**——未逐一核对 pi‑ai 目录里的每个模型容量。
7. **中/日文在 FTS5 `unicode61` 下的检索质量**（家庭对话以中文为主）——未实测。
8. **`deepseek-harness-sdk` 0.1.6a2 尚未发布到 PyPI**（今天能装的是 0.1.5rc1）；本机也没真装过、没跑过一次真实会话。

## 6. 附录：复跑方法

实测脚本随本文件入库（`research/dsh-vs-pi/`），只读、非破坏，绝不写真实 profile；跑完请自己清理临时文件：

```bash
# 1) pi 的 agent dir 对 pi-ai 是否可见（假 $HOME，不碰真实凭据）
node research/dsh-vs-pi/probe.mjs

# 2) auth.json -> DSH credentials.yaml 的迁移可行性（只读真实 auth.json，不打印 token，
#    产物写到临时目录）
node research/dsh-vs-pi/migrate.mjs

# 3) DSH 跨进程写锁的孤儿锁行为（用发布版 dsh-atomic-write 包）
node research/dsh-vs-pi/lock.mjs

# 4) pi 的 proper-lockfile 是否自愈孤儿锁
node research/dsh-vs-pi/pilock.mjs
```

依赖：`ai-service/` 里已装好的 pi 0.85.1、以及 `dsh` CLI 的 npx 检出（写作时 `0.1.5-rc.2`，路径 `/home/lansy/.npm/_npx/1e7f6d9597241db0/`）。脚本里的绝对路径按 §0 的来源表改。
