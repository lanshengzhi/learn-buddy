# Family hub v1 — implementation specification

> **这份规格的地位**：它是 wayfinder 地图 **#23** 的终点产物。16 张决议票全部关闭，前线为空。
> 票里是**推理过程**，这里只放**结论**；每条结论都能追到一张票或一条 ADR（见文末索引）。
> 后续 effort 可以直接照这份排期实施。**本规格对应的规划工作不进入执行。**

## 1. 这是什么

把 LearnBuddy 从「一个语言阅读器」长成「**家庭 AI 中枢**」：一个壳、两个面、每人一个身份。

- **Chat** —— 自由对话（每人一个，跟着身份走）
- **Read** —— 阅读器（已上线，本规格只描述它要长成什么样）
- 一个 **身份 chip** 决定「现在是谁」，换的是整套：**书 · 进度 · 词表 · 对话**

**已定的承载栈**：引擎 = **pi**（当库用）；壳 = **自研**；宿主 = **Python**，pi 跑在 **Node 边车**里。

## 2. v1 范围

### 做

| | |
|---|---|
| 壳 | 左侧栏（可收起）+ 两个面；宽窄屏两套呈现（§4） |
| Chat | 每人一个；新建 / 续聊 / 删除；按时间分组的会话记录 |
| Read | 书架（分类 + 导入）/ 默认打开上次阅读 / 目录 / 生词 / **我的划线** |
| AI | **D3 右侧对话栏是唯一的 AI 出口**；点词出词卡；选段出工具条；AI问书引用原文 + 预设 prompt |
| 划线与想法 | 马克笔（整句底色）、写想法（纯文本、一句一条） |
| 引用 | 默认当前章节；`@` 另一章、`@` 某个词 |
| 记忆 | 对话列表 + 续聊已存对话（**仅此**） |

### 不做（以及为什么）

| 不做 | 为什么 |
|---|---|
| **Work 面**（项目 / 文档 / 代码） | 用户 2026-09-22 从需求中移除；副产品是「局域网上的 RCE」基本消失（agent 不再持有 `bash`/`write`/`edit`） |
| **agent 的工具**（查词典 / 书库 / 位置 / 词表） | 查义产品已做掉且更快；用户列出的场景只依赖选中段 + 当前章节；推迟不花钱而收回很难（票 #36） |
| **跨人询问**（「问女儿的 agent」） | 用户移除；每人一个 Chat，跟着身份 chip 走（票 #34） |
| **安全边界 / 鉴权 / 数据隔离** | 明确划出范围：v1 所有人权限相同（地图 Out of scope）。**见 §9 的「归属 vs 可达」** |
| **PWA / 离线** | 唤醒 PWA 需要 HTTPS 来源而非 PWA 本身；且内容离线已被 ADR 0007 拿走（票 #38） |
| **书内检索 / 跨对话检索 / 提炼的个人事实** | 未来演进（票 #26、#36） |

## 3. 领域模型

**词汇表是 `CONTEXT.md`**，此处只列本图改动与新增：

| 词 | 含义 | 来源 |
|---|---|---|
| **Person (人)** | 家庭成员。**由 `Profile` 改名** —— 旧名描述的是它已经长大的角色 | ADR 0011 |
| **Conversation (对话)** | 说话的单位；一段可存储、可续聊的线程。Chat 面的单位 | ADR 0011 |
| **Memory (记忆)** | 一次对话之后留下来的东西。**v1 = 对话列表 + 续聊** | ADR 0011 |
| **Reference (引用)** | Person 手工把阅读域的一段挂到 Conversation 上。**两层之间唯一的通道** | ADR 0011 |
| **Highlight (划线)** | Person 对**一个句子**的标记，背景色 | ADR 0011 |
| **Note (想法)** | Person 对一个句子的纯文本备注，一句一条，显示在句下 | ADR 0011 |
| ~~`agent`~~ | **不是产品词汇**，进 *Terms we avoid*；它是运行时（pi / DSH）的说法 | ADR 0011 |

