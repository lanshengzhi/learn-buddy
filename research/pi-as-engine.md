# pi 作为引擎的能力边界（与 DSH 侧对称的测量）

> Ticket: [#32](https://github.com/lanshengzhi/learn-buddy/issues/32)（`wayfinder:research`）· 父票 [#23](https://github.com/lanshengzhi/learn-buddy/issues/23) · 兄弟票 [#24](https://github.com/lanshengzhi/learn-buddy/issues/24)（DSH 侧）
> 分支：`research/pi-as-engine` · 日期：2026-09-22
> 方法：pi 0.85.1 源码逐条核对 + 本机**非破坏实跑**（全部打向一个本地 mock 的 OpenAI 兼容端点，**零真实 provider 调用、零真实凭据使用**）。实跑脚本见 §6。
> **本票不做「承载栈与壳的归属」决议**（那是 #29 的事），也不在 pi 与 DSH 之间表态。这里只交事实、代价与不确定项。

一手来源清单：

| 代号 | 是什么 | 版本 / 位置（下文路径相对各自的「根」） |
|---|---|---|
| **pi** | pi coding agent 包 | `LB:ai-service/node_modules/@earendil-works/pi-coding-agent` @ `0.85.1` |
| **pi-ai** | pi 的 LLM / 凭据 / 价格目录库（pi 的内嵌依赖，**未提升到顶层**） | `pi:node_modules/@earendil-works/pi-ai` @ `0.85.1` |
| **pi-core** | pi 的 agent 循环 | `pi:node_modules/@earendil-works/pi-agent-core` @ `0.85.1` |
| **lock** | pi 实际使用的锁库 | `pi:node_modules/proper-lockfile` @ `4.1.2` |
| **LB** | LearnBuddy 工作检出 | `research/pi-as-engine` 分支，基线 `master` @ `706f2ae` |
| **DSH** | DSH 源码检出（**只读，未修改**） | `/home/lansy/Work/github/deepseek-harness` |

本机环境：Node v26.7.0、Linux、btrfs。凡标 **[实测]** 的结论都有 §6 里可复跑的脚本；标 **[源码]** 的是读码所得；标 **[推导]** 的是从源码推出来的、没有直接读到或没有实跑；**未验证**的一律写进 §7，不猜。

---

## 0. 一句话结论（对齐 #24 的四条问题 + 本票新增的 work 面）

1. **pi 作为库（不是当 LLM 客户端）**：自带的东西比现役 `ai-service` 用到的多得多 —— **会话持久化与续聊已存 session、8 个内置工具、extension 审批闸门、token 级流式、消息排队/取消、上下文压缩**。但四件常被假设存在的东西**不存在**：**没有工具审批回调 API**、**没有子代理**、**没有 MCP**、**没有沙箱/路径限制**；另外**没有会话检索 API**。详情 §1。
2. **多会话与并发**：一个进程天生带 N 个独立会话（**[实测]** 20 个会话并发跑完，见 §2.1），没有任何进程级 cwd/单例挡路。但 **session 文件完全没有锁**：两个进程（或两个 session 对象）打开同一个会话文件同时写，**不会报错，会静默把对话写成一棵分叉的树**（**[实测]**，§2.3）。对照 DSH：DSH 的会话日志用**内核 flock 租约**，天然独占、进程死掉立即释放。
3. **凭据与部署**：pi 的**锁**是 `proper-lockfile` 的 mkdir 锁 + mtime 判定，**会自愈**（**[实测]**：新鲜孤儿锁挡住写；同一把锁 11 s 后放行）。但自愈窗口是**两条不同的口径**：同步路径 10 s、异步凭据路径 30 s（§3.2）。DSH 的 `wx` 锁**不自愈**（"orphan recovery is an operator action"，`DSH:packages/util/atomic-write/src/index.ts:150-152`）。凭据刷新本身在**文件锁内做二次过期检查**，所以**两个进程共用一个 agent dir 是安全的**——但代价是这个 agent dir 就是**一个信任域**（§3.1、§3.3）。
4. **「work」面的现实性**：把 pi 当引擎，**「手」白拿**（读写文件、跑命令、改代码、多轮工具循环、会话落盘与压缩、扩展缝）；**「产品」全自研**（项目模型、文档模型、审批策略、后台任务、撤销、Web UI、检索）。详见 §4 的表。
5. **成本**：pi 在**花费**上比 DSH 强一个身位（价格表 + 每条消息的美元数 + session 累计 + 按模型归因 + cache 浪费，`getSessionStats()` **[实测]**）；在**额度**上几乎为零——只有一句人话和一个私有布尔，`resets_at` / `plan_type` 解析出来后**被丢掉**（§5）。这与「额度墙的可观测性」票直接相关。

---

## 1. pi 作为库：它自带什么（问题 1）

### 1.1 入口与最小嵌入

- 包导出 `{".": dist/index.js, "./rpc-entry": dist/bundle/rpc-entry.js, "./client": src/client/index.ts, "./experimental/plugin": src/experimental/plugin.ts}`（**pi**:`package.json:14-27`）。**后两个子路径在发布包里是不可用的**：`files` 只发 `dist`、`docs`、`examples` 等，且显式排除 `dist/client`/`dist/experimental`，`src/` 根本不发布——上游自己的说明是 *"The `client` and `experimental/plugin` package subpaths resolve only under the `source` condition in a checkout. Their implementations and the server/client commands are excluded from npm packages and standalone binaries."*（**pi**:`docs/development.md:33`）。**结论：能用的入口只有 `.`（还有无类型的 `./rpc-entry`）。**
- 最小嵌入就是 `createAgentSession(options?)`：所有依赖都有默认值（自己的 `ModelRuntime`、`SettingsManager`、`SessionManager.create(cwd)`、`DefaultResourceLoader`），返回 `{ session, extensionsResult, modelFallbackMessage? }`（**pi**:`dist/core/sdk.js:66-79`、`dist/core/sdk.d.ts:58-65,107`）。
- **`cwd` 与 `agentDir` 是「每次调用」的选项，不是进程全局**（**pi**:`docs/sdk.md:344-363`）——这是 §2 的地基。
- 现役 `ai-service` 只用了 `createAgentSession` + `ModelRuntime` + `DefaultResourceLoader` + `SessionManager.inMemory()`，并把 `noTools: "all"`（`LB:ai-service/index.mjs:37-64`）——**本票测的是剩下的部分**。

### 1.2 会话持久化：格式、落盘时机、耐久性

- 格式：一行一个 JSON，首行是 header `{"type":"session","version":3,"id":"<uuidv7>","timestamp","cwd"}`，其后是 `model_change` / `thinking_level_change` / `message` / `compaction` 等条目，条目间用 `id`/`parentId` 组成**树**（**pi**:`docs/session-format.md:191-201`、`dist/core/session-manager.js:13,651-658`）。
- 位置：`<agentDir>/sessions/--<cwd 编码>--/<ISO 时间戳>_<uuidv7>.jsonl`，**会话按 cwd 分目录**，`SessionManager.list(cwd)` 按 header 里的 cwd 过滤（**pi**:`dist/core/session-manager.js:242-247,666-667`）。
- 写入是 `appendFileSync` 追加（**pi**:`dist/core/session-manager.js:745,766`），**全程没有 fsync**（对 `pi/dist` 非 bundle 代码 grep `fsync` = 0 命中）。
- **落盘时机是个反直觉点**：在出现第一条 **assistant** 消息之前，会话只在内存里；第一帧落盘时才用 `openSync(sessionFile, "wx")` 一次性写出，之后才追加（**pi**:`dist/core/session-manager.js:739-767`）。所以**只有用户发问、模型还没回答就崩了的会话，磁盘上什么都没有**。
- **磁盘上没有 compaction 之外的收缩**：压缩是往同一文件里追加一条 summary 条目，JSONL 不缩小（**未验证**：长期会话文件的实际增速，本票没量）。

### 1.3 续聊已存 session：一等公民 [实测]

API（**pi**:`dist/core/session-manager.d.ts:319-355`）：

```ts
SessionManager.create(cwd, sessionDir?)        // 新会话
SessionManager.open(path, sessionDir?, cwdOverride?)  // 打开指定文件
SessionManager.continueRecent(cwd, sessionDir?)       // 最近一个（没有则新建）
SessionManager.inMemory(cwd?, options?, entries?)     // 完全不落盘，或从外部条目恢复
SessionManager.list(cwd, sessionDir?) / listAll()     // 列表：{path,id,cwd,created,modified,messageCount,firstMessage,allMessagesText}
SessionManager.forkFrom(sourcePath, targetCwd, …)
```

替换当前会话（`/new` `/resume` `/fork` 的底层）在 `AgentSessionRuntime`：`newSession()` / `switchSession(path)` / `fork(entryId)` / `importFromJsonl()`（**pi**:`docs/sdk.md:120-165`）。

**[实测]**（脚本 `e1-resume.mjs`、`e6-restore-model.mjs`）：

```
[新进程 A] node e1-resume.mjs new
  created sessionFile=…/sessions/2026-09-22T06-45-35-256Z_01a0c7dc-….jsonl  sessionId=01a0c7dc-…
[另一个进程 B] node e1-resume.mjs resume
  opened …; entries=4
  resumed sessionId=01a0c7dc-…  restoredMessages=2
     user: first question
     assistant: ACK n=2 roles=system|user reply-to="first question"
  after turn 2 messages=4 ; 模型侧收到的 roles = system|user|assistant|user
[再一个进程] node e6-restore-model.mjs   # 不显式传 model
  resumed without an explicit model -> session.model = mock/mock-model
  modelFallbackMessage = (none)
```

即：**能续聊、能跨进程续聊、消息历史真的进了模型上下文、模型选择也会从会话里恢复**。列表 `SessionManager.list()` 也能用（返回 `firstMessage` 等）。检索没有 API：只有 `SessionInfo.allMessagesText` 供 TUI 选择器做字符串匹配（**pi**:`dist/core/session-manager.js:509`）；**embedder 要自己搜**。

### 1.4 工具与工具审批

- 内置 8 个：`read, bash, powershell, edit, write, grep, find, ls`；默认启用 `read, bash, edit, write`（**pi**:`dist/core/tools/index.d.ts:12-13`、`dist/core/sdk.js:139`）。开关有 `tools`（白名单）、`noTools: "all"|"builtin"`、`excludeTools`、`customTools`（**pi**:`dist/core/sdk.d.ts:26-47`）。
- `edit` 是**精确字符串替换**（`edits[].{oldText,newText}`，对原文件唯一匹配），不是结构化 patch；但返回里同时给 `details.diff` 和**标准 unified patch**（**pi**:`dist/core/tools/edit.d.ts:5-24`）——后者可以直接当版本化的原语用。
- **没有「先读后写」强制**：`edit` 只做读写权限检查（**pi**:`dist/core/tools/edit.js:107-114`）。
- **工具审批：没有 SDK 回调。** 在 `pi/dist` 的全部类型声明里 grep `canUseTool|permission|approval` = 0 命中；唯一的闸门是 extension 的 `tool_call` 事件：核心自己在没有扩展处理器时直接放行 ——

  ```js
  this.agent.beforeToolCall = async ({ toolCall, args }) => {
      const runner = this._extensionRunner;
      if (!runner.hasHandlers("tool_call")) { return undefined; }   // pi:dist/core/agent-session.js:226-228
  ```
  扩展返回 `{ block: true, reason?, terminate? }` 即拦截（**pi**:`dist/core/extensions/types.d.ts:818-827`，第一个 block 短路于 `dist/core/extensions/runner.js:744-765`）；`event.input` 可在事件里**就地改**，但**改完不再校验**（**pi**:`dist/core/extensions/types.d.ts:718-724`）。示例见 `pi:examples/extensions/permission-gate.ts`。
  **含义**：审批策略要么写一个 in-process 扩展，要么就不要（现役 `ai-service` 就是 `noTools: "all"` 全关）。
- **没有 undo / checkpoint**（`undo` 只是 TUI 输入框的快捷键，**pi**:`dist/core/keybindings.js:195`）；git checkpoint 是示例扩展而不是内置。

### 1.5 文件与终端访问

- `bash` 每次调用 **spawn 一个新 shell 进程**（`spawn(shell, ["-c"], {cwd, env})`，**pi**:`dist/core/tools/bash.js:50-51`），**没有持久 shell**；换 SSH/VM 的缝是 `BashOperations` / `BashSpawnHook`。
- **没有沙箱**（上游原话：*"Pi does not include a built-in sandbox."* `pi:docs/security.md:31-37`），**也没有 cwd 限制**：`resolveToCwd()` 只是普通路径解析，`~` 和绝对路径都放行（**pi**:`dist/core/tools/path-utils.js:38-44`）。隔离只能靠容器（`pi:docs/containerization.md`）。
- `bash` **没有默认超时**（**pi**:`dist/core/tools/bash.js:14-17,28`）；输出尾部截断（2000 行 / 50 KB），完整输出 spill 到 `$TMPDIR/pi-bash-<id>.log`，**这些文件在 core 里没有任何 unlink** —— 服务化要自己加清理。
- `grep`/`find` 会 shell out 到 `rg`/`fd`，**必要时从 GitHub releases 自动下载**（**pi**:`dist/utils/tools-manager.js:243`）——离线部署要么预装、要么关掉这两个工具。

### 1.6 extensions / skills / MCP / 子代理

- `DefaultResourceLoader` 的开关就是现役服务用的那批：`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`，另有 `additional*Paths`、`*Override`（**pi**:`dist/core/resource-loader.d.ts:67-119`）。
- 扩展是 TypeScript 模块（jiti 加载），`ExtensionAPI` 提供 **36 个事件**（含 `tool_call`、`tool_result`、`input`、`context`、`before_provider_request`、`session_*`）以及 `registerTool/registerCommand/registerShortcut/registerFlag/registerMessageRenderer/registerEntryRenderer/registerProvider`（**pi**:`dist/core/extensions/types.d.ts:906-1083`）。
- **MCP：没有内置**（`pi:README.md:499`、`pi:docs/usage.md:309`："It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."）。要 MCP 得自己写扩展或装第三方 pi package。
- **子代理：没有内置**（`pi:README.md:501`）。`pi:examples/extensions/subagent/` 只是一个**示例扩展**（随 tarball 发布但不默认加载），它自己 `spawn` 一个 `pi` 子进程跑 JSON 模式，支持 single/parallel/chain。
- **没有后台 bash**（同上 usage.md:309）。

### 1.7 流式：token 级 [实测]

`session.subscribe(listener)` 推 `AgentSessionEvent`；`message_update` 事件里带 `assistantMessageEvent`，其 `text_delta`/`thinking_delta` 是**增量文本**（**pi**:`docs/sdk.md:27-31`、`dist/core/agent-session.d.ts:40-101,280`、**pi-ai**:`dist/types.d.ts:410-446`）。

**[实测]**（`e2.mjs multi`）：3 个会话同时跑，订阅端一共收到 57 个 `text_delta`，交错序列前 24 个是 `s0s1s2s0s1s2…`（56 次切换）——**不是串行的**。
**[实测]**（`e5-scale.mjs 20`）：20 个会话并发，共 280 个 `text_delta`，全部 20 个会话都拿到答案。

### 1.8 取消与排队

`session.abort()`；`steer(text)`（当前轮工具调用后送达）/`followUp(text)`（agent 完全停下后送达）；流式中直接 `prompt()` 会**抛错**，必须给 `{streamingBehavior: "steer"|"followUp"}`（**[实测]**：`Error: Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.`）；另有 `clearQueue()`/`pendingMessageCount`/`queue_update` 事件（**pi**:`docs/sdk.md:166-215`、`dist/core/agent-session.d.ts:359,375,383,430-444`）。

---

## 2. 多会话与并发（问题 2）

### 2.1 一个进程能带几个会话

**[实测]**（`e5-scale.mjs 20`）：

```
created 20 sessions in 13 ms; rss 161.3 -> 161.8 MB
all 20 prompts done in 646 ms; total text_delta events=280
sessions with an assistant answer: 20/20
rss after: 181.4 MB
```

**20 个会话在一个进程里并发跑，没有任何冲突**；会话对象是纯实例，`cwd`/`agentDir` 是每次调用的参数（**[源码]**：`createAgentSession()` 里每个依赖都是局部量，**pi**:`dist/core/sdk.js:66-79`）。模块级可变状态只有几个良性缓存（`sharedAuthFileReadState`、`sharedModelsFileReadState`、`installedGlobalFetch`、`fileMutationQueues`）——都是「同一文件的读缓存/同进程写队列」，不是会话间共享的语义状态（**[源码]**，由本票的并发/凭据子调研逐条盘点，路径见 §6 报告）。

**推论（[推导]）**：家庭规模（几人、几十个并发会话）在**单进程**里完全放得下；真正的天花板不是会话数，而是 §2.3 的落盘并发与 §3 的信任域。

### 2.2 「多人同时用」是什么形态

三种可选形态，本票只测了第一种：

1. **SDK 直接嵌进你自己的 HTTP 服务**（推荐路径）：一个 Node 进程 + 每人每会话一个 `AgentSession`。**[实测]** 成立。
2. **RPC 模式**：stdio + JSONL，**一个进程一个会话**；包里的客户端是 `spawn` 出子进程来用的（**pi**:`docs/rpc.md:3`、`dist/modes/rpc/rpc-client.js:42`），而且 `new_session` 只**替换**当前会话、不新增（`pi:dist/modes/rpc/rpc-mode.js:336-343`）。上游自己劝你别这么干：*"If you're building a Node.js application, consider using `AgentSession` directly … instead of spawning a subprocess."*（**pi**:`docs/rpc.md:5`）。
3. **服务器模式**：**这个包里没有**。`pi-server`/`pi-protocol`/`pi-client` 是 devDependency，且被显式排除出发布包（**pi**:`package.json:85`、`docs/development.md:33`）；`pi/dist` 下没有 server/socket 实现。
   **[实测]** 副作用：调用 `main()`/RPC 会把 `process.stdout.write` 改写到 stderr（**pi**:`dist/core/output-guard.js:38-56`），SDK 直接嵌入不会。

### 2.3 单写者 / 锁的问题：**会话文件完全没有锁** [实测]

**[源码]** 事实：`proper-lockfile` 在整个 pi 里只被四个文件 import —— `dist/core/auth-storage.js:7`、`dist/core/settings-manager.js:4`、`dist/core/trust-manager.js:4`、`dist/package-manager-cli.js:5`。**`session-manager.js` 不在其中**。会话文件唯一的保护是首帧的 `openSync(path, "wx")`（**pi**:`dist/core/session-manager.js:754`），而它在 **resume 时根本不会走到**（`dist/core/session-manager.js:637` 直接把 `flushed = true`），之后全是裸 `appendFileSync`。

**[实测]**（`e3.mjs`，两个**独立进程**打开**同一个**已存 session 文件并发写）：

```
[A] pid=25 opened, restored=3 msgs, leaf=dd0d7aa2     ← A 已经看见 B 追加的用户消息
[B] pid=26 opened, restored=2 msgs, leaf=5325decf     ← B 看到的是更早的状态
[A] done, msgs=5 ; [B] done, msgs=4

inspect: lines=9  distinct ids=9 (duplicates=0)  leaves=3
fork points (entries with >1 child) = 1
   parent dd0d7aa2 -> 9c6bad48(user B), 07de4ac9(user A)
```

**没有报错、没有损坏、没有丢行** —— 但对话被**静默写成了两棵分支**：A 与 B 各自接在同一个叶子上，两次「同一段对话的继续」变成了两个平行未来。文件里留下 3 个叶子，谁"是"这条对话取决于你从哪个叶子读。（同一进程内开两个 session 对象指向同一文件，结果相同，**[实测]** `e2.mjs samefile`。）
更危险的路径是 `_rewriteFile()`：它用 `openSync(path, "w")` **截断重写**（**pi**:`dist/core/session-manager.js:708-720`，触发于迁移 `:632/:677` 与 `createBranchedSession` `:1173`）——并发写者此时会丢行。
另有小坑：**打开**一个会话也可能写它（`loadEntriesFromFile` 里 `appendFileSync(resolvedFilePath, "\n")`，**pi**:`dist/core/session-manager.js:318-319`）。

### 2.4 与 DSH 侧的对称对照

| 维度 | pi（本票实测/读码） | DSH（#24 的结论，本票只做对照阅读） |
|---|---|---|
| 一个进程多会话 | 天生的，20 并发实测通过（§2.1） | Python SDK 可开 N 个 session（线程并发），但 provider/model/effort 是**进程级**的，一个进程一个模型 |
| 多人同时用的形态 | 单进程多 `AgentSession`；RPC 是一进程一会话且只替换不新增 | stdio 子进程 + 3 个 RPC；或 in-process 插件 |
| 会话日志写者 | **完全无锁**；并发写同一会话 → 静默分叉（[实测]） | 一 session 一日志 + **内核 `flock` 写租约**，持有者死掉立即释放（`DSH:packages/session/session-persistence-jsonl/src/lease.ts:1-20`） |
| 会话日志耐久性 | `appendFileSync`，**无 fsync**，截断式 `_rewriteFile` | 追加 + 临时文件 `link()` 原子发布 + 每批 fsync（#24 §3） |
| 其他落盘状态的并发 | `auth.json`/`settings.json`/`trust.json`/`models-store.json` **都有锁**；会话文件没有 | 只有 session 日志多进程安全；`ctx.storage`（workspace.json、投影缓存）"后写覆盖先写、跨进程无锁" |
| 信任域 | 一个 agent dir 一个信任域，**没有 owner/租户概念**（§3.3） | 一个 `$DSH_HOME` 一个信任域，profile 不是数据边界 |
| 会话检索 | **无 API**，只有 `allMessagesText` 给 TUI 匹配 | 有 FTS5（默认关闭，纯词法） |

**一句话**：在**凭据/设置**这类小文件上 pi 的锁比 DSH 稳（会自愈）；在**会话日志**上反过来——DSH 有内核租约，pi 一把锁都没有。

---

## 3. 凭据与部署（问题 3）

### 3.1 agent dir、凭据格式与刷新

- agent dir 默认 `~/.pi/agent`，可用环境变量 **`PI_CODING_AGENT_DIR`** 覆盖（**pi**:`dist/config.js:406,422-426`）；里面是 `auth.json`、`settings.json`、`models-store.json`、`trust.json`、`sessions/`。现役服务不靠 `$HOME`，而是把 `authPath`/`modelsStorePath` 显式传给 `ModelRuntime.create()`（`LB:ai-service/index.mjs:51-56`）。
- `auth.json`：`{providerId: {type:"api_key",key?,env?} | {type:"oauth",access,refresh,expires,…}}`，写入用 `mode: 0o600`（**pi**:`dist/core/auth-storage.js:14-15,185-200`）。
- **刷新是「主动过期」而不是「401 重试」**：5 分钟余量（`DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5*60*1000`），**在文件锁内做二次检查**，整个刷新（含网络往返，15 s 上限）持锁，写完轮换后的凭据才释放（**pi-ai**:`dist/auth/resolve.js:62-95`，注释原文 *"tokens with less than five minutes remaining lock, re-check expiry under the lock, refresh once globally, and persist the rotated credential before release"*）。
  **含义**：**两个进程共用一个 agent dir 是安全的**——不会双重刷新、不会互相把 token 刷坏；风险只剩下「响应丢失」（非原子 `writeFileSync`，**未验证**）。
- 轮换是明写的：Anthropic 总是存响应里的新 token，OpenAI Codex **要求**响应里带新 refresh token，Copilot 会回同样的 token（**pi-ai**:`dist/auth/oauth/*.js`，见 §6 报告 B 的证据表）。**这与 #24 §1 的结论一致**：pi 的凭据不能和 DSH 长期共用一份（谁先刷新谁让另一份失效），但迁移是一次性搬运。

### 3.2 锁行为：pi 会自愈，DSH 不会（本票实测边界）

pi 的两条锁路径（都在 **[源码]** 读过，且用**真实的 pi 代码路径**实跑）：

| 用途 | 调用 | 选项 | 自愈窗口 |
|---|---|---|---|
| `settings.json`（同步路径）、部分 `auth.json` 写 | `lockfile.lockSync(path, { realpath: false })`（**pi**:`dist/core/settings-manager.js:60-79`、`dist/core/auth-storage.js:34-52`） | `stale` 用**库默认 10 s**，`update = stale/2` 心跳（**lock**:`lib/lockfile.js:206-221`） | **10 s** |
| OAuth 凭据刷新 / `models-store.json`（异步路径） | `lockfile.lock(path, { realpath:false, retries:0, stale:30_000, onCompromised })`（**pi**:`dist/core/auth-storage.js:85-90`） | `stale = 30 s`，带 30 s 截止 + 退避重试（`auth-storage.js:76-112`） | **30 s** |

**[实测]**（`e4.mjs`，用 pi 的 `SettingsManager` 真实写路径 + 直接使用 pi 引用的同一个 `proper-lockfile@4.1.2`）：

```
控制组：新建锁目录后立刻 checkSync -> true，lockSync -> ELOCKED（1 ms）   ← 锁确实被认
C1  无锁                          -> pi 写 OK in 4 ms（文件真的变了）
L1  新鲜孤儿锁（mtime=now）        -> pi 写 **FAILED** after 363 ms：不抛异常，只记进
                                     drainErrors=["global:ELOCKED","global:ELOCKED"]，
                                     文件**未变**，锁目录仍在（10×20 ms 重试后放弃）
L2  同一把锁，11 s 后              -> pi 写 OK in 4 ms                       ← 自愈
L4  锁目录 mtime 人为拨老 60 s      -> pi 写 OK in 4 ms                       ← 自愈
L3  异步凭据口径 stale=30000：age 5 s  -> ELOCKED（4 ms）
L3  异步凭据口径 stale=30000：age 31 s -> ACQUIRED（16 ms）
```

（L1 的「写失败但不抛」由 `trace-lock.mjs` 逐系统调用确认：10 次 `mkdirSync(<lock>)` 全部 EEXIST，`writeFileSync(settings.json)` **一次都没发生**。）

**边界条件（都比「会自愈」这句话更要紧）**：

1. **自愈是「按 mtime 猜」**：判据是 `stat.mtime < Date.now() - stale`（**lock**:`lib/lockfile.js:84-86`）。因此 (a) 时钟回拨/网络文件系统时间偏移会误判；(b) **活着的持有者如果事件循环被卡住超过 stale（同步长任务、SIGSTOP、VM 挂起），锁会被别人偷走**——异步路径给 pi 一个 `onCompromised` 回调来发现（它会记下并抛 "Auth storage lock was compromised"，`auth-storage.js:121-160`），**同步路径没给**，用的是库默认 `onCompromised: (err) => { throw err; }`（**lock**:`lib/lockfile.js:213`）→ 在定时器里抛出即**未捕获异常**。
2. **两条口径不一样（10 s vs 30 s）**，别把「pi 的锁 30 s」当通用值。
3. **竞争者不会等太久**：同步路径 10×20 ms ≈ 200 ms 就放弃（**[实测]** 363 ms 含开销）。**更要紧的是失败被吞掉**：`SettingsManager` 把错误记进内部 diagnostics（`enqueueWrite(...).catch((error) => this.recordError(scope, error))`，**pi**:`dist/core/settings-manager.js:356-368`），调用方**不抛异常**——**[实测]** 同一个进程里 `flush()` 正常 resolve，`drainErrors()` 才看到 `global: ELOCKED Lock file is already being held`，而设置根本没落盘。服务化要主动轮询 `drainErrors()`，否则「保存成功」是假的。
4. **对照 DSH**：`withFileLock` 是 `writeFile(lockPath, pid, { mode: 0o600, flag: 'wx' })`，默认等 2 s（凭据文档写 `waitMs: 30_000`，`DSH:packages/credentials/credentials-local/src/index.ts:112,705`），**并且明确拒绝删别人的锁**：*"The contender never removes an existing lock because file age cannot prove that its owner stopped; orphan recovery is an operator action."*（`DSH:packages/util/atomic-write/src/index.ts:141-152`，实现 `:158-189`）。**所以 #24 这条差异成立**：pi 的孤儿锁 ≤10 s/≤30 s 自愈，DSH 的孤儿锁要人工 `rm`。

### 3.3 systemd / 服务化

- **[源码]** 上游文档里 systemd/daemon/launchd/supervisor **零命中**；没有 unit、没有就绪探针、没有优雅停机契约。
- 没有 TTY 时 `main()` 会**静默退化成 print 模式**（**pi**:`dist/main.js:80-91`，调用点 `:501`）——服务化要自己用 SDK，不要走 `main()`。
- 相关环境变量：`PI_CODING_AGENT_DIR`（别依赖 `$HOME`）、`PI_TELEMETRY`（**安装遥测，默认开启**：`pi:dist/core/telemetry.js:6` 读环境变量、`pi:dist/core/settings-manager.js:698` 是 `?? true` 的默认值）、`TMPDIR`（spill 文件）。另有 provider 归因头，会把 session id 当 `x-opencode-session` 发给部分 provider（**pi**:`dist/core/provider-attribution.js:58`）。
- **信任域**：`pi:docs/security.md:3` 原文把「该用户可写的文件」视为同一本地信任边界；`:48` 提醒不要随意把宿主 `~/.pi/agent` 挂进容器，因为里面有 **sessions/settings/credentials**。**没有 per-user / owner / tenant 概念**（核心与 RPC 代码里 grep 无命中）；`listAll()` 返回**全部**会话，cwd 过滤只在传入自定义 sessionDir 时生效（**pi**:`dist/core/session-manager.js:1313-1327`）。**[推导]** 多人要么每人一个 agent dir，要么接受「互相能读全部会话」。
- **对现役 `ai-service` 的直接含义**：它现在是**单进程 + 单会话 + 队列化**（`LB:ai-service/index.mjs:72-113`），刻意把 OAuth 刷新收在一处。这在一个「查义」小服务里是合理的；但换成「家庭中枢」后，**它会成为所有人共用同一个 agent dir / 同一个信任域的那一个进程**。

---

## 4. 「work」面的现实性：白拿 vs 自研（问题 4）

| 能力 | pi 自带？ | 证据 / 还缺什么 |
|---|---|---|
| 读写文件 / 改代码 | **白拿**：`read`/`write`/`edit`/`grep`/`find`/`ls` | **pi**:`dist/core/tools/index.d.ts:12-13`；`edit` 有 diff + unified patch |
| 跑命令 | **白拿**：`bash` | 每次新进程；**无超时**、无沙箱、无路径限制 |
| 多轮工具循环 / 中断 / 排队 | **白拿** | §1.7、§1.8 |
| 会话落盘 + 续聊 | **白拿** | §1.2、§1.3（**无锁**，§2.3） |
| 上下文压缩 | **白拿**（`compact()`、auto compaction） | **pi**:`dist/core/agent-session.d.ts` 的 `compact/abortCompaction`；触发阈值见 `DEFAULT_COMPACTION_SETTINGS` |
| 「项目」概念 | **几乎没有**：只有 `cwd` + 从 cwd 向上找 `AGENTS.md`/`CLAUDE.md` 注入为 `<project_context>` | **pi**:`dist/core/resource-loader.js:32-33,82-109`、`dist/core/system-prompt.js:103-110`；没有 scaffold、没有「建项目」（docs 里 `scaffold|project create|/init` 0 命中） |
| 「文档」概念 | **没有**：文档就是文件，`edit` 只认字符串替换 | 要富文本/结构化文档得自研 |
| 审批 / 权限策略 | **要自研**（写扩展） | §1.4 |
| 后台长任务 | **没有**（no background bash） | 要自研或走扩展 |
| 撤销 / 版本 | **没有**（只有 unified patch 可当原语） | §1.4 |
| Web UI | **全自研**；HTML 导出只是归档（TUI 渲染 → ANSI → HTML，固定宽度） | **pi**:`dist/core/export-html/tool-renderer.d.ts:1-10`；事件流已够用（§1.7） |
| 多人隔离 | **没有**：一个 agent dir 一个信任域 | §3.3 |
| 会话检索 | **没有 API** | §1.3 |

**结论（[推导]）**：「建项目 / 编辑文档 / 写代码」里，**执行面（工具+循环+落盘）是白拿的**，而且质量不差；**产品面（项目/文档模型、审批、撤销、后台任务、UI、检索、多人隔离）几乎全要自研**——和 DSH 侧 #24 的结论形状相同：**两边都是「引擎强、壳自研」**。

---

## 5. 成本与额度可观测性（问题 5，呼应额度墙票）

**pi 比 DSH 强的地方（[源码]，接口已 [实测]）**：

- 每条 assistant 消息带 `usage: {input,output,cacheRead,cacheWrite,reasoning?,totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}`（**pi-ai**:`dist/types.d.ts:265-286,318`）——**[实测]** 我的 mock 声明 `cost: {input:1,output:2}`/M，21/13 token 的消息回报 `cost.total = 0.000047`，**数字对得上**，即这是**按价格表算出来的假设值，不是 provider 报的账**（唯一计算点 `pi-ai:dist/models.js:530-549`；连 OpenRouter 报的 cost 都被忽略）。
- `session.getSessionStats()` 直接给 embedder 累计值：`{tokens, cost, contextUsage:{tokens,contextWindow,percent}}`，文档保证**包含已被压缩掉的历史**（*"so token/cost totals reflect what was actually billed across the session"*，**pi**:`dist/core/agent-session.d.ts:636-641`）。**[实测]** 输出：

  ```
  {"tokens":{"input":21,"output":13,"total":34},"cost":0.000047,
   "contextUsage":{"tokens":34,"contextWindow":32000,"percent":0.106}}
  ```
- 另有按模型归因的 `getUsageCostBreakdown` 与 cache 浪费统计（深路径导入，**未验证**其稳定性）。

**pi 不比 DSH 强的地方（额度）**：

- `isSubscription` 存在，但**不改变计费**：它只被 `modelRuntime.isUsingSubscription()` 读取，唯一消费点是 TUI footer 显示 `$0.123 (sub)`（**pi**:`dist/core/model-runtime.js:334`、`dist/modes/interactive/components/footer.js:124-133`）。订阅路线的花费照价格表累计——**可以当影子价格，不是账单**。
- **没有类型化的额度码**：`StopReason` 只有 `pending|stop|length|toolUse|error|aborted|deferred`，错误负载就是一个字符串 `errorMessage`（**pi-ai**:`dist/types.d.ts:287,307-329`）；「额度墙 vs 限流」是一个**私有布尔**，由**英文正则**在错误文案上判出来（`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` = `GoUsageLimitError|FreeUsageLimitError|"Monthly usage limit reached"|"available balance"|insufficient_quota|"out of budget"|"quota exceeded"|billing`，**pi-ai**:`dist/utils/retry.js:4-19,167-174`）。
- **最扎心的一条**：pi **解析了额度信息又扔掉**。Codex 的错误处理读了 `err.plan_type` 与 `err.resets_at`，算出剩余分钟数，拼成 `"You have hit your ChatGPT usage limit (pro plan). Try again in ~N min."`，然后**只返回两个字符串**（`{message, friendlyMessage}`），`friendlyMessage` 的唯一用途是 `throw new Error(...)`；`resets_at`/`plan_type` 是**死在 return 里的局部变量**（**pi-ai**:`dist/api/openai-codex-responses.js:1221-1243`，抛出点 `:300`）。
- **没有剩余额度 / 窗口 / 重置时刻的任何字段**，也**没有任何预算/上限强制**（grep `maxCost|spendCap|costLimit|budgetUsd|hardLimit` = 0）。

**与 DSH 的对照（对称结论）**：**花费上 pi 领先**（价格表 + 每条消息 + session 累计 + 归因）；**额度上两边都拿不到「还剩多少」**——pi 多给你**一句人话**（含 "Try again in ~N min"，可以正则抠出来）和一个私有布尔，DSH 多给你**两个可分支的类型码**（`QUOTA`/`RATE_LIMIT`）。**要真做「额度墙可观测性」，两边都得自己在 provider 错误体上再挖一层。** 顺带：现役 `ai-service` 把所有失败塌成 `502 upstream_error`（`LB:ai-service/index.mjs:108-111`），在 HTTP 边界上额度墙与网络抖动不可区分——这条与 #24 §4 的观察一致。

---

## 6. 复跑脚本

脚本在 `research/pi-as-engine/`（与 #24 的做法一致：脚本随分支提交）：

| 脚本 | 作用 |
|---|---|
| `mock-openai.mjs` | 本地 OpenAI 兼容 mock（SSE 流式；把收到的 `messages`/roles/tools 记进 `requests.jsonl`；`USE_TOOL` 触发一次 `write` 工具调用）。**零真实 provider 调用。** |
| `agentdir/models.json` | 把 mock 注册成 provider `mock`（含一条价格表，用于验证成本计算） |
| `e1-resume.mjs` | `new` / `resume` / `list`：跨进程续聊已存 session |
| `e2.mjs` | `multi`（3 会话并发 + delta 交错）/ `samefile` / `doubles`（同会话并发 prompt、steer）/ `tools`（工具端到端）/ `nosession` |
| `e3.mjs` | `make` / `writer` / `inspect`：两个**独立进程**写**同一个** session 文件，并解析分叉 |
| `e4.mjs` | `stale-lock` / `async-lock-probe` / `hold` / `write`：孤儿锁、自愈窗口、同步 vs 异步口径 |
| `e5-scale.mjs` | N 个会话并发 + `getSessionStats()` |
| `e6-restore-model.mjs` | 不显式传 model 的续聊（模型从会话恢复） |

运行方式（本机）：先 `node mock-openai.mjs` 起 mock（监听 127.0.0.1:8199），再在 `ai-service/node_modules` 可达的目录下跑其余脚本。脚本里的路径常量指向运行时的 scratch 目录 `<repo>/.scratch/pi-lab/`（**未纳入版本控制**）——把该目录建好并放入 `agentdir/models.json` 即可复跑。

三份逐条取证的子调研报告（含完整证据表）在 `.scratch/pi-research/`（未纳入版本控制）：`A-library-surface.md`（库能力面）、`B-concurrency-credentials.md`（并发/凭据/部署）、`C-work-and-cost.md`（work 面与成本额度）。

---

## 7. 明确未验证（不猜）

1. **真实 provider 的额度字段**：本票只确认了 pi **读了什么**；provider 流式响应体里是否还有 pi 不读的额度字段，**未验证**。
2. **凭据刷新的「响应丢失」风险**：`auth.json` 的写入不是原子的（`writeFileSync`），刷新超时 15 s；如果 provider 已经轮换而响应丢失，旧 token 服务端已失效——**[推导]**，未构造实验。
3. **同一会话被两个进程写之后，pi 重新打开会怎么「选」叶子**：本票确认了文件里出现 3 个叶子与分叉点（[实测]），但**没有**验证 `getLeafEntry()` 在真实并发时序下的选择是否稳定、以及 `_rewriteFile()` 截断在并发下丢行的真实概率。
4. **`onCompromised` 在同步路径抛出是否真的成为未捕获异常**：读的是库默认值（**lock**:`lib/lockfile.js:213`）+ pi 同步路径未传该选项，**[推导]**，未构造「事件循环卡死 10 s 后被偷锁」的实验。
5. **NFS/CIFS/overlayfs 上的 mtime 精度**：proper-lockfile 会探测 mtime 精度（**lock**:`lib/lockfile.js:33`），本票只在 btrfs 上实测；claw 的部署文件系统未验证。
6. **长期会话文件体积 / 压缩后的实际增速**：未测。
7. **`research` 分叉与 `SessionManager` 的 `getPath()`**：`docs/sdk.md:833-860` 提到 `sm.getPath()`，但发布版 `SessionManager` 没有这个方法（有 `getBranch`）——**文档与发布版不一致**，本票按发布版为准。
8. **RPC / JSON 模式的实跑**：本票未跑；相关结论来自 `docs/rpc.md` 与源码阅读。
9. **`dist/bundle/` 与未打包 `dist/*.js` 的行为一致性**：所有引用都指向未打包路径（`exports` 解析到的就是它），bundle 未逐条比对。
10. **pi 的遥测是否真的发出请求**：本票只确认了默认开关、归因头与会话 id 头的代码路径，**未验证**真实网络行为（所有实验都在 mock 上，且未开遥测观察）。
