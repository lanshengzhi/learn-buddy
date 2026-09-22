/**
 * Fixture extension for ticket #35 — "can a pi extension we wrote ourselves be
 * loaded from the published package, and can its tool actually be called?".
 *
 * Deliberately dependency-free: only a *type-only* import (erased by jiti) and
 * a hand-written JSON Schema for `parameters`, so the experiment measures the
 * loader, not module resolution. See `typebox-tool.ts` for the variant that
 * does import a runtime dependency.
 *
 * Side effect for evidence: every real `execute()` appends one line to
 * `${PI_EXT_LAB}/tool-invocations.log`, so "the tool ran" and "the tool was
 * blocked" are distinguishable from the outside.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".scratch", "pi-ext-lab");
const LAB = process.env.PI_EXT_LAB || DEFAULT_LAB;

const DICTIONARY: Record<string, string> = {
  読む: "よむ・他動詞五段 — to read",
  走: "zǒu・动词 — to walk, to go",
};

const WORD_PARAMS = {
  type: "object",
  properties: {
    word: { type: "string", description: "The headword to look up" },
    language: { type: "string", description: "BCP-47-ish language tag, e.g. ja-JP" },
  },
  required: ["word"],
  additionalProperties: false,
} as const;

const POSITION_PARAMS = {
  type: "object",
  properties: {
    bookId: { type: "string", description: "Library book id" },
  },
  required: ["bookId"],
  additionalProperties: false,
} as const;

function note(line: string) {
  fs.mkdirSync(LAB, { recursive: true });
  fs.appendFileSync(path.join(LAB, "tool-invocations.log"), `${new Date().toISOString()} ${line}\n`);
}

export default function learnBuddyTools(pi: ExtensionAPI) {
  note("extension-factory-called");

  pi.registerTool({
    name: "lb_word_lookup",
    label: "Word Lookup",
    description: "Look up a dictionary entry for a single word. Read-only.",
    promptSnippet: "Look up a dictionary entry for one word",
    parameters: WORD_PARAMS,
    async execute(_toolCallId, params) {
      note(`lb_word_lookup word=${params.word}`);
      const entry = DICTIONARY[params.word];
      return {
        content: [
          {
            type: "text",
            text: entry
              ? `${params.word}: ${entry}`
              : `${params.word}: (no entry)`,
          },
        ],
        details: { word: params.word, found: Boolean(entry) },
      };
    },
  });

  pi.registerTool({
    name: "lb_reading_position",
    label: "Reading Position",
    description: "Read the stored reading position for a book. Read-only.",
    parameters: POSITION_PARAMS,
    async execute(_toolCallId, params) {
      note(`lb_reading_position bookId=${params.bookId}`);
      return {
        content: [{ type: "text", text: `book ${params.bookId}: cfi=epubcfi(/6/14!/4/2/2[idx]) pct=12.5` }],
        details: { bookId: params.bookId },
      };
    },
  });
}