**两条必须写进实现的区分：**

1. **归属成立、可达不成立。** 每个人的书 / 进度 / 词表 / 对话 / 记忆**属于他**；但**没有密码、没有登录、没有隔离**，任何人点一下 chip 就能切成任何人。这是两句独立的话，别把它们合并。
2. **阅读状态不是记忆。** `Reading position` / `History` / `Word state` / `Highlight` / `Note` 是**阅读域**自己的一层；`Conversation` / `Memory` 是**对话域**。两层只通过 `Reference` 相连。

## 4. 壳与交互

### 4.1 宽屏（≥ ~900px）

```
┌──────────┬────────────────────────────┬──────────────┐
│ 左导航   │  面的内容                  │  D3          │
│ 可收起   │  （Read：正文 / Chat：对话）│  AI 对话栏   │
│          │                            │  （按需出现）│
├──────────┤                            │              │
│ 现在是谁 │                            │              │
└──────────┴────────────────────────────┴──────────────┘
```

- **左导航**：`Chat`（下方挂**会话记录**）、`Read`（下方挂**阅读记录**）、底部**身份 chip**。可收起成 54px 图标栏。
- **身份 chip**：标题「**现在是谁**」，副标题列出它换的是整套（书 · 进度 · 词表 · 对话）。**只有一个**。
- **D3**：右侧对话栏，**唯一的 AI 对话出口**，**不属于任何一个面**。

### 4.2 窄屏（< ~900px）

| 宽屏元素 | 窄屏形态 |
|---|---|
| 左导航 | **抽屉**（点汉堡或从左缘划入）—— 里面仍是同一个侧栏 |
| D3 | **全屏覆盖层**（从右滑入、占满、带返回） |
| 正文 | **单栏全宽**（左右留 padding） |
| 词卡 | **底部卡片**（不再贴着词——小屏上贴词的浮层会盖住上下文） |
| 选中工具条 | 仍浮在选区上方；**要处理虚拟键盘**（写想法时） |

> ⚠️ **`#27` 的原型只覆盖宽屏。窄屏这一套是纸面决定，未经验证。** 实现时建议先做一个窄屏原型。

### 4.3 阅读交互（Read）

- **点一个词** → **直接弹词卡**（不先出工具条）：`读音`（中文书为`拼音`）+ `文中意思`；底部「我认识」与「**追问 →**」。
- **拖选一段** → **工具条**：`复制` · `马克笔` · `写想法` · `AI问书`。
- **马克笔** → 该句加背景色（toggle）。
- **写想法** → 就地弹出输入；想法显示在那句下面；再次点击即编辑。
- **AI问书** → 开 D3，**引用选中的原文**，并给出四个**可直接执行**的预设 prompt：
  `断句解析` · `逐词解释` · `语法点` · `翻译成中文`
- **词卡的「追问 →」** → 同样开 D3（与 AI问书同一条通道）。

> ⚠️ **一条实现层的硬约束**：正文里每个字都在词 span 里，**「点一句」永远点不到**。查词与问书的分流**只能按选区长度判定**：短选（≤3 字）= 词 → 词卡；长选 = 段 → 工具条。

### 4.4 Read 的两态

- **没读过** → **书架**：分类胶囊 + 封面网格 + 「＋ 导入 epub」。
- **读过** → **默认打开上次那本书与阅读位置**；顶栏 `☰ 书架` 可回书架。
- 阅读面顶栏：`☰ 书架` · `目录` · （书名 / 章名） · `生词` · **`划线`** · `Aa`。

### 4.5 视觉分工（不打架）

| 机制 | 通道 | 单位 |
|---|---|---|
| 马克笔（`Highlight`） | **句子背景色** | 句 |
| 生词提示 | **词下划线**（软、三档） | 词 |
| `Word state`（我认识） | 不渲染，影响生词提示 | 词 |

