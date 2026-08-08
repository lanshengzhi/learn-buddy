# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
你在解决 wayfinder 地图（lanshengzhi/learn-buddy issue #1）下的一张 research 票：GitHub issue #2「浏览器直连 Edge TTS 可行性验证」（https://github.com/lanshengzhi/learn-buddy/issues/2）。仓库在 /home/lansy/Work/LearnBuddy（gh 已认证，origin 为 github.com:lanshengzhi/learn-buddy）。

问题：浏览器能否不经自有后端，直接用 new WebSocket() 连 Edge TTS 端点（wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1）完成 TTS？浏览器 WebSocket 无法自定义握手头（Origin/User-Agent 由浏览器自动发），所以关键在于：握手所需令牌是否全部能放进 URL 查询串、且端点不依赖自定义头。

请按 research 技能执行：
1. 本地权威参照：读 /home/lansy/Work/dasan/android/app/src/main/java/com/example/languagereader/data/tts/EdgeTtsProtocol.kt（需要时也看同目录 TtsApi.kt），弄清 Android 版如何构造 wss URL 与握手。
2. 一手来源：edge-tts Python 库源码（github.com/rany2/edge-tts）、任何"浏览器直连 Edge TTS"的社区项目/文档；核对 TrustedClientToken、Sec-MS-GEC、Sec-MS-GEC-Version 的生成算法（含当前版本常量）与放查询串的可行性；端点是否校验 Origin/User-Agent 或反滥用/限流/区域限制。
3. 混合内容规则：明文 HTTP 页面（局域网 http://192.168.3.28 场景）发起 wss:// 是否被浏览器允许。
4. 兼容性：iOS Safari / Android Chrome 的 WebSocket 对该端点的已知问题。
5. 实证（若环境允许）：写一个最小脚本（检查本机 node/python3 是否可用；也可用 curl --http1.1 带 Upgrade 头模拟），用浏览器默认风格的握手（无自定义头、带 Origin）连一次真实端点，确认握手成功并收到音频帧；如实记录结果，失败也是结论的一部分。
6. 结论写入 research/edge-tts-browser.md（仓库内新建 research/ 目录；每条结论标注来源链接）。全部工作放在一次性分支 research/edge-tts-browser 上（先建分支，不 push、不开 PR、不合并）。
7. 用 gh issue comment 2 发布决议评论（结论：可行/有条件可行/不可行+条件；附文件路径与分支名；再附一条给架构票的关键提示），然后 gh issue close 2 关闭该票。

汇报：明确结论（含条件）、文件路径、分支名、架构票（issue #3）必须知道的要点。

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```