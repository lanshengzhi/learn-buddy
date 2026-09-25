# 三个外部仓库调研：面向 LearnBuddy 的采用建议

- 调研日期：2026-09-25
- 目标：为 LearnBuddy 当前“家庭阅读器 + 独立 Learn 学习面 + 轻量 Chat”的方向判断哪些外部项目适合借鉴、集成或明确排除。
- 方法：分别克隆三个仓库到临时目录，阅读 README、领域/架构文档、核心源码、测试、部署与许可材料；未进行 NotebookLM 或微信读书的真实账号登录、在线 API 验证或端到端部署。
- 结论性质：源码调研，不是对上游服务可用性、账号政策、模型质量或第三方依赖的保证。

## 结论先行

**建议把三个仓库都当作参考实现或可选 provider 的来源，不把任何一个整体作为 LearnBuddy 的基础。**

优先级建议：

1. **Open Notebook：最值得学习架构，但不适合整体 fork。** 借鉴 provider/extractor 边界、显式上下文选择、durable job、source-grounded retrieval；保留 LearnBuddy 自己的 Book、Person、阅读位置、划线/想法和 Learn 状态模型。
2. **weread-omni：如果未来要接微信读书，参考价值和工程细节较高。** 它是很好的 provider 客户端参考，尤其是认证刷新、传输校验、缓存、写操作结果和 provider 能力边界；但其 WeRead 私有接口、E-Ink 身份、40 个操作和 CLI/skill 产品面不能成为 LearnBuddy 核心。
3. **notebooklm-py：只适合作为明确选择后的云端学习 provider POC。** 它技术工程质量很强，但依赖未公开的 Google API，数据和账户主要在 Google，且需要账号等价的 cookies/master token；不能让 LearnBuddy 把本地阅读状态交给 NotebookLM。

换句话说：

> **内容知识可以 provider 化；学习者状态不能 provider 化。**

这与 LearnBuddy 当前的领域边界一致：Read、Learn、Chat 是独立体验，Person 是本地记录的组织者而不是访问控制边界，Python host 拥有家庭数据，Node sidecar 只负责模型/会话运行时。

## 当前 LearnBuddy 的约束

调研时以仓库当前文档为准，主要约束如下：

- Python host 拥有书库、EPUB 解析、词典、TTS、Person 记录、阅读位置、History、词表、划线/想法以及浏览器 API。
- Node sidecar 只负责 pi/模型访问与流式运行时；Chat 的 Conversation 由 Python 产品数据拥有，当前按 Conversation 组装上下文，不能假设 Read 内容自动进入 Chat。
- Person 不是隔离/鉴权边界；家庭成员可以切换 Person。
- Read 有 Book、章节、句子级阅读位置和阅读进度；Learn 有粘贴文本的断句、逐句听读/循环和 passage history。两者不能因为都使用 EPUB 或 AI 就混成一个模型。
- 上线策略是旧壳 `/` 与新壳 `/next` 并行、按阶段试用、失败可回滚，而不是一次性替换。

因此，外部项目是否“有 RAG/AI/阅读”不是首要判断标准；要问的是：**它能否在不夺走 LearnBuddy 领域权威和本地可用性的前提下，补足一个明确的能力缺口？**

## 仓库一：notebooklm-py

仓库：<https://github.com/teng-lin/notebooklm-py>  
调研版本：`978467ecdf810be85e4d4cbc37e57945d46fd194`（main，2026-09-23；报告还检查了 v0.8.2）  
许可：MIT

### 它是什么

它是 Google NotebookLM/Gemini Notebook 的**非官方 Python 自动化客户端**，不是阅读器、学习管理器或本地知识库。其主要用户流程是：

1. 用浏览器 cookie、导入 cookie 或 master token 认证 Google；
2. 创建/选择 Notebook；
3. 加入 URL、文本、本地文件、YouTube、Google Drive 等 source；
4. 等待 Google 异步索引；
5. 进行 grounded chat、research、notes；
6. 生成并下载 podcast、video、quiz、flashcards、报告、表格、mind map 等 artifact。

