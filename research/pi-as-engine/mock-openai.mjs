// Mock OpenAI-compatible endpoint for pi-lab experiments. Never talks to a real
// provider. Streams SSE and echoes back what it received so callers can verify
// exactly which message history pi sent.
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.MOCK_PORT || 8199);
const LOG = process.env.MOCK_LOG || "/home/lansy/Work/LearnBuddy/.scratch/pi-lab/requests.jsonl";
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 30); // between text deltas
const CHUNK = Number(process.env.MOCK_CHUNK || 4); // characters per delta

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  let toolNames = "";
  for (const m of messages) {
    for (const t of m.tool_calls ?? []) toolNames += `${t.function?.name},`;
  }
  const last = messages[messages.length - 1] ?? {};
  const lastText =
    typeof last.content === "string"
      ? last.content
      : Array.isArray(last.content)
        ? last.content.map((p) => p.text ?? "").join("")
        : "";
  fs.appendFileSync(
    LOG,
    JSON.stringify({
      t: Date.now(),
      pid: process.pid,
      model: body.model,
      stream: body.stream,
      roles,
      toolNames,
      lastText: String(lastText).slice(0, 200),
      messageCount: messages.length,
      hasTools: Array.isArray(body.tools) ? body.tools.map((t) => t.function?.name) : null,
      sessionHeader:
        req.headers.session_id ?? req.headers["x-session-id"] ?? req.headers["x-client-request-id"] ?? null,
    }) + "\n",
  );

  const id = `chatcmpl-mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Tool-call mode is triggered by the literal USE_TOOL in the user's message.
  if (String(lastText).includes("USE_TOOL")) {
    const toolCallId = "call_mock_1";
    const argJson = String(lastText).includes("USE_TOOL_BAD")
      ? '{"nope":'
      : '{"path":"/home/lansy/Work/LearnBuddy/.scratch/pi-lab/out.txt","content":"hello from mock"}';
    sse(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              { index: 0, id: toolCallId, type: "function", function: { name: "write", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    for (let i = 0; i < argJson.length; i += 8) {
      sse(res, {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: argJson.slice(i, i + 8) } }] },
            finish_reason: null,
          },
        ],
      });
      await sleep(DELAY_MS);
    }
    sse(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
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

  const text = `ACK pid=${process.pid} n=${messages.length} roles=${roles.join("|")} tools=[${toolNames}] reply-to="${String(lastText).slice(0, 40)}"`;
  for (let i = 0; i < text.length; i += CHUNK) {
    sse(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          delta: { role: i === 0 ? "assistant" : undefined, content: text.slice(i, i + CHUNK) },
          finish_reason: null,
        },
      ],
    });
    await sleep(DELAY_MS);
  }
  sse(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
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
