// E2/E3/E4 — concurrency, streaming granularity, tools. All against the local mock.
// Usage: node e2.mjs <mode>
//   multi        : 3 independent sessions in ONE process, prompted simultaneously
//   samefile     : 2 sessions in ONE process opened from the SAME stored file
//   doubles      : two concurrent prompt() calls on the SAME session
//   tools        : tool-calling turn end-to-end (write tool)
//   nosession    : confirm in-memory sessions leave no file
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

const LAB = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab";
const AGENT_DIR = `${LAB}/agentdir`;
const SESSIONS = `${LAB}/sessions`;
const CWD = LAB;
fs.mkdirSync(SESSIONS, { recursive: true });

const stamp = () => new Date().toISOString().slice(11, 23);

async function makeRuntime() {
  const loader = new DefaultResourceLoader({
    cwd: CWD,
    agentDir: AGENT_DIR,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "You are a test harness.",
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: `${AGENT_DIR}/auth.json`,
    modelsStorePath: `${AGENT_DIR}/models-store.json`,
    modelsPath: `${AGENT_DIR}/models.json`,
  });
  return { loader, modelRuntime, model: modelRuntime.getModel("mock", "mock-model") };
}

async function makeSession(manager, tools = ["read", "bash", "edit", "write"]) {
  const { loader, modelRuntime, model } = await makeRuntime();
  const { session } = await createAgentSession({
    cwd: CWD,
    sessionManager: manager,
    modelRuntime,
    model,
    resourceLoader: loader,
    tools,
  });
  return session;
}

function trace(session, tag, log) {
  return session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      log.push({ tag, kind: "text_delta", at: Date.now(), delta: event.assistantMessageEvent.delta });
    } else if (event.type === "tool_execution_start") {
      log.push({ tag, kind: "tool_execution_start", at: Date.now(), name: event.toolName });
    } else if (event.type === "tool_execution_end") {
      log.push({ tag, kind: "tool_execution_end", at: Date.now(), name: event.toolName, isError: event.isError });
    } else if (event.type === "turn_end") {
      log.push({ tag, kind: "turn_end", at: Date.now() });
    } else if (event.type === "message_end") {
      log.push({ tag, kind: "message_end", at: Date.now(), role: event.message?.role });
    }
  });
}

const mode = process.argv[2] ?? "multi";

if (mode === "multi") {
  const log = [];
  const sessions = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await makeSession(SessionManager.create(CWD, SESSIONS));
    trace(s, `s${i}`, log);
    sessions.push(s);
  }
  console.log(`created ${sessions.length} sessions:`, sessions.map((s) => s.sessionId.slice(0, 8)).join(" "));
  const t0 = Date.now();
  await Promise.all(sessions.map((s, i) => s.prompt(`question from session ${i}`)));
  const t1 = Date.now();
  console.log(`all 3 prompts settled in ${t1 - t0} ms (single mock has ~30ms/delta)`);
  for (let i = 0; i < sessions.length; i += 1) {
    const last = sessions[i].agent.state.messages.at(-1);
    const text = (last.content ?? []).map((p) => p.text ?? "").join("");
    console.log(`  s${i} id=${sessions[i].sessionId.slice(0, 8)} msgs=${sessions[i].agent.state.messages.length} reply=${text.slice(0, 60)}`);
  }
  // interleaving: do deltas from different sessions interleave in wall-clock time?
  const starts = log.filter((e) => e.kind === "text_delta");
  console.log(`total text_delta events = ${starts.length}`);
  const perTag = {};
  for (const e of log) perTag[e.tag] = (perTag[e.tag] ?? 0) + 1;
  console.log("events per session:", JSON.stringify(perTag));
  const tagsInOrder = starts.map((e) => e.tag).join("");
  console.log(`first 60 interleaved delta tags: ${tagsInOrder.slice(0, 60)}`);
  const switched = starts.filter((e, i) => i > 0 && starts[i - 1].tag !== e.tag).length;
  console.log(`interleave switches = ${switched} (0 would mean strictly serialized)`);
  sessions.forEach((s) => s.dispose());
} else if (mode === "samefile") {
  const file = fs.readFileSync(`${LAB}/e1-session-path.txt`, "utf8").trim();
  const a = await makeSession(SessionManager.open(file));
  const b = await makeSession(SessionManager.open(file));
  console.log(`two sessions opened from the SAME file; ids a=${a.sessionId} b=${b.sessionId}`);
  const log = [];
  trace(a, "a", log);
  trace(b, "b", log);
  await Promise.allSettled([a.prompt("concurrent A"), b.prompt("concurrent B")]);
  console.log(`entries after: a=${SessionManager.open(file).getEntries().length}`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  console.log(`file lines=${lines.length}`);
  const ids = lines.map((l) => { try { return JSON.parse(l).id; } catch { return "PARSE_ERROR"; } }).filter(Boolean);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  console.log(`duplicate entry ids = ${dupes.length ? dupes.join(",") : "none"}`);
  const leaves = lines.map((l) => { try { const j = JSON.parse(l); return j.parentId ?? "ROOT"; } catch { return "X"; } });
  console.log(`parent chain tail: ${leaves.slice(-6).join(" -> ")}`);
  console.log(`last 3 entry types: ${lines.slice(-3).map((l) => { try { return JSON.parse(l).type; } catch { return "PARSE_ERROR"; } }).join(",")}`);
  a.dispose(); b.dispose();
} else if (mode === "doubles") {
  const s = await makeSession(SessionManager.inMemory(CWD));
  let err = "none";
  const p1 = s.prompt("first");
  try {
    await s.prompt("second while streaming");
    err = "NO ERROR (second prompt accepted)";
  } catch (e) {
    err = `${e.constructor.name}: ${String(e.message).split("\n")[0]}`;
  }
  await p1.catch(() => {});
  console.log(`concurrent prompt() on same session -> ${err}`);
  // steering during streaming
  const s2 = await makeSession(SessionManager.inMemory(CWD));
  const p = s2.prompt("long turn please");
  await new Promise((r) => setTimeout(r, 60));
  let steerErr = "none";
  try { await s2.steer("steer message"); } catch (e) { steerErr = String(e.message).split("\n")[0]; }
  await p.catch(() => {});
  console.log(`steer() during streaming -> ${steerErr}`);
  s.dispose(); s2.dispose();
} else if (mode === "tools") {
  const s = await makeSession(SessionManager.create(CWD, SESSIONS));
  const log = [];
  trace(s, "t", log);
  await s.prompt("USE_TOOL please write a file");
  console.log("tool events:", JSON.stringify(log.filter((e) => e.kind.startsWith("tool"))));
  const out = `${LAB}/out.txt`;
  console.log(`write tool produced ${out}: ${fs.existsSync(out) ? JSON.stringify(fs.readFileSync(out, "utf8")) : "MISSING"}`);
  console.log(`messages after tool turn = ${s.agent.state.messages.length}`);
  for (const m of s.agent.state.messages) {
    console.log(`   ${m.role}: ${JSON.stringify(m.content).slice(0, 110)}`);
  }
  console.log(`usage on last assistant: ${JSON.stringify(s.agent.state.messages.at(-1).usage ?? null)}`);
  s.dispose();
} else if (mode === "nosession") {
  const s = await makeSession(SessionManager.inMemory(CWD));
  await s.prompt("memory only");
  console.log(`inMemory sessionFile = ${s.sessionFile}`);
  s.dispose();
}
process.exit(0);