其规范数据主要位于 Google 账户：Notebook、Source、索引状态、server-side conversation、artifact、quota/tier 等都在远端。`profiles/` 是认证上下文，不是 LearnBuddy Person；`notebook` 也不是 LearnBuddy Book；`source` 也不是章节/句子。

### 值得借鉴的部分

- **稳定的 typed feature facade。** `NotebookLMClient` 下按 notebooks、sources、artifacts、chat、research 等能力命名空间组织，调用方不必直接碰底层 RPC。
- **薄 adapter + 中间 workflow core。** CLI、MCP、REST 都位于共享的应用层之上；前端适配器不直接构造 wire-level RPC。
- **对远程副作用结果分级。** `NOT_SENT`、`REJECTED`、`UNKNOWN`、`CONFIRMED` 区分“未发出、明确拒绝、结果未知、确认成功”，避免网络超时后盲目重试造成重复 source、重复生成或重复计费。
- **可复用的工程纪律。** 集中错误分类、总 deadline、drain-before-close、并发上限、原子且权限受控的凭据写入、AST 边界测试、录制协议 fixture。
- **两个后端、一套高层语义。** Web 和 Android transport 分离，公共 feature contract 保持一致；这是 provider 隔离的好例子。

### 不适合直接采用的部分

- Google 未公开 API、认证和账号风控变化是首要运营风险。
- `storage_state.json` 与 master token 是账号等价凭据；不能交给 Web 进程或普通日志路径。
- 上传书籍就是把内容交给 Google 做索引/推理；家庭成员的可见性、保留、删除和撤回需要单独产品决策。
- Notebook/Source/Artifact 不能通过改名映射成 Person/Book/LearningRecord。
- 其 REST/MCP 适配器是单租户/实验性质，不能直接暴露给家庭成员作为多用户服务。
- Beta、0.x、main 比 release 超前，升级必须 pin 精确版本并审阅 changelog。

### 对 LearnBuddy 的建议

**拒绝 wholesale adoption；只允许 time-boxed、隔离的云端 StudyProvider POC。**

可考虑的用户动作必须明确告知“将把选定内容上传到 Google”，例如：

- 将用户明确选中的段落送去生成 grounded study guide / quiz / flashcards；
- 对用户选定的材料进行一次明确的云端问答；
- 将生成物下载回 LearnBuddy，作为本地可选资料。

建议的边界：

```text
LearnBuddy UI
  -> 用户明确选择内容并确认上传
  -> LearnBuddy-owned StudyProvider interface
  -> 独立 worker / sidecar
  -> 固定版本 notebooklm-py public API
  -> 专用 Google 账号 / notebook
  -> 可选：下载 artifact 回本地
```

LearnBuddy 只保存 correlation ID、状态和用户选择保留的输出元数据；不把 Google notebook/source 状态当作本地真相，不向上游暴露 Person、Book 或 cookies。

### POC 前必须过的门

- 明确动作属于 Learn、Chat 还是新的“Research/Study”区域；不能静默把 Read 内容送进 Chat。
- 写清 Google 账号、可见性、保留、删除、下载、家庭成员混合使用时的语义。
- 专用账号、独立服务用户、最小文件权限、日志脱敏、凭据撤销/轮换流程。
- 测试 cookie 过期、账号风控、rate limit、quota、source reject、长任务、部分结果、进程重启和 UNKNOWN 写结果。
- 禁用 provider 后，Read/Learn/本地 TTS/词典/History 仍完全可用。
- 固定 release/tag/commit，不依赖 main。

## 仓库二：Open Notebook

仓库：<https://github.com/lfnovo/open-notebook>  
调研版本：`3127f14ea9dbb519f0e4ddc64a0742ca644ba6ef`（main，package metadata 为 1.14.0；main 比 v1.14.0 tag 更新）  
许可：项目 MIT；完整部署栈需单独审查（尤其 SurrealDB v2 的 BSL）

### 它是什么

Open Notebook 是自托管、隐私/可控、provider-agnostic 的 NotebookLM 风格**研究工作台**。它的核心回路是：

