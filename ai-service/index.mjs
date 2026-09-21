#!/usr/bin/env node
// learnbuddy-ai — AI context explanations for LearnBuddy's 查义 card (ADR 0008,
// decision in #15). A tiny HTTP service: POST /explain {word, sentence,
// language, explanationLocale} -> {text}. It wraps the pi SDK so the provider, model and auth are whatever
// the pi agent dir is configured with — LearnBuddy owns no keys or accounts.
//
// The Python backend (server/ai.py) proxies /ai here and owns the cache and
// degrade codes (ai_not_configured / ai_upstream_error / ai_timeout); this
// service only answers LLM calls. It listens on 127.0.0.1 only — the LAN
// never sees it.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const HOST = process.env.LEARNBUDDY_AI_HOST || "127.0.0.1";
const PORT = Number(process.env.LEARNBUDDY_AI_PORT || 8123);
const AGENT_DIR = process.env.LEARNBUDDY_AI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
// The Python proxy gives up after 20 s; this only caps a runaway LLM call so the
// socket never hangs forever. Failures surface as 502 -> ai_upstream_error.
const REQUEST_DEADLINE_MS = Number(process.env.LEARNBUDDY_AI_DEADLINE_MS || 60_000);

const SYSTEM_PROMPT = `你是 epub 语言学习阅读器的查义助手。用户给出目标词、它所在的句子、原文语言和解释语言。
解释目标词在这个句子里取哪个义项、是什么语法角色或活用形式。要求：
- 用请求的解释语言回答（默认是 zh-CN；zh-CN 用简体中文），1–3 句，60–120 字。
- 只讲语言事实：这个词在此句中的含义、词性、语法（活用还原、惯用型、固定搭配），必要时给读音（英文注音标，日文注假名）。
- 不做教学扩展、不给例句、不评价句子。
- 直接输出解释正文，不要标题、列表或寒暄。`;

async function main() {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: AGENT_DIR,
    // A headless one-shot explainer: no extensions, skills, prompts, themes or
    // context files. The prompt is the whole surface.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
  await loader.reload();

  // ModelRuntime has no agentDir option — auth and the cached model catalog
  // are explicit paths here, so the service never depends on $HOME.
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(AGENT_DIR, "auth.json"),
    modelsStorePath: path.join(AGENT_DIR, "models-store.json"),
  });
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    resourceLoader: loader,
    noTools: "all",
    thinkingLevel: "low",
  });
  const model = session.model;
  console.error(
    `[learnbuddy-ai] listening on ${HOST}:${PORT}, agent dir ${AGENT_DIR}, model ${
      model ? `${model.provider}/${model.id}` : "none"
    }`,
  );

  // Serialize LLM calls through one reused session; each run starts from a
  // clean slate (messages reset after every answer). Family traffic makes
  // queueing a non-issue, and it keeps OAuth refresh handling in one place.
  let tail = Promise.resolve();

  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, model: model ? `${model.provider}/${model.id}` : null });
      return;
    }
    if (request.method !== "POST" || request.url !== "/explain") {
      json(response, 404, { error: "not_found" });
      return;
    }
    readBody(request).then((body) => {
      if (!body) {
        json(response, 400, { error: "bad_request" });
        return;
      }
      const word = typeof body.word === "string" ? body.word.trim() : "";
      const sentence = typeof body.sentence === "string" ? body.sentence.trim() : "";
      const language = typeof body.language === "string" ? body.language.trim() : "";
      const explanationLocale = typeof body.explanationLocale === "string"
        ? body.explanationLocale.trim()
        : "zh-CN";
      if (!word || !language || !explanationLocale) {
        json(response, 400, { error: "bad_request" });
        return;
      }
      const prompt = `原文语言：${language}\n解释语言：${explanationLocale}\n句子：${sentence || "（无）"}\n目标词：${word}`;
      tail = tail.then(() =>
        explain(session, prompt).then(
          (text) => {
            console.error(`[learnbuddy-ai] ok lang=${language} explanation=${explanationLocale} word="${word}" ${text.length} chars`);
            json(response, 200, { text });
          },
          (error) => {
            console.error(`[learnbuddy-ai] failed lang=${language} explanation=${explanationLocale} word="${word}": ${error?.message ?? error}`);
            json(response, 502, { error: "upstream_error" });
          },
        ),
      );
    });
  });

  server.listen(PORT, HOST);
}

// One prompt -> one LLM answer, with a deadline; the session history is wiped
// before and after so consecutive requests never see each other.
async function explain(session, prompt) {
  session.agent.state.messages = [];
  const timer = setTimeout(() => {
    session.abort().catch(() => {});
  }, REQUEST_DEADLINE_MS);
  try {
    await session.prompt(prompt);
    const text = assistantText(session.agent.state.messages);
    if (!text) throw new Error("no usable assistant answer");
    return text;
  } finally {
    clearTimeout(timer);
    session.agent.state.messages = [];
  }
}

function assistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (message.stopReason && message.stopReason !== "stop" && message.stopReason !== "length") return null;
    const text = (message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32_768) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > 32_768) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

function json(response, status, payload) {
  if (response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

main().catch((error) => {
  console.error(`[learnbuddy-ai] fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
