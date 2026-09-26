import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveWorkspacePath } from "../paths.js";

const parameters = Type.Object({
  path: Type.String({ description: "File path relative to the workspace root" }),
  content: Type.String({ description: "Full file content to write (overwrites)" }),
});

export type WriteFileDetails = { path: string; bytes: number };

export const writeFileTool: AgentTool<typeof parameters, WriteFileDetails> = {
  name: "write_file",
  label: "Write File",
  description: "Create or overwrite a text file inside the workspace with the given content.",
  parameters,
  replay: "safe",
  execute: async (_toolCallId, args) => {
    const abs = resolveWorkspacePath(process.cwd(), args.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, args.content, "utf8");
    return {
      content: [{ type: "text", text: `wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}` }],
      details: { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") },
    };
  },
};