⇒ **句归马克笔，词归 `Word state`。马克笔不标词。**

## 5. 上下文与引用

| 场景 | agent 看到什么 |
|---|---|
| 打开 D3 时 | 默认 **当前章节全文** |
| 从选区打开 | 加上**选中的那段**（自动） |
| `@` 另一章 | 显式引用 |
| `@` 某个词 | 显式引用 |
| 其他 | **一律不带**（不默认带全部阅读史——成本与可预测性） |

**没有工具**：agent 不能自己去查任何东西（票 #36）。上下文全部由 Python 组装后递给边车。

## 6. 数据与存储

### 6.1 存储位置（沿用 ADR 0010）

```
/opt/learnbuddy/            代码（root 拥有，服务只读）
/var/lib/learnbuddy/        状态
  profiles.json             ← Person 名单（标识符仍拼旧词，见 §9）
  state/<person>/{prefs,history,words}.json
  state/<person>/highlights.json      ← 新增
  state/<person>/notes.json           ← 新增
  books/<sha256>/{book.epub,manifest.json,chapters/NNNN.json,positions/<person>.json}
  dicts/{en,ja,zh,kanji}.sqlite
  ai-agent/                 ← pi 的 agent dir（auth.json 0600）
    sessions/--<cwd>--/     ← 会话，按 cwd 分组（§7）
/var/cache/learnbuddy/tts   可丢弃缓存
/etc/learnbuddy/learnbuddy.env
```

### 6.2. 新增两个文件的形状

```jsonc
// highlights.json   —— 划线：句子下标
{ "<bookId>": { "<chapterIndex>": [ 12, 13, 40 ] } }

// notes.json        —— 想法：句子下标 → 文本（一句一条）
{ "<bookId>": { "<chapterIndex>": { "12": "这里是一句惯用表达" } } }
```

- **一类一文件**（ADR 0007），`.tmp` + 原子 rename，无锁，类内 last-write-wins。
- **重锚**：沿用 `Reading position` 的做法 —— 章 + 句号 + **句首文本**。重新解析后按句首文本重锚；**重锚不到的记录不删**（记录很小），只是不渲染，将来再解析出来还能回来。**不静默丢用户数据。**

### 6.3 删除规则

**删除 Conversation 只删对话。** `Highlight` / `Note` / `Reading position` / `History` / `Word state` **一律不受影响** —— 它们是阅读域的独立记录，锚在句子上，从不挂在对话里。

## 7. 进程与部署

```
        ┌───────────────┐        ┌──────────────────────┐
浏览器 ─│ Python 宿主   │───────▶│ Node 边车（单进程）  │──▶ OpenAI
        │ :80           │  流式  │ pi：会话 / 模型 / 凭据│
        │ 全部数据 + 壳 │◀───────│ **不拥有家庭数据**   │
        └───────────────┘        └──────────────────────┘
```

- **Python 拥有**：书库 / 解析 / 词典 / TTS 与缓存 / Person 记录 / 阅读位置 / History / 词表 / 划线想法 / **壳与浏览器面**。
- **Node 拥有**：pi 会话（内容 + 续聊）、模型访问、凭据、token 流式。**不拥有任何家庭数据。**
- **会话列表归 Node**，Python 代理。（Python 存副本会造两份真相；无状态 Node 会扔掉 pi 的一等续聊。）
- **Person ↔ session 靠 `cwd` 表达**：pi 把会话落在 `<agentDir>/sessions/--<cwd 编码>--/`，所以给每人一个 **per-Person cwd**，**目录本身就是映射** —— Node 仍然不知道 `Person` 这个概念，它只收到一个 cwd 字符串。
- **边车必须单进程**：pi 的 session 文件**没有任何锁**，第二个写者会**静默写成分叉树**。一个进程扛 20 个会话无压力。
- **一个 pi agent dir**（`/var/lib/learnbuddy/ai-agent/`，`learnbuddy` 拥有，`auth.json` `0600`）。**不给每人一个**：凭据刷新轮换会让多份互相失效。
- **systemd**：沿用 `learnbuddy.service` / `learnbuddy-ai.service`；边车要显式设 `PI_CODING_AGENT_DIR`（pi 无 daemon 文档，**无 TTY 时会静默降级成 print mode**），并加 `PrivateTmp=true`（pi 的 spill 文件在 `$TMPDIR` 里永不回收）。
- **边车挂了**：阅读器**完全可用**（读书 / 朗读 / 查义 / 划线 / 位置），只有 Chat 与 D3 不可用。

