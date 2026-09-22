# pi 的自定义扩展能否在发布包里被加载（工具注册的可行性）

> Ticket: [#35](https://github.com/lanshengzhi/learn-buddy/issues/35)（`wayfinder:research`）· 父票 [#23](https://github.com/lanshengzhi/learn-buddy/issues/23) · 前置票 [#32](https://github.com/lanshengzhi/learn-buddy/issues/32)
> 分支：`research/pi-extensions` · 日期：2026-09-22 · 基线 `master` @ `706f2ae`
> 方法：pi 0.85.1 源码逐条核对 + 本机**端到端实跑**（自写的 TS/JS 扩展 + **本地 mock 的 OpenAI 兼容端点**，**零真实 provider 调用、零真实凭据**）。全部原始输出在 `research/pi-extensions/results/`，脚本在 `research/pi-extensions/*.mjs`。
> **本票只交事实**，不做「Chat 面要不要只读工具」的产品决议。

一手来源清单：

| 代号 | 是什么 | 版本 / 位置（下文路径相对各自的「根」） |
|---|---|---|
| **pi** | pi coding agent 包 | `LB:ai-service/node_modules/@earendil-works/pi-coding-agent` @ `0.85.1` |
| **LB** | LearnBuddy 工作检出 | 本分支 `research/pi-extensions`，基线 `master` @ `706f2ae` |
| **lab** | 实验用的 scratch 目录（**不是 `~/.pi`、不是任何部署状态**） | `LB:.scratch/pi-ext-lab/`（未纳入版本控制，可用 `PI_EXT_LAB` 重定位） |

本机环境：Node v26.7.0、Linux、btrfs。**关于 scratch 目录的一处偏离**：约束写的是「用 `/tmp` 下的 scratch 副本」；实测本环境的 bash 工具跑在 `bwrap --tmpfs /tmp --unshare-pid` 里，**`/tmp` 每次调用都是空的**（跨调用不保留），因此 lab 放在 `LB:.scratch/pi-ext-lab/`（与 #32 的 `.scratch/pi-lab/` 同做法，gitignore、非部署状态）。隔离意图不变：**全程没有读写真实的 `~/.pi` 或任何部署态**。

标 **[实测]** 的结论都有 `results/` 里可复跑的原始输出；标 **[源码]** 的是读码所得；标 **[推导]** 的是从源码推出来的、没有直接读到或没有实跑；**未验证**的一律写进 §7，不猜。

---

## 0. 四问四答

1. **能不能加载我们自己写的扩展？** —— **能，而且比预想的宽松。** `additionalExtensionPaths` 指向本地 `.ts` 文件（`noExtensions` 保持 false）→ pi 用 jiti 真的加载并调用工厂（**[实测]**，§1.1）。顺带测出一条**反直觉**的语义：**`noExtensions: true` 并不能关掉 `additionalExtensionPaths` 与 `extensionFactories`**，它只关掉「自动发现」（**[实测]** + **[源码]** `pi:dist/core/resource-loader.js:316-318`，§1.2）。
2. **注册的工具能不能真的被模型调用？** —— **能，完整往返。** [实测]：扩展注册的 `lb_word_lookup` 出现在发给模型的 `tools` 数组里；模型发出 tool call 后 pi 真的执行了 `execute()`；结果以 `role:"tool"` 回灌进模型上下文；最终 assistant 文本里带着查到的词条（§2）。**但 `noTools: "all"` 会把扩展工具一起关掉**——现役 `ai-service` 用的就是它（§2.1）。
3. **`tool_call` 闸门在同一条路径下能不能用？** —— **能，且在 headless 下可用。** [实测]：`block:true` 真的拦下（工具没执行，模型收到 `isError` 的结果）、就地改写 `event.input` 真的生效；`ctx.hasUI=false`、`ctx.mode="print"`，没有 TTY 也能跑（§3）。**附带实测**：改写后的参数**不再按 schema 校验**（把 string 改成 number 也照跑，§3.2）。
4. **发布包的限制到底卡在哪？** —— **只卡上游自己的 remote-harness client/server/plugin 命令行，不卡扩展作者。** 「只有 `.` 可用」是一句**关于模块解析（exports 封装）与发布清单（files 白名单）的话**；扩展加载所需的全部代码都在 `dist/` 里、都从 `.` 可达（`dist/index.js:8` 导出 `defineTool` / `discoverAndLoadExtensions` / `ExtensionRunner`），**jiti 也在 `dependencies` 里**。见 §4。

---

## 1. 问题 1：能不能加载我们自己写的扩展

### 1.1 最小可复现：一个本地 TS 文件被真的加载并执行

`research/pi-extensions/ext/learnbuddy-tools.ts` 是一个**只用 type-only import**、手写 JSON Schema 的扩展，注册两个只读工具（`lb_word_lookup` / `lb_reading_position`）。加载它就是三行：

```js
const loader = new DefaultResourceLoader({
  cwd, agentDir,
  additionalExtensionPaths: ["/abs/path/ext/learnbuddy-tools.ts"],
  noExtensions: false,           // 必须为 false —— 但它不是「总开关」，见 §1.2
});
await loader.reload();           // 工厂在这一刻被调用
```

**[实测]** `node e1-load.mjs ext notools=builtin`（`results/e1-notools-builtin.txt`）：

```
ext paths     : gate.ts, learnbuddy-tools.ts, typebox-tool.ts
noExtensions  : false
reload() threw : no
extensions[]   : 3
errors[]       : []
   loaded gate.ts
   loaded learnbuddy-tools.ts
   loaded typebox-tool.ts
active tools : ["lb_word_lookup","lb_reading_position","tb_echo"]
all tools    : ["read","bash",…,"lb_word_lookup","lb_reading_position","tb_echo"]
```

工厂真的跑了（不是「注册了但没执行」）：三个 fixture 在工厂体里各写一行日志，`tool-invocations.log` / `gate.log` 都出现对应行。**jiti 确实在加载 TS**（把源码拷到仓库外一个**上溯路径上没有任何 `node_modules`** 的目录，同样加载成功，§1.5）。

对应的**反面对照**（`results/e2-none.txt`）：完全不传扩展路径时 `extensions[] = 0`、`active tools = []`、模型侧的 `advertisedTools=[]`。

### 1.2 `noExtensions` 的真实语义（反直觉，容易踩）

**[源码]** `pi:dist/core/resource-loader.js:316-318`：

```js
const extensionPaths = this.noExtensions
    ? cliEnabledExtensions                                   // ← additionalExtensionPaths 照旧
    : this.mergePaths(cliEnabledExtensions, enabledExtensions);
```

**[实测]** `results/e2-noext.txt`：`noExtensions: true` + `additionalExtensionPaths` 指向那两个 fixture →

```
loaded extensions : 2, errors: []
noExtensions      : true
active tools      : ["lb_word_lookup","lb_reading_position"]
… tool_execution_end name=lb_word_lookup isError=false
… execute() invocations added: 1
```

同样的语义适用于 `extensionFactories`（**[实测]** `results/e3-factory-noext.txt`：`noExtensions:true` + 内联工厂 → `extensions: 1`、`active tools: ["inline_factory_tool"]`；与调用点 `resource-loader.js:424-427` 一致，`loadExtensionFactories` 不受该开关约束）。

**事实含义**（不是产品建议）：`noExtensions` 不是「扩展总闸」，而是「**关掉自动发现，只留代码显式传进来的那些**」。现役 `ai-service/index.mjs` 传 `noExtensions: true` 但两个 additional/factory 选项都不传，所以它现在确实一个扩展都不加载——**但这层保证来自「什么都没传」，不是来自 `noExtensions`**。

### 1.3 `additionalExtensionPaths` 接受什么形态

| 传进去的东西 | 结果 | 证据 |
|---|---|---|
| 单个 `.ts` 文件 | 加载成功 | [实测] `results/e1-notools-builtin.txt` |
| 单个 `.js` 文件（普通 ESM 扩展） | 加载成功 | [实测] `results/e3-jspath.txt` |
| **一个目录**（里面有 `one.ts`，没有 `index.ts`） | **失败**：`Cannot find module '<dir>'` | [实测] `results/e3-dirpath.txt` |
| **一个目录**（里面有 `index.ts`） | **成功**（按 `index` 解析，路径记成目录本身） | [实测] `results/e3-subdir-path.txt` |
| 想让它「扫描目录里所有扩展」 | **做不到**：该选项是文件/包入口列表，不是扫描目录 | [实测] 同上两行 |

**[实测]** `results/e3-dirpath.txt` 的报错原文：

```
extensions : 0  errors=[{"path":"…/e3/shared-ext","error":"Failed to load extension: Cannot find module '…/e3/shared-ext'\nRequire stack:\n- …/pi-coding-agent/dist/core/extensions/loader.js"}]
```

**结论**：要一次加载多个扩展，要么自己列文件，要么给每个扩展一个含 `index.ts` 的目录。

### 1.4 扩展可以从哪些位置来（发现面）

**[实测]** `results/e3-*.txt`，每个 case 一个独立的 scratch project + agentDir：

| case | 放哪 | 结果 |
|---|---|---|
| `agentdir` | `<agentDir>/extensions/agent-ext.ts` | ✅ 自动发现（`extensions: 1`） |
| `project` | `<cwd>/.pi/extensions/project-ext.ts` | ✅ 自动发现（`extensions: 1`） |
| `subdir-index` | `<agentDir>/extensions/myext/index.ts` | ✅ 子目录 + `index.ts` 也被发现 |
| `subdir-path` | `additionalExtensionPaths: [<dir>/myext]`（内含 `index.ts`） | ✅ |
| `dirpath` | `additionalExtensionPaths: [<dir>]`（内含 `one.ts`） | ❌ 见 §1.3 |
| `jspath` | `additionalExtensionPaths: [<dir>/plain.js]` | ✅ |
| `factory` | `extensionFactories: [fn]`（**纯内存，无文件、无 jiti**） | ✅ `loaded <inline:1>`，工具直接可用 |
| `none` | 哪都不放 | `extensions: 0`（对照） |

`factory` 这一条值得单独记：**不落任何文件也能给模型加工具**——`extensionFactories` 收一个 `(pi) => {...}` 函数，pi 把它当 `<inline:1>` 扩展跑同一个代码路径（**[源码]** `resource-loader.js:741-759`）。

### 1.5 扩展文件里能 import 什么（jiti 的解析规则）

**[源码]** `pi:dist/core/extensions/loader.js`：

- `:14` `import { createJiti } from "jiti/static";`
- `:416-427` `createJiti(import.meta.url, { moduleCache: false, …(Node 未打包时用 { alias: getAliases() }) })` + `await jiti.import(extensionPath, { default: true })`
- `:91-112` `getAliases()` 里写死了一批别名：**`@earendil-works/pi-coding-agent` → `<pi>/dist/index.js`**、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai{,/compat,/oauth,/providers/all}`、**`typebox` / `@sinclair/typebox`（含 `/compile` `/value`）→ pi 自己那份**，以及旧包名 `@mariozechner/*`。

**[实测]** 把扩展放到一个**上溯路径上完全没有 `node_modules`** 的目录（`LB:.scratch/pi-ext-nodeps/`），两份 fixture 同时加载：

```
ext paths     : runtime-import.ts, typebox-tool.ts
errors[]      : []
active tools  : ["runtime_import_probe","tb_echo"]
```

- `runtime-import.ts` 里是**运行时的**（非 type-only）`import { defineTool } from "@earendil-works/pi-coding-agent"`；
- `typebox-tool.ts` 里是 `import { Type } from "typebox"`。

两者都解析成功——**因为别名把它们指回 pi 自己的安装目录**，不依赖扩展文件附近的 `node_modules`。

**边界**（**[实测]** `results/e1-missing-dep.txt`）：换成一个 pi 依赖闭包里没有的包（`no-such-pkg-xyz-42`）→ 加载失败：

```
extensions[] : 0
errors[]     : [{"path":"…/needs-pkg.ts","error":"Failed to load extension: Cannot find module 'no-such-pkg-xyz-42'\nRequire stack:\n- …/needs-pkg.ts"}]
```

即：**pi 自己的公共 API 与 `typebox` 白拿；其它第三方依赖要么装在扩展自己的 `node_modules`（上游 `examples/extensions/with-deps/` 就是这个示范），要么别用。**

### 1.6 失败模式：不抛异常，进 `errors[]`

**[源码]** `pi:dist/core/extensions/loader.js:478,485`：

```js
return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
return { extension: null, error: `Failed to load extension: ${message}` };
```

**[实测]** 三种失败都**不抛给 embedder**，只进 `LoadExtensionsResult.errors`：

| 触发 | 表现 |
|---|---|
| import 一个不存在的模块 | `Failed to load extension: Cannot find module '<pkg>'`（`results/e1-missing-dep.txt`） |
| 工厂体里抛异常（如 `mkdir` 到不存在的父目录） | `Failed to load extension: ENOENT: …`（跑 e1 时误触发过一次） |
| 传一个没有 `index.ts` 的目录 | `Failed to load extension: Cannot find module '<dir>'`（`results/e3-dirpath.txt`） |
| （上游声明的第三种）路径不存在 | `Extension path does not exist: <resolved>`（**[源码]** `resource-loader.js:324`，本票未构造） |

**含义**：扩展加载失败是**静默降级**——session 照建、内置工具照在，坏掉的扩展被跳过。服务化必须主动读 `errors[]`（或 `loader.getExtensions()`），否则「工具没上」和「工具上了但模型不调」在日志里长得一样。

### 1.7 改文件之后要不要重启进程（缓存行为）

**[实测]** `results/e4-reload.txt`（同一个进程内）：

```
process start, file v1, loaderA.reload()#1 : ["version_tool_v1"]
--- file rewritten to v2 ---
brand-new loaderD, no prior reload        : ["version_tool_v1"]   ← 新 loader 也读到了旧代码
loaderA.reload()#2 after edit             : ["version_tool_v2"]
brand-new loaderB, same cwd               : ["version_tool_v2"]
new loaderC, different cwd                : ["version_tool_v2"]
```

即：工厂按 `路径 + cwd + generation` 缓存（**[源码]** `loader.js:115-119,405-435`），**同一个 loader 再次 `reload()` 会清缓存并拿到新代码**；但**在同进程里新起一个 loader、而之前那个从没 reload 过**，会拿到旧代码。**跨进程启动总是读当前文件**（每个实验都是新进程，从未出现旧版本）。这不是本票的重点，但对「服务里怎么热更扩展」是个已知的地雷。

---

## 2. 问题 2：注册的工具能不能真的被模型调用

### 2.1 先把「哪些工具是活的」搞清楚：`noTools` 矩阵

**[源码]** `pi:dist/core/sdk.js:139-144`：

```js
const defaultActiveToolNames = ["read", "bash", "edit", "write"];
const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
const initialActiveToolNames = (options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames)))…
```

再叠加 `agent-session.js:2105-2180` 的 `_refreshToolRegistry`（`:2111-2118` 把扩展注册的工具并进注册表，`:2160-2180` 决定哪些进 active 集）。

**[实测]** `results/e1-notools-*.txt`，三种配置的差别是**本票最有用的一张表**：

| `createAgentSession` 选项 | active tools | `getAllTools()` | 说明 |
|---|---|---|---|
| （不传） | `read,bash,edit,write` **+ 全部扩展工具** | 8 个内置 + 3 个扩展 | 默认：内置与扩展一起活着 |
| `noTools: "all"` | **`[]`** | **`[]`** | **连扩展工具一起关掉**（注册表里也没有） |
| `noTools: "builtin"` | **只有扩展工具**（`lb_word_lookup,lb_reading_position,tb_echo`） | 8 个内置 + 3 个扩展 | 注册表里内置还在，但**不激活**；正是「只要只读自定义工具」的形状 |
| `tools: ["lb_word_lookup", …]` | 所列的 3 个 | 只有这 3 个 | 白名单对**所有**工具生效（含内置） |

> **与现役服务有关的事实**：`LB:ai-service/index.mjs:62` 传的是 `noTools: "all"`——**在这个选项下，就算加载了扩展，它注册的工具也一个都不会被激活**。要只留自定义工具，对应的是 `noTools: "builtin"`。

### 2.2 端到端往返 [实测]

`node e2-toolcall.mjs toolcall`（`results/e2-toolcall.txt`）。链路：扩展注册工具 → session（`noTools: "builtin"`）→ mock provider 发一个 `lb_word_lookup` 的 tool call → pi 执行 → 结果回灌 → 模型再答一次。

```
active tools      : ["lb_word_lookup","lb_reading_position"]
events:
  tool_execution_start name=lb_word_lookup args={"word":"読む","language":"ja-JP"}
  tool_execution_end name=lb_word_lookup isError=false
provider requests in this run: 2
  #0 roles=system|user
     advertisedTools=[lb_word_lookup,lb_reading_position]        ← 工具真的进了请求体
  #1 roles=system|user|assistant|tool
     assistantToolCalls=[{"name":"lb_word_lookup","args":"{\"word\":\"読む\",…}"}]
     toolResults=[{"id":"call_mock_1","name":null,"text":"読む: よむ・他動詞五段 — to read"}]
execute() invocations added: 1
  …Z lb_word_lookup word=読む
final assistant text: "ACK n=4 roles=system|user|assistant|tool tools=[lb_word_lookup,lb_reading_position] toolResults=[…読む: よむ・他動詞五段 — to read]"
```

四件事同时成立：**(a)** 工具在发给模型的 `tools` 里；**(b)** 模型发出的 tool call 被 pi 认下来并执行（`execute()` 的副作用日志出现）；**(c)** 结果作为 `role:"tool"` 回到模型上下文；**(d)** 内置工具在这个 run 里**一个都没出现**（`advertisedTools` 只有两个自定义工具）——`noTools:"builtin"` 做到了「只读工具面」。

### 2.3 负对照 [实测]

`results/e2-none.txt`（不传扩展路径）：`advertisedTools=[]`，模型仍然发出 `lb_word_lookup` 的 tool call，pi 回一条错误结果而不是崩：

```
tool_execution_start name=lb_word_lookup …
tool_execution_end name=lb_word_lookup isError=true
toolResults=[{"id":"call_mock_1","name":null,"text":"Tool lb_word_lookup not found"}]
execute() invocations: (no log file)
```

顺带一条：**即使工具不存在，`tool_execution_start/end` 事件照样发**（`isError=true`）——监听事件流不能只靠「有没有 start」判断工具是否真的存在。

---

## 3. 问题 3：`tool_call` 闸门

### 3.1 允许 / 阻止 / 就地改写，全部 [实测]

闸门就是一个普通的扩展（`ext/gate.ts`），`pi.on("tool_call", handler)`（**[源码]** `pi:dist/core/extensions/types.d.ts:939`）。它和注册工具的扩展**可以不是同一个文件**——本票的 gate 是独立扩展，照样拦到了另一个扩展注册的 `lb_word_lookup`（**闸门是全局的，不是 per-extension**）。

| 场景 | 结果 | 证据 |
|---|---|---|
| 放行 | `gate-decision=allow`，工具执行，`isError=false` | `results/e2-toolcall.txt` |
| `return { block: true, reason }` | **工具没执行**（`execute()` 调用数 0），模型收到 `isError=true`、内容为 `reason` 的结果 | `results/e2-gate.txt` |
| 就地改 `event.input` | 改写后的参数进了 `execute()`（`REWRITE:読む` → `word=読む`，命中词条） | `results/e2-rewrite.txt` |

block 的原始输出（`results/e2-gate.txt`）：

```
events: tool_execution_start name=lb_word_lookup args={"word":"FORBIDDEN"}
        tool_execution_end name=lb_word_lookup isError=true
toolResults=[{"id":"call_mock_1","name":null,"text":"blocked by #35 gate fixture"}]
execute() invocations added: 0
```

**[源码]** 语义确认：`ToolCallEventResult`（`types.d.ts:818`）只有 `block?: boolean` / `reason?: string` / `terminate?: boolean`；核心在**没有任何 `tool_call` 处理器时直接放行**（`pi:dist/core/agent-session.js:226-228`，前置票已记）。

### 3.2 改写不再校验 schema [实测]

**[源码]** `types.d.ts:721-722` 的注释原文：

```
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
```

**[实测]** `results/e2-rewrite-invalid.txt`：闸门把 `word`（schema 声明为 `string`）改成数字 `12345`，pi 照跑：

```
tool_call name=lb_word_lookup input={"word":"REWRITE_INVALID"}
gate-decision=rewrite-invalid (word := 12345, number)
tool_execution_end name=lb_word_lookup isError=false
execute() invocations added: 1
  …Z lb_word_lookup word=12345
```

**含义**：闸门能改参数，但**改坏了的责任在扩展**——下游拿到的可能是与声明不符的类型。

### 3.3 headless 能不能用 [实测]

闸门处理器里读到的上下文是 **`hasUI=false`、`mode="print"`**（`gate.log` 原文），处理器正常触发、正常 block/改写。也就是说**没有 TTY 也能做审批闸门**——但 `ctx.ui.*` 在 headless 下是 no-op（**[源码]** `runner.js:88-119`，子调研），所以「弹窗问人」这条路在服务里走不通，只能走「按策略自动放行/拒绝」或自己的进程外通道。上游 `examples/extensions/permission-gate.ts` 自己就是按 `ctx.hasUI` 分流的：没有 UI 就默认拦。

---

## 4. 问题 4：发布包的限制到底卡在哪

### 4.1 逐字事实

**[源码]** `pi:package.json:14-28`（`exports`）只有 4 个子路径：`"."`（`types`+`import`，**没有 `require`、没有 `default`**）、`"./rpc-entry"`（`import`）、以及**只有 `source` 条件**的 `"./client" → ./src/client/index.ts`、`"./experimental/plugin" → ./src/experimental/plugin.ts`。
`pi:package.json:29-39`（`files`）：`dist`、`!dist/client`、`!dist/experimental`、`!dist/cli/experimental`、`docs`、`examples`、`containerization.md`、`CHANGELOG.md`、`npm-shrinkwrap.json`。
实际安装树里 **`src/` 不存在**，`dist/client`、`dist/experimental`、`dist/cli/experimental` 也不存在。
**[源码]** `pi:docs/development.md:33` 原文（上下文标题是 `### Experimental remote harness`，`:24` 写着 "development-only"）：*"The `client` and `experimental/plugin` package subpaths resolve only under the `source` condition in a checkout. Their implementations and the server/client commands are excluded from npm packages and standalone binaries."*

### 4.2 实测解析结果（`cwd=ai-service`）

| specifier | ESM import | `--conditions=source` | `createRequire().resolve` |
|---|---|---|---|
| `.` | ✅ `dist/index.js` | ⚠️ 解析得到但**加载失败**（传递依赖也指向不存在的 `src/`） | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `./rpc-entry` | ✅ `dist/bundle/rpc-entry.js`（**会执行 CLI 的 `main()`**） | ❌ | ❌ |
| `./client` | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED` | ⚠️ 解析到 `src/client/index.ts`，加载 `ERR_MODULE_NOT_FOUND` | ❌ |
| `./experimental/plugin` | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED` | ⚠️ 同上 | ❌ |
| `./dist/core/extensions/types.js` | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED`（**文件在磁盘上，但被封**） | ❌ | ❌ |
| `./package.json` | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED` | ❌ | ❌ |

### 4.3 要把两件事分开（这是本题最容易混的地方）

- **(A) `exports` 封装 = 「解析」限制**：深路径（`dist/core/extensions/loader.js` 之类）**在磁盘上存在**，但被 `exports` 封住，`ERR_PACKAGE_PATH_NOT_EXPORTED`。这是**故意的 API 边界**，不是缺件。
- **(B) `files` 白名单 + 构建排除 = 「发布」限制**：`client` / `experimental` / `cli/experimental` **根本不在包里**（也不在 `src` 里）。这才是上游那句话说的东西。
- `./client` 与 `./experimental/plugin` **两层都中**——所以 `--conditions=source` 下它们从「没导出」变成「导出了但文件不存在」（错误码从 `ERR_PACKAGE_PATH_NOT_EXPORTED` 变成 `ERR_MODULE_NOT_FOUND`），正好是两层限制的干净对照。

### 4.4 扩展这件事卡不卡？不卡

**[实测]/[源码]** 三条：

1. **扩展加载的代码全部随包发布，且不受任何 `files` 排除影响**：`dist/core/extensions/{loader,runner,types,wrapper,index}.js` 都在；`files` 的三条否定只针对 `dist/client`、`dist/experimental`、`dist/cli/experimental`，与 `dist/core/extensions` 是不同子树。`dist/index.js:8` 从包根导出 `createExtensionRuntime, defineTool, discoverAndLoadExtensions, ExtensionRunner, wrapRegisteredTool(s), …`。
2. **jiti 是真依赖**：`pi:package.json` 的 `dependencies` 里有 `"jiti": "2.7.0"`；`loader.js:14,416-427` 用的就是它。
3. **上游自己的公开用法就是裸根 specifier**：`pi:docs/extensions.md`、`pi:docs/sdk.md`、`README.md` 里的扩展示例一律 `from "@earendil-works/pi-coding-agent"`，从不引用 `./client` 或 `./experimental/plugin`。

也就是说：**发布包的「只有 `.` 可用」限制，卡的是上游自己的 remote-harness 命令行（server/client/plugin）以及深路径 API，不卡扩展作者。** 本票全部实验都只 import 了 `.`（外加 jiti 别名解析），全部通过。

### 4.5 与「我们自己写的扩展」有关的两个包边界

虽然是扩展作者，仍会撞到两条：

- **`require()` 不行**：`"."` 只有 `types`+`import` 条件，CJS `createRequire(...).resolve()` 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`（§4.2）。扩展必须是 ESM。
- **类型面比运行时面窄**：`dist/index.d.ts:7` 以 `export type` 导出 `ExtensionAPI` / `ExtensionContext` / `InlineExtension` / `LoadExtensionsResult` / `ToolCallEvent(Result)` / `ToolDefinition` 等（类型可用），`:8` 以值导出 `defineTool` / `discoverAndLoadExtensions` / `ExtensionRunner`，`:17` 导出 `DefaultResourceLoader`。但 **TypeBox 的 `Type` / `TSchema` / `Static` 不从包根导出**——运行时靠 jiti 别名白拿，**类型检查时**需要自己的 `typebox` 依赖（或手写 JSON Schema + 忽略类型，本票的 `learnbuddy-tools.ts` 就是后者）。

---

## 5. 与现役 `ai-service` 有关的事实（不含建议）

- 现役配置是 `noExtensions: true` + `noTools: "all"` + `SessionManager.inMemory()`（`LB:ai-service/index.mjs:37-62`）。按 §2.1，**`noTools: "all"` 会把扩展工具一起关掉**；按 §1.2，**`noExtensions: true` 挡不住 `additionalExtensionPaths`**——两道锁里，真正让当前服务「没有工具」的是 `noTools: "all"` 和「一个扩展都没配置」。
- 现役服务已经把 `ModelRuntime.create({authPath, modelsStorePath})` 显式指向 agent dir（`index.mjs:54-55`），扩展加载所需的 `agentDir` 也在同一处——**加载扩展不引入任何新的凭据/状态路径**。
- 部署侧新增的一次性成本（[实测] 到的）：扩展文件必须随包发布到运行机能读到的路径；加载失败是静默的（§1.6），要读 `errors[]`；第三方依赖需要扩展自己的 `node_modules`（§1.5）。

---

## 6. 复跑脚本

脚本在 `research/pi-extensions/`（与 #32 的做法一致：脚本 + 原始输出随分支提交）：

| 文件 | 作用 |
|---|---|
| `mock-openai.mjs` | 本地 OpenAI 兼容 mock（SSE 流式）。由最后一条 user 消息驱动：`TOOLCALL:<name>:<json>` 触发一次工具调用，之后回文本。把每次请求的 `advertisedTools` / roles / tool results 记进 `requests.jsonl`。**零真实 provider 调用。** |
| `agentdir-models.json` | 把 mock 注册成 provider `mock`（baseUrl 指向 127.0.0.1:8199，apiKey 是字面量假值） |
| `ext/learnbuddy-tools.ts` | 只读工具 fixture（`lb_word_lookup` / `lb_reading_position`），**零运行时依赖** |
| `ext/gate.ts` | `tool_call` 闸门 fixture（allow / block / rewrite / invalid-rewrite） |
| `ext/typebox-tool.ts` | 运行时 `import { Type } from "typebox"` 的 fixture（`tb_echo`） |
| `fixtures/runtime-import.ts` | 运行时 import 包根（`defineTool`）的 fixture |
| `fixtures/needs-missing-dep.ts` | import 一个哪都不存在的包（失败模式） |
| `e1-load.mjs` | 加载 + `noTools` 矩阵 + 模块解析 + 失败模式 |
| `e2-toolcall.mjs` | 端到端工具往返 + 闸门（自带 mock 的启停） |
| `e3-discovery.mjs` | 发现位置 / 路径形态 / 内联工厂 |
| `e4-reload.mjs` | 改文件后的缓存与重载 |
| `run-all.sh` | 一次跑完，原始输出写进 `results/` |

复跑（本机）：

```bash
ln -sfn ../../ai-service/node_modules research/pi-extensions/node_modules   # 已在 .gitignore
bash research/pi-extensions/run-all.sh
```

lab（scratch agent dir + sessions + 日志）默认在 `LB:.scratch/pi-ext-lab/`，用 `PI_EXT_LAB=/tmp/pi-ext-lab` 可重定位。**不会碰 `~/.pi`、不会碰部署态。**

---

## 7. 明确未验证（不猜）

1. **发布包的 `npm pack` 现状**：没有真跑 `npm pack`（会写 `~/.npm`，超出本票的隔离边界），所有「不在包里」的判断都基于**实际安装树**（`src/`、`dist/client`、`dist/experimental`、`dist/cli/experimental` 均不存在）。
2. **standalone binary（bun `--compile`）里的扩展加载**：`docs/development.md:33` 那句把 npm 包与二进制并列，但本机没有二进制产物，**二进制这一半未测**；`loader.js:421-425` 显示二进制走 `virtualModules` 分支而非别名分支，行为**未验证**。
3. **`PI_BUNDLED_NODE` 打包 Node 发行版的行为**：同上的第三条分支，未测。
4. **`additionalExtensionPaths` 里的 npm 包 / git 源**：`resolveExtensionSources()` 似乎支持包安装，本票只测了本地文件与目录，**联网安装未测**。
5. **CJS 风格的 `module.exports = fn` 扩展**：jiti 的 CJS/ESM 互操作未测（包根也没有 `require` 条件）。
6. **`tool_call` 处理器抛异常时的行为**：未构造（只测了正常返回 `undefined` / `block` / 改写）。
7. **多个扩展同时注册同名工具的冲突规则**：未测（`_refreshToolRegistry` 是 `Map.set`，后写覆盖先写的**猜测不写入本票**）。
8. **上游 `docs/` 与发布版的其它不一致**：本票只核了 `pi:docs/development.md:33` 与 `exports`/`files` 相符；未做全量文档-实现对照（#32 已发现过一处 `getPath()` 不一致）。
9. **`session_start` 与扩展生命周期**：`session.bindExtensions()` 是否必须显式调用、`session_start` 在 SDK 嵌入下何时触发，本票没有单独测（本票的工厂注册路径不依赖它）。
10. **同进程内 loader 缓存的完整时序**：§1.7 只测了 4 个采样点，没有覆盖「多 loader 交错 + 多次 reload」的全部排列。
