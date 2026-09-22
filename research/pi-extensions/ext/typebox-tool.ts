/**
 * Fixture extension for ticket #35 — the module-resolution variant.
 *
 * Difference from `learnbuddy-tools.ts`: this one imports a *runtime*
 * dependency (`typebox`, which pi declares but does not hoist to the top of
 * `ai-service/node_modules`) and uses `Type.Object` instead of a hand-written
 * JSON Schema. The runner copies this file into two places:
 *
 *   <lab>/ext-deps/typebox-tool.ts   (has node_modules -> resolves)
 *   <repo>/research/pi-extensions/ext/  (no node_modules up-tree -> ?)
 *
 * so the experiment shows exactly which import styles survive where.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;

export default function typeboxTool(pi: ExtensionAPI) {
  fs.mkdirSync(LAB, { recursive: true });
  fs.appendFileSync(path.join(LAB, "tool-invocations.log"), `typebox-factory-called\n`);

  pi.registerTool({
    name: "tb_echo",
    label: "TypeBox Echo",
    description: "Echo a message; demonstrates a TypeBox-declared parameter schema.",
    parameters: Type.Object({
      message: Type.String({ description: "Message to echo" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `tb_echo: ${params.message}` }],
        details: {},
      };
    },
  });
}