1. 配置一个或多个模型 provider；
2. 创建 notebook；
3. 加入文件、URL、粘贴文本、音视频；
4. 异步抽取全文，必要时做 OCR、转录、chunk、embedding；
5. 选择上下文来源/insight/full text；
6. 进行 source-grounded chat、search、notes、transformations；
7. 可选地生成 podcast 等后台 artifact。

它的强项是“把大量材料变成可检索、可引用、可讨论的知识工程系统”，而不是“让一个学习者持续阅读、标记、复习和掌握”。

### 与 LearnBuddy 有价值重叠的能力

- 多格式 source ingestion 与离线文本抽取；
- 全文/向量检索；
- 显式控制哪些 source、note、insight 进入模型上下文；
- source-grounded answer 和可追溯引用；
- reusable transformation/prompt；
- provider registry/provisioning，避免业务代码直接实例化各厂商 SDK；
- 长任务使用 durable job、状态观察和 retry policy；
- “先限定 notebook/source scope，再限制结果数量”的检索策略。

这些可以作为 LearnBuddy 未来的 **content knowledge subsystem**，但不能替代 LearnBuddy 的 reader 和 learner-state。

### 关键产品缺口

源码、路由、数据模型和测试中没有找到一等的：

- Book 阅读位置/断点；
- highlights/annotations 与段落锚点；
- 学习目标、学习 session、study plan；
- quiz、练习、自测、掌握度/错题；
- spaced repetition 或 review schedule；
- 跨书/跨阶段学习进度。

所以“Open Notebook 有学习相关能力”不能等价为“它有学习产品模型”。它更像知识库/研究工作台，学习状态仍需 LearnBuddy 自己拥有。

### 架构与运营代价

当前运行形态大致是：

```text
browser -> Next.js frontend -> FastAPI -> SurrealDB
                                  -> background worker
                                  -> AI/media/extraction providers
```

关键代价：

- Next.js + FastAPI + SurrealDB + worker + filesystem 音频/缓存/上传目录；
- 启动 migration，worker 缺失时 source processing、embedding、transformation、podcast 可能一直排队；
- 备份要同时覆盖数据库卷和 app data 卷；
- 可选 OCR、浏览器、Crawl4AI、Docling、本地模型会显著增加磁盘/内存/冷启动；
- 默认单用户，密码只是 private-instance gate，不是家庭成员身份/授权系统；
- 依赖 mutable image tag 并不利于可重复部署；
- 文档和当前源码存在漂移，且关系方向/查询路径需要真实数据库集成测试确认；
- 主仓库 MIT 不代表完整镜像、SurrealDB、模型、字体和所有传递依赖都是 MIT。

### 对 LearnBuddy 的建议

**作为 reference implementation，而不是 foundation；除非 LearnBuddy 明确决定转型为本地研究工作台。**

建议独立吸收这些设计：

1. Notebook/project scope：可作为“资料范围”概念，但不要取代 Book 或 Person。
2. evidence / synthesis / conversation 分层：原始 source/chunk、可编辑 note/insight、chat transcript 分开。
3. explicit context modes：当前句、当前章节、用户选定 source、完整资料集必须由产品明确选择。
4. provider/extraction ports：LearnBuddy 自己定义最小接口，外部项目只做适配器。
5. durable jobs：稳定 job ID、状态、重试、失败分类、取消语义、幂等测试。
6. notebook-scoped retrieval：先限定范围，再做 limit，避免“检索到范围外内容”。
7. capability detection 与 graceful fallback：不能因为可选 provider 不可用而使阅读器失效。

不建议复制：

- 整个 Next.js/FastAPI/SurrealDB/worker 部署；
- SurrealDB schema；
- podcast/media 子系统；
- 三栏研究工作台作为完整 LearnBuddy UI；
- 把 highlights/learning progress 塞进通用 notes；
- 以 main/v1-latest 作为可复现依赖；
- 默认可变部署引用和单密码部署。

### 如果要做 POC，必须限定范围

