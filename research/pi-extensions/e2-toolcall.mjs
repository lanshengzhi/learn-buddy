// E2/E3/E4 — end-to-end round-trip against the local mock provider.
//
// Proves (or disproves) that a tool registered by an extension we wrote is
//   (a) advertised to the model in the request's `tools` array,
//   (b) actually executed by pi when the model calls it, and
//   (c) fed back to the model as a tool result — i.e. a real round-trip.
// Modes:
//   toolcall : happy path, expecting execute()
//   gate     : gate.ts blocks word=FORBIDDEN
//   rewrite  : gate.ts rewrites word=REWRITE:読む in place
//   rewrite-invalid : gate.ts rewrites word to a number, violating the schema
//   noext    : noExtensions:true but additionalExtensionPaths still set — shows
//              that additionalExtensionPaths survives noExtensions
//   none     : negative control — no extension paths at all, so the model calls
//              a tool that does not exist
//
// Usage: node e2-toolcall.mjs <mode>
// The mock provider is started (and stopped) by this script; it binds 127.0.0.1
// only and the API key in agentdir/models.json is a literal dummy.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DEFAULT_LAB = path.resolve(HERE, "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;
const AGENT_DIR = path.join(LAB, "agentdir");
const PORT = Number(process.env.MOCK_PORT || 8199);
const LOG = path.join(LAB, "requests.jsonl");
const MODE = process.argv[2] ?? "toolcall";

fs.mkdirSync(LAB, { recursive: true });

// ---------------------------------------------------------------- mock provider
async function startMock() {
  const child = spawn(process.execPath, [path.join(HERE, "mock-openai.mjs")], {
    env: { ...process.env, PI_EXT_LAB: LAB, MOCK_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stderr.write(`[mock] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[mock:err] ${d}`));
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("mock provider did not come up");
}

// ---------------------------------------------------------------- session
const EXT_FILES =
  MODE === "none" ? [] : ["learnbuddy-tools.ts", "gate.ts"].map((f) => path.join(HERE, "ext", f));
const loader = new DefaultResourceLoader({
  cwd: REPO,
  agentDir: AGENT_DIR,
  noExtensions: MODE === "noext" || MODE === "none",
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: EXT_FILES,
  systemPromptOverride: () => "You are a test harness.",
});
await loader.reload();
const extResult = loader.getExtensions();
console.log(`loaded extensions : ${extResult.extensions.length}, errors: ${JSON.stringify(extResult.errors)}`);

const modelRuntime = await ModelRuntime.create({
  authPath: path.join(AGENT_DIR, "auth.json"),
  modelsStorePath: path.join(AGENT_DIR, "models-store.json"),
  modelsPath: path.join(AGENT_DIR, "models.json"),
});
const model = modelRuntime.getModel("mock", "mock-model");

const { session } = await createAgentSession({
  cwd: REPO,
  sessionManager: SessionManager.inMemory(REPO),
  modelRuntime,
  model,
  resourceLoader: loader,
  noTools: "builtin", // only extension tools are live — the family-hub shape
});
console.log(`active tools      : ${JSON.stringify(session.getActiveToolNames())}`);
console.log(`noExtensions      : ${MODE === "noext" || MODE === "none"}`);

// ---------------------------------------------------------------- run
const events = [];
session.subscribe((event) => {
  if (event.type === "tool_execution_start") events.push(`tool_execution_start name=${event.toolName} args=${JSON.stringify(event.args ?? null)}`);
  else if (event.type === "tool_execution_end") events.push(`tool_execution_end name=${event.toolName} isError=${event.isError}`);
  else if (event.type === "turn_end") events.push("turn_end");
});

const PROMPTS = {
  toolcall: 'TOOLCALL:lb_word_lookup:{"word":"読む","language":"ja-JP"}',
  gate: 'TOOLCALL:lb_word_lookup:{"word":"FORBIDDEN"}',
  rewrite: 'TOOLCALL:lb_word_lookup:{"word":"REWRITE:読む"}',
  "rewrite-invalid": 'TOOLCALL:lb_word_lookup:{"word":"REWRITE_INVALID"}',
  noext: 'TOOLCALL:lb_word_lookup:{"word":"読む"}',
  none: 'TOOLCALL:lb_word_lookup:{"word":"読む"}',
};
const prompt = PROMPTS[MODE];
if (!prompt) throw new Error(`unknown mode ${MODE}`);

const before = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).length : 0;
const invocationsBefore = fs.existsSync(path.join(LAB, "tool-invocations.log"))
  ? fs.readFileSync(path.join(LAB, "tool-invocations.log"), "utf8").trim().split("\n").filter(Boolean).length
  : 0;

const mock = await startMock();
try {
  console.log(`\nprompt : ${prompt}`);
  await session.prompt(prompt);
} finally {
  mock.kill("SIGTERM");
}

// ---------------------------------------------------------------- evidence
console.log(`\nevents:\n  ${events.join("\n  ") || "(none)"}`);

const requests = fs
  .readFileSync(LOG, "utf8")
  .split("\n")
  .filter(Boolean)
  .slice(before)
  .map((l) => JSON.parse(l));
console.log(`\nprovider requests in this run: ${requests.length}`);
requests.forEach((r, i) => {
  console.log(`  #${i} roles=${r.roles.join("|")}`);
  console.log(`     advertisedTools=[${(r.advertisedTools ?? []).join(",")}]`);
  if (r.assistantToolCalls.length) console.log(`     assistantToolCalls=${JSON.stringify(r.assistantToolCalls)}`);
  if (r.toolResults.length) console.log(`     toolResults=${JSON.stringify(r.toolResults)}`);
});

const invocationLog = path.join(LAB, "tool-invocations.log");
if (fs.existsSync(invocationLog)) {
  const lines = fs.readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean);
  console.log(`\nexecute() invocations added: ${lines.length - invocationsBefore}`);
  lines.slice(invocationsBefore).forEach((l) => console.log(`  ${l}`));
} else {
  console.log("\nexecute() invocations: (no log file)");
}

const last = session.agent.state.messages.filter((m) => m.role === "assistant").at(-1);
console.log(`\nfinal assistant text: ${JSON.stringify((last?.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(""))}`);
