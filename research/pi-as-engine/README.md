# `research/pi-as-engine/` — 可复跑脚本

`../pi-as-engine.md`（issue #32）里所有标 **[实测]** 的结论都由这些脚本产生。**全部打向本地 mock 的 OpenAI 兼容端点，不碰真实 provider、不使用真实凭据。**

## 运行

脚本里的路径常量指向运行时 scratch 目录 `<repo>/.scratch/pi-lab/`（未纳入版本控制）。复跑：

```bash
LAB=<repo>/.scratch/pi-lab
mkdir -p $LAB/agentdir $LAB/sessions
ln -sfn <repo>/ai-service/node_modules $LAB/node_modules   # 让 pi 包可解析
cp agentdir/models.json $LAB/agentdir/models.json
cp *.mjs $LAB/

cd $LAB
node mock-openai.mjs &            # 127.0.0.1:8199，把收到的请求记进 requests.jsonl
node e1-resume.mjs new && node e1-resume.mjs resume && node e1-resume.mjs list
node e2.mjs multi                 # 3 会话并发 + token 级 delta 交错
node e2.mjs samefile              # 同进程两个 session 指向同一会话文件
node e2.mjs doubles               # 同会话并发 prompt / steer
node e2.mjs tools                 # 工具端到端（mock 用 USE_TOOL 触发一次 write）
node e3.mjs make && (node e3.mjs writer A & node e3.mjs writer B & wait) && node e3.mjs inspect
node e4.mjs init && node e4.mjs stale-lock 60000 && node e4.mjs write T2   # 孤儿锁自愈
node e4.mjs async-lock-probe 5000 ; node e4.mjs async-lock-probe 31000     # 30 s 口径
node trace-lock.mjs               # 逐系统调用确认「锁住时写失败但不抛异常」
node e5-scale.mjs 20              # 20 会话并发 + getSessionStats()
node e6-restore-model.mjs         # 不传 model 的续聊
```

`e4.mjs` 用的 `proper-lockfile` 是 pi 自己依赖的那一份（路径写死为
`<repo>/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile/index.js`）。

## 注意

- 这些脚本会写 `$LAB` 下的会话文件与 `agentdir/settings.json`——都是 scratch，不要指向真实 agent dir。
- `e2.mjs tools` 会让 mock 请求模型调用 `write` 工具，落一个 `$LAB/out.txt`。
- `e4.mjs write` 的打分以 `SettingsManager.drainErrors()` 为准：pi 在锁竞争时**不抛异常**，只把
  `ELOCKED` 记成内部 diagnostic（`settings-manager.js:356-368`），所以「没报错」不等于写成功。
