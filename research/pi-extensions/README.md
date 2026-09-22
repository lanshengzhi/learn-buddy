# pi 扩展实验（ticket #35）

产物文档：`research/pi-extensions.md`。这里是它的可复跑脚本与原始输出。

**全部实验都在本地完成：唯一的网络端点是本目录 `mock-openai.mjs` 起的 mock OpenAI 兼容服务（127.0.0.1:8199，apiKey 是字面量假值）。零真实 provider 调用、零真实凭据、不读写真实的 `~/.pi` 或任何部署态。**

## 跑起来

```bash
ln -sfn ../../ai-service/node_modules research/pi-extensions/node_modules
bash research/pi-extensions/run-all.sh
```

scratch lab 默认落在 `<repo>/.scratch/pi-ext-lab/`（gitignore，非部署状态），可用 `PI_EXT_LAB` 重定位，例如 `PI_EXT_LAB=/tmp/pi-ext-lab`。

> 环境备注：本仓库的 bash 工具跑在 `bwrap --tmpfs /tmp --unshare-pid` 里，**`/tmp` 每次调用都是空的**，所以默认没有用 `/tmp`。隔离意图不变。

## 文件

| 文件 | 作用 |
|---|---|
| `mock-openai.mjs` | 本地 OpenAI 兼容 mock（SSE）。由最后一条 user 消息驱动：`TOOLCALL:<name>:<json>` 触发一次工具调用，之后回文本。把每次请求的 `advertisedTools` / roles / tool results 记进 `requests.jsonl` |
| `agentdir-models.json` | 把 mock 注册成 provider `mock` 的模型目录 |
| `ext/learnbuddy-tools.ts` | 只读工具 fixture（`lb_word_lookup` / `lb_reading_position`），零运行时依赖（手写 JSON Schema） |
| `ext/gate.ts` | `tool_call` 闸门 fixture：放行 / 阻止 / 就地改写 / 改写成非法类型 |
| `ext/typebox-tool.ts` | 运行时 `import { Type } from "typebox"` 的 fixture（`tb_echo`） |
| `fixtures/runtime-import.ts` | 运行时 import 包根（`defineTool`）的 fixture |
| `fixtures/needs-missing-dep.ts` | import 一个哪都不存在的包（失败模式） |
| `e1-load.mjs` | 加载 + `noTools` 矩阵 + 模块解析 + 失败模式（`notools=auto\|all\|builtin\|allow`） |
| `e2-toolcall.mjs` | 端到端工具往返 + 闸门（自带 mock 的启停，模式见脚本头注释） |
| `e3-discovery.mjs` | 发现位置 / 路径形态 / 内联工厂（case 名见脚本头注释） |
| `e4-reload.mjs` | 改文件之后的缓存与重载行为 |
| `results/` | `run-all.sh` 的原始输出（文档里每条 [实测] 的出处） |
| `run-all.sh` | 一次跑完全部实验 |