1. pin release、commit、镜像 digest，记录 SurrealDB 实际版本和许可证。
2. 用本地模型/本地抽取（可行处）做一次真实部署。
3. 用真实 PDF、EPUB、网页和音频验证：source 定位、引用、chunk 边界、长文上下文和点击回原文。
4. 用真实 SurrealDB/worker 验证：多 notebook 关联、删除级联、搜索范围、job 重试/重启、双卷 backup/restore。
5. 测量冷启动、磁盘、内存、吞吐、搜索延迟、worker/API/DB 中断后的恢复。
6. 单独写学习状态模型，不能为了少建一个领域而把所有东西塞进 notes。
7. 做认证、CORS、上传路径、SSRF、secret rotation、删除/导出和 API 暴露面审查。

## 仓库三：weread-omni

仓库：<https://github.com/teng-lin/weread-omni>  
调研版本：`88bd2e095d7d7ee423eaadf8f40653e72c5be6d4`，v0.1.2（2026-09-14）  
许可：MIT

### 它是什么

weread-omni 是个人微信读书自动化客户端和 agent integration，不是通用阅读/学习应用。它把一组 WeRead 操作统一暴露为：

- TypeScript SDK；
- JSON-capable CLI；
- packaged agent skill。

操作覆盖搜索、书籍元数据、书架/阅读进度、笔记/划线/想法、公众号文章、阅读统计、推荐、微信读书 AI、个人书导入等，但不提供课程、学习 session、间隔复习、掌握度、learner profile 或跨 provider 内容抽象。

### 值得借鉴的部分

- **CanonicalClient + capability namespaces。** 适合做 WeRead provider，但不是完整的多 backend router。
- **provider/plugin boundary。** 账户、设备、登录和 client 可以注入；但插件是受信任的进程内代码，不应直接成为 LearnBuddy 的低权限扩展机制。
- **传输安全。** base-origin/path 校验、拒绝 redirect、响应体上限、HTTP 200 + negative error envelope 处理、类型化 transport/protocol error。
- **认证生命周期。** token refresh single-flight、凭据持久化串行化、单个调用取消不取消共享 refresh。
- **声明式 operation spec。** 参数、默认值、必填字段、write gate、destructiveness 和 schema extras 集中声明，避免 SDK/CLI/skill 漂移。
- **写操作结果。** 对不可安全重放的 mutation 标记 ambiguous outcome。
- **缓存 decorator。** `prefer` / `refresh` / `off`，读失败可降级为 miss，写失败不伪装成请求结果成功。
- **本地内容库。** SQLite WAL、account-scoped metadata、SHA-256 content-addressed blobs、digest 校验、symlink refusal、原子权限写入。

调研中该仓库的 `npm run typecheck`、`npm run lint`、`npm test`（48 files，1070 tests，3 skipped）和 e2e（13 tests）通过；但没有 live WeRead 账号测试，且 `npm audit` 仍报告开发链高危和生产 COS SDK 中 moderate findings。版本仍 pre-1.0，不能把测试数量直接等同于长期服务稳定性。

### 不能成为 LearnBuddy 核心的部分

- WeRead 40-operation surface；
- E-Ink device identity/signing；
- shelf/highlight/review/cursor 语义；
- COS import pipeline；
- 微信读书 CLI 层级和 packaged skill 产品面；
- 微信读书本地 schema 作为 learner-state 存储；
- 文章内容“可直接当可信知识”的假设。

WeRead 使用非公开接口，账号权益、风控、内容权限和接口都可能变化。写入默认可用，必须为 LearnBuddy 的用户动作增加显式授权。`WEREAD_READONLY=1` 只能作为运维总开关，不能替代产品级 consent。

文章/外部内容应视为不可信输入：即使抽取为 Markdown，也不会自动消除 prompt injection、恶意链接、危险渲染或隐私泄漏。

### 对 LearnBuddy 的建议

**把 weread-omni 当高质量 provider 参考，最多作为隔离的可选 WeRead provider。**

如果未来真的需要同步微信读书：

```text
LearnBuddy-owned ContentProvider interface
  -> WeRead provider adapter
  -> pinned weread-omni SDK / isolated worker
  -> LearnBuddy-owned Book/Source/Provenance records
```

原则：

