// Mock OpenAI-compatible endpoint for the #35 extension experiments.
// Never talks to a real provider (binds 127.0.0.1 only, "apiKey" is a literal
// dummy in agentdir/models.json). Everything is driven from the last user
// message so runs are deterministic:
//
//   TOOLCALL:<tool_name>:<json-args>   -> emit one tool call for <tool_name>
//   (anything else)                    -> echo an ACK describing what pi sent
//
// Every request is appended to requests.jsonl, including the *tool names* pi
// advertised in `body.tools` and the roles/tool-results of the message history
// — that is the evidence that a tool was (or was not) visible to the model.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.MOCK_PORT || 8199);
const DEFAULT_LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;
const LOG = process.env.MOCK_LOG || path.join(LAB, "requests.jsonl");
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 5);

fs.mkdirSync(path.dirname(LOG), { recursive: true });

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? "").join("");
  return "";
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404).end("nope");
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {}
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const roles = messages.map((m) => m.role);
  const toolNames = Array.isArray(body.tools) ? body.tools.map((t) => t.function?.name) : null;

  // Last *user* message drives the script (tool results are role "tool").
  let driver = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      driver = textOf(messages[i].content);
      break;
    }
  }
  const toolResults = messages
    .filter((m) => m.role === "tool")
    .map((m) => ({ id: m.tool_call_id, name: m.name ?? null, text: String(textOf(m.content)).slice(0, 300) }));
  const assistantToolCalls = messages
    .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
    .flatMap((m) => m.tool_calls.map((t) => ({ name: t.function?.name, args: t.function?.arguments })));

  fs.appendFileSync(
    LOG,
    JSON.stringify({
      t: Date.now(),
      pid: process.pid,
      model: body.model,
      stream: body.stream,
      roles,
      advertisedTools: toolNames,
      driver,
      assistantToolCalls,
      toolResults,
    }) + "\n",
  );

  const id = `chatcmpl-mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const m = /TOOLCALL:([A-Za-z0-9_]+):(\{.*\})/s.exec(driver);
  // Only call the tool once per user turn: after pi has sent back a tool
  // result, answer with plain text so the agent loop terminates.
  if (m && toolResults.length === 0) {
    const [, name, rawArgs] = m;
    // Emit the tool name first, then stream the arguments in small pieces so we
    // exercise the same incremental path a real provider would.
    sse(res, base({ role: "assistant", tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name, arguments: "" } }] }));
    for (let i = 0; i < rawArgs.length; i += 6) {
      sse(res, base({ tool_calls: [{ index: 0, function: { arguments: rawArgs.slice(i, i + 6) } }] }));
      await sleep(DELAY_MS);
    }
    sse(res, base({}, "tool_calls"));
    sse(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const text =
    `ACK n=${messages.length} roles=${roles.join("|")} tools=[${(toolNames ?? []).join(",")}]` +
    ` toolResults=[${toolResults.map((r) => `${r.name}=${r.text.replace(/\s+/g, " ")}`).join(" ; ")}]`;
  for (let i = 0; i < text.length; i += 8) {
    sse(res, base({ role: i === 0 ? "assistant" : undefined, content: text.slice(i, i + 8) }));
    await sleep(DELAY_MS);
  }
  sse(res, base({}, "stop"));
  sse(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [],
    usage: { prompt_tokens: 21, completion_tokens: 13, total_tokens: 34 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-openai] listening on 127.0.0.1:${PORT}, log ${LOG}`);
});