### 7.1 会话的删除（v1）

- **能删、硬删**（删文件）。软删在「记忆属于个人」的语义下是**假的删除**。
- **删之前必须先关掉那个 session**（session 文件无锁）。
- **不设上限，按时间分组**（今天 / 昨天 / 本周 / 更早）。**归档现在不能做**：还没有检索，先归档等于把东西藏起来。
- 删除由**边车**执行，Python 只发指令。

## 8. AI 层

- **`Conversation` 无工具**：pi 以 `noTools: 'all'` 启动（**注意**：`noTools: 'builtin'` 才是「只留自定义工具」，v1 不需要）。
- **续聊**：用 pi 的一等会话续聊（跨进程实测：历史与模型都从 session 恢复）。
- **流式**：token 级（`session.subscribe()` → `message_delta`）。
- **agent dir 与凭据**：沿用现役 pi 的 `auth.json`（openai-codex 订阅）。**刷新在锁内做、锁内复核过期**，所以两个进程可安全共用一份 —— 但 v1 只有一个进程。
- **provider**：家里现有的 **OpenAI** 订阅。**出家门的是**：当前章节（默认）+ 引用 + 对话历史。
- **成本**：**不设上限、不按人配额**（订阅路线无边际成本，且按人配额在单条 OAuth 路由上不可表达）。**token 记入日志但不展示** —— 订阅下的名义成本不是花掉的钱。
- **错误词汇**新增 **`ai_usage_limit`**，文案「**AI 用量受限**」，带恢复时间就显示「约 N 分钟后恢复」。
  **不得叫 `quota_exhausted`**：pi-ai 把「订阅额度用完」与「短时 rate limit」混成同一句英文，那样叫会在限流时误报。

## 9. 工程要求（全部由实测得来，不是风格偏好）

1. **关键写入必须读回校验。** pi 的 `SettingsManager` 在锁竞争时**不抛错**，而是把 `ELOCKED` 吞进 `drainErrors()` —— 「没报错」≠「写进去了」。
2. **上游 message 不得转发给前端。** `parseErrorResponse` 里 `message` 的初值是**整个响应体**，某些失败路径会把原始响应体当成错误消息。只有产品自有的固定字符串可以穿过 HTTP 边界。
3. **扩展加载失败从不抛错**，只落进 `LoadExtensionsResult.errors`。v1 不用扩展，所以暂时不吃这个亏；**一旦加工具，必须自己检查这个返回值**。
4. **实现层仍拼旧词**：`?profile=`、`profiles.json`、`state/<profile>/`、`lb.profile`。**改名与 API 重建一起做**（ADR 0011 的后果）。在这之前，读代码的人不该被误导。
5. **`node --test` 83 个前端用例必须保持绿**；后端 `unittest` 同理。

## 10. 明确推迟（不是遗漏，是排期）

跨对话检索 · 提炼出的个人事实（ChatGPT 式记忆）· 书内检索（**属于 Read 面的搜索，不是对话的工具**）· 离线与 PWA · `Highlight` 的字符区间（句级 → 区间是加法）· Person 集合是否可增删 · `Family` 上位概念 · 上游 `File structure` 的插件化。

## 11. 验收