- LearnBuddy 自己的 Book/Person/阅读位置仍是本地真相；
- 外部账号、token、设备身份、缓存和风控状态不进入核心领域；
- 读操作和写操作分权；导入、划线、删除、发布等必须显式确认；
- 记录 source provenance、provider account、remote ID、fetched_at、content hash；
- 明确缓存保留、删除、重新同步和远端删除策略；
- provider 挂掉时，已导入的本地内容仍可读；
- 先固定精确版本/commit，不跟随 main 或未固定的 npm latest。

## 横向比较

| 维度 | notebooklm-py | Open Notebook | weread-omni | LearnBuddy 结论 |
|---|---|---|---|---|
| 核心产品 | Google NotebookLM 非官方客户端 | 自托管研究/RAG 工作台 | 微信读书自动化 SDK/CLI/skill | 三者都不是 LearnBuddy 核心 |
| 权威数据 | Google 账户 | SurrealDB + filesystem + checkpoints | WeRead 远端 + 本地 cache | LearnBuddy 本地数据应保持权威 |
| 学习状态 | 有 artifact/quiz 能力，但无 LearnBuddy reader state | 基本没有学习进度/复习模型 | 没有学习领域 | 必须由 LearnBuddy 自建或明确另做 |
| 最佳价值 | 云端 grounded study artifact | provider/extractor/job/retrieval 架构 | 微信读书 provider 工程 | 按能力逐项吸收 |
| 主要风险 | 未公开 Google API、凭据和数据外传 | 部署重、数据库/许可/单用户/文档漂移 | 未公开 WeRead API、账号风控、pre-1.0 | 都必须隔离、pin、显式授权 |
| 适合整体 fork | 否 | 默认否；只有产品转型为研究工作台时才考虑 | 否 | 默认都不整体采用 |
| 适合作为依赖 | 仅固定版本、隔离的 StudyProvider POC | 先 spike/局部移植，完整栈需评估 | 仅未来 WeRead provider 场景 | 默认由 LearnBuddy 自己定义接口 |

## 推荐的 LearnBuddy 目标架构

### 1. 保持现有 Python host 的领域所有权

不要因为外部项目有 RAG/agent 能力就把所有东西放进 Node sidecar 或第三方数据库。Python host 继续拥有：

- Book、章节、句子、阅读位置；
- Person 相关 Read/Learn 数据；
- highlights、notes、History、Word state；
- 权限、隐私和本地数据删除语义；
- provider 选择、任务状态和错误映射。

### 2. 定义 LearnBuddy 自己的最小 provider ports

建议先定义能力，而不是复制上游 namespace：

```text
ContentProvider
  search / metadata / fetch / import / sync_progress
  （能力显式声明；不支持的 operation 返回 unsupported）

StudyProvider
  submit(selected_content, task) -> job
  status(job) -> queued/running/ready/failed/unknown
  fetch_output(job) -> local artifact reference
  cancel(job)

ModelProvider
  explain / chat / stream
```

重要规则：

- provider DTO 不直接进入 Person/Book/Conversation 领域；先映射为 LearnBuddy-owned 类型。
- 每个远程对象都有 correlation ID、provenance、remote ID 和内容 hash。
- 远程写操作使用 `not_sent / rejected / unknown / confirmed`，不把 timeout 当失败后盲重试。
- 远程作业必须可观察、可恢复、可取消；不允许只有“后台 pending”。

### 3. 抽出 content knowledge，不抽出 learning state

可以新增一个内部概念（例如 ContentScope/SourceLibrary）来容纳：

- 原始 source；
- 抽取文本；
- chunk/embedding；
- source-grounded notes/insights；
- 引用和 provenance。

但以下仍由 LearnBuddy 领域拥有：

- 阅读位置；
- Person 的阅读/学习记录；
- highlight/note/word state；
- Learn 的句子与 passage history；
- Chat Conversation 及其产品语义。

特别要避免把“阅读划线”存成通用 RAG note、把“学习历史”存成 provider conversation，或用远程 notebook ID 替代本地 Book ID。

### 4. 外部 provider 必须是可选、可关闭的

所有外部研究/同步能力都应满足：

