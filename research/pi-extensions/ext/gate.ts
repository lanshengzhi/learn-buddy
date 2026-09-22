/**
 * Fixture extension for ticket #35 — the `tool_call` gate.
 *
 * Two behaviours, both driven by the tool-call arguments so the mock provider
 * can trigger them deterministically:
 *
 *   word === "FORBIDDEN"      -> return { block: true, reason } ("deny")
 *   word startsWith "REWRITE:" -> mutate event.input.word in place ("rewrite")
 *   word === "REWRITE_INVALID" -> mutate word to a *number*, violating the
 *                                 tool's declared string schema (does pi
 *                                 re-validate mutated arguments?)
 *   anything else              -> return undefined ("allow")
 *
 * Uses the same dependency-free style as `learnbuddy-tools.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;

function note(line: string) {
  fs.mkdirSync(LAB, { recursive: true });
  fs.appendFileSync(path.join(LAB, "gate.log"), `${new Date().toISOString()} ${line}\n`);
}

export default function gate(pi: ExtensionAPI) {
  note("gate-factory-called");

  pi.on("tool_call", async (event, ctx) => {
    note(`tool_call name=${event.toolName} input=${JSON.stringify(event.input)} hasUI=${ctx?.hasUI} mode=${ctx?.mode}`);
    if (event.toolName !== "lb_word_lookup") return undefined;
    const raw = String((event.input as Record<string, unknown>).word ?? "");
    if (raw === "FORBIDDEN") {
      note("gate-decision=block");
      return { block: true, reason: "blocked by #35 gate fixture" };
    }
    if (raw.startsWith("REWRITE:")) {
      (event.input as Record<string, unknown>).word = raw.slice("REWRITE:".length);
      note(`gate-decision=rewrite->${(event.input as Record<string, unknown>).word}`);
    } else if (raw === "REWRITE_INVALID") {
      (event.input as Record<string, unknown>).word = 12345;
      note("gate-decision=rewrite-invalid (word := 12345, number)");
    } else {
      note("gate-decision=allow");
    }
    return undefined;
  });
}
