import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath } from "../paths.js";

const MAX_CHARS = 20_000;

const parameters = Type.Object({
  path: Type.String({ description: "File path relative to the workspace root" }),
  offset: Type.Optional(Type.Number({ description: "1-based line number to start reading from" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadFileDetails = { path: string; lines: number; truncated: boolean };

export const readFileTool: AgentTool<typeof parameters, ReadFileDetails> = {
  name: "read_file",
  label: "Read File",
  description:
    "Read a text file inside the workspace. Returns the file content with 1-based line numbers. Supports offset/limit for long files.",
  parameters,
  replay: "safe",
  execute: async (_toolCallId, args) => {
    const abs = resolveWorkspacePath(process.cwd(), args.path);
    const raw = await readFile(abs, "utf8");
    const allLines = raw.split(/\r?\n/);
    const start = Math.max(1, args.offset ?? 1);
    let lines = allLines.slice(start - 1, args.limit ? start - 1 + args.limit : undefined);
    let truncated = false;
    let text = lines.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join("\n");
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
      lines = text.split("\n");
    }
    return {
      content: [{ type: "text", text: text || "(empty file)" }],
      details: { path: args.path, lines: lines.length, truncated },
    };
  },
};