- 显式开启，不自动上传整个书库；
- 用户选择具体内容/目标；
- 显示数据将离开家庭的 provider；
- 失败不影响本地 Read/Learn；
- 能停止、重试、删除和导出本地缓存；
- provider 凭据与 Web/Python 数据目录分离；
- 每次依赖升级有版本、变更和安全审查记录。

## 决策建议

### 推荐现在做

1. **不整体引入任何一个仓库。**
2. **把 Open Notebook 作为架构参考，优先提炼 provider/extractor/job/context 四个模式。**
3. **把 weread-omni 记为未来 WeRead provider 候选，不在 v1 增加微信读书范围。**
4. **把 notebooklm-py 记为可选云端 StudyProvider 候选，不在 v1 默认接入。**
5. 在 LearnBuddy 自己的文档中记录“content knowledge vs learning state”的边界，避免未来因 RAG/agent 需求重新混域。

### 暂不建议做

- fork Open Notebook 作为 LearnBuddy 新后端；
- 将 NotebookLM notebook 或 WeRead shelf 作为 Book/Person 的真相；
- 用外部项目的 Chat/Agent skill 取代 LearnBuddy 的 Chat 领域模型；
- 把高风险的账号 cookie/master token 放进主服务；
- 为了“有 RAG”而引入 SurrealDB、vector DB、worker 集群等目前没有需求证明的基础设施。

### 可考虑的时间盒 POC

如果产品决策仍不确定，按以下顺序做最小实验：

#### POC-A：本地 source-grounded retrieval（优先）

- 选 1 本代表性 EPUB 和 2–3 份网页/PDF；
- 复用当前 Python 解析结果，不先引入 Open Notebook 全栈；
- 只验证“选段 → 检索 → 引用 → 回到原句/章节”；
- 测量索引、检索、上下文预算、引用定位和离线降级。

这是最贴近 LearnBuddy 核心价值、风险最低的实验。

#### POC-B：WeRead 只读导入

- 固定 weread-omni 版本；
- 仅验证登录、搜索/元数据、书架/进度读取和内容导入；
- 不做写回，不上传本地内容，不引入 WeRead AI；
- 检查账号权限、风控错误、缓存 provenance 和删除行为。

只有在家庭明确需要微信读书同步时才做。

#### POC-C：NotebookLM 云端 study artifact

- 固定 notebooklm-py release；
- 只上传单段/单篇用户明确选择的材料；
- 只生成 study guide/quiz 等异步 artifact；
- 单独账号/worker/权限/日志；
- 先验证“provider 挂掉不影响本地”和“远端删除/导出”；
- 不允许它持有 Person/Book/Conversation 真相。

它的价值是验证用户是否真的需要“云端长任务产物”，不是验证能否把 NotebookLM 嵌进阅读器。

## 许可证和供应链注意

三个仓库本身均报告 MIT，但：

- MIT 只覆盖作者授予的代码权利，不授予 Google NotebookLM、WeRead 内容、账号或第三方服务使用权；
- Open Notebook 的完整部署包含 SurrealDB v2 等不同许可/组件，必须锁定实际镜像版本并做 SBOM/依赖审查；
- 不要因为主仓库 MIT 就假设 npm/pip 传递依赖、字体、模型、数据库镜像都 MIT；
- 如果复制代码，保留版权和许可声明；如果只借鉴设计，仍要记录来源和适用版本。

## 调研限制

- 未使用真实 Google/WeRead 账号验证登录、配额、风控、删除、共享和服务条款。
- 未在 LearnBuddy 上部署 Open Notebook 全栈，也未跑其真实数据库/worker 集成测试。
- 外部仓库的 main、版本和依赖会变化；本报告的结论绑定到开头列出的 commit/version。
- 未来若决策依赖上述服务的可用性或法律条款，应重新做一次带版本、镜像 digest 和实际依赖树的审查。

## 一句话决策

**先不合并任何外部应用；先把 Open Notebook 的边界设计、weread-omni 的 provider 工程和 notebooklm-py 的远程作业纪律分别吸收到 LearnBuddy 自己定义的接口里。只有经过明确用户选择、隔离运行和失败可降级的 POC，才把外部服务接入产品。**