- [ ] **宽屏**：三栏；左导航可收起；Chat 下挂会话记录、Read 下挂阅读记录；身份 chip 换整套
- [ ] **窄屏**：抽屉 + D3 全屏覆盖层 + 单栏 + 底部词卡；**先做窄屏原型再实现**
- [ ] **Read**：书架（分类 + 导入）；关掉重开回到上次那本书与位置；点词出词卡（读音/拼音 + 文中意思）；拖选出工具条
- [ ] **划线与想法**：马克笔标句、想法就地；**重新解析后重锚，且不丢记录**
- [ ] **Chat**：每人一个；新建 / 续聊 / 删除（硬删、先关 session）；按时间分组
- [ ] **D3**：AI问书引用原文 + 四个预设 prompt 可直接执行；词卡追问走同一条通道
- [ ] **边车挂了**：阅读器完全可用，只有 Chat 与 D3 降级
- [ ] **`ai_usage_limit`**：撞墙时给出「用量受限」与恢复时间，而不是通用上游错误
- [ ] **无回归**：粘贴 / 断句 / 历史 / 语速 / Loop / 错误文案；`node --test` 全绿

## 附：决议索引

**地图**：`#23`（本规格的来源；16 张子票全部关闭）

| 票 | 决议 |
|---|---|
| [#24](https://github.com/lanshengzhi/learn-buddy/issues/24) | DSH 与 pi 的能力、凭据与成本对照 |
| [#25](https://github.com/lanshengzhi/learn-buddy/issues/25) | 家庭局域网上的信任边界 —— **划出范围** |
| [#26](https://github.com/lanshengzhi/learn-buddy/issues/26) | 领域模型：Person / Conversation / Memory |
| [#27](https://github.com/lanshengzhi/learn-buddy/issues/27) | 侧栏壳的信息架构原型（赢家 D3 + C2） |
| [#28](https://github.com/lanshengzhi/learn-buddy/issues/28) | Work 面的范围 —— **划出范围** |
| [#29](https://github.com/lanshengzhi/learn-buddy/issues/29) | 承载栈与壳的归属 —— **引擎 = pi** |
| [#30](https://github.com/lanshengzhi/learn-buddy/issues/30) | 成本、配额与隐私模型 |
| [#31](https://github.com/lanshengzhi/learn-buddy/issues/31) | 额度墙的可观测性 |
| [#32](https://github.com/lanshengzhi/learn-buddy/issues/32) | pi 作为引擎的能力边界 |
| [#33](https://github.com/lanshengzhi/learn-buddy/issues/33) | 宿主语言与进程拓扑 |
| [#34](https://github.com/lanshengzhi/learn-buddy/issues/34) | Chat 面的范围 |
| [#35](https://github.com/lanshengzhi/learn-buddy/issues/35) | pi 的自定义扩展能否被加载 |
| [#36](https://github.com/lanshengzhi/learn-buddy/issues/36) | Chat 要不要只读工具 —— **不要** |
| [#37](https://github.com/lanshengzhi/learn-buddy/issues/37) | 划线与想法 |
| [#38](https://github.com/lanshengzhi/learn-buddy/issues/38) | v1 的设备与形态 |
| [#39](https://github.com/lanshengzhi/learn-buddy/issues/39) | Conversation 的删除与保留 |

**ADR**：`0003`（顶部横幅：无断点对新壳不再成立）· [`0011`](adr/0011-person-conversation-memory.md)（Person / Conversation / Memory）· [`0012`](adr/0012-python-host-node-sidecar.md)（Python 宿主 + Node 边车）· [`0013`](adr/0013-conversation-cost-and-privacy.md)（成本与隐私边界）

**词汇表**：`CONTEXT.md`

**原型（一次性分支）**：`prototype/shell-ia` —— `r3.html` 是赢家（默认 C2）；⚠️ 只覆盖宽屏

**研究（一次性分支）**：`research/dsh-vs-pi` · `research/pi-as-engine` · `research/pi-extensions`
