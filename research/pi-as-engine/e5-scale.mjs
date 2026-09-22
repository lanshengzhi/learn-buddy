// E5 — how many sessions can one process carry, and is there a per-session cost?
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
const LAB = "/home/lansy/Work/LearnBuddy/.scratch/pi-lab";
const AGENT_DIR = `${LAB}/agentdir`;
const loader = new DefaultResourceLoader({ cwd: LAB, agentDir: AGENT_DIR, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => "t" });
await loader.reload();
const modelRuntime = await ModelRuntime.create({ authPath: `${AGENT_DIR}/auth.json`, modelsStorePath: `${AGENT_DIR}/models-store.json`, modelsPath: `${AGENT_DIR}/models.json` });
const model = modelRuntime.getModel("mock", "mock-model");
const N = Number(process.argv[2] ?? 20);
const rss0 = process.memoryUsage().rss;
const t0 = Date.now();
const sessions = [];
for (let i = 0; i < N; i += 1) {
  const { session } = await createAgentSession({ cwd: LAB, sessionManager: SessionManager.inMemory(LAB), modelRuntime, model, resourceLoader: loader, tools: ["read", "bash", "edit", "write"] });
  sessions.push(session);
}
const t1 = Date.now();
console.log(`created ${N} sessions in ${t1 - t0} ms; rss ${(rss0 / 1e6).toFixed(1)} -> ${(process.memoryUsage().rss / 1e6).toFixed(1)} MB`);
let deltas = 0;
for (const s of sessions) s.subscribe((e) => { if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") deltas += 1; });
const t2 = Date.now();
await Promise.all(sessions.map((s, i) => s.prompt(`q${i}`)));
const t3 = Date.now();
console.log(`all ${N} prompts done in ${t3 - t2} ms; total text_delta events=${deltas}`);
const ok = sessions.filter((s) => (s.agent.state.messages.at(-1)?.content ?? []).some((p) => p.type === "text")).length;
console.log(`sessions with an assistant answer: ${ok}/${N}`);
const st = sessions[0].getSessionStats?.();
console.log(`getSessionStats() -> ${JSON.stringify(st)}`);
console.log(`rss after: ${(process.memoryUsage().rss / 1e6).toFixed(1)} MB`);
sessions.forEach((s) => s.dispose());
process.exit(0);
