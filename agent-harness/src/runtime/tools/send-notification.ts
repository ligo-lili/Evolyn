import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { harnessDataDir } from "../paths.js";

const parameters = Type.Object({
  channel: Type.String({ description: "Delivery channel, e.g. email or webhook" }),
  message: Type.String({ description: "Notification message body" }),
});

export type SendNotificationDetails = { channel: string; receiptId: string };

/**
 * Deliberately NON-idempotent: every execution delivers again and appends a new
 * line to .harness/notifications.log. `replay: "never"` tells the harness (once
 * checkpointing lands) that a crash mid-execution must NOT silently re-run this
 * tool — recovery synthesizes an error tool result instead. This is the demo
 * prop for the Crash Recovery demo.
 */
export const sendNotificationTool: AgentTool<typeof parameters, SendNotificationDetails> = {
  name: "send_notification",
  label: "Send Notification",
  description: "Send a one-way notification (email/webhook stub). Each call delivers exactly once more.",
  parameters,
  replay: "never",
  execute: async (_toolCallId, args) => {
    const receiptId = randomUUID();
    const dir = harnessDataDir(process.cwd());
    await mkdir(dir, { recursive: true });
    const line = `${new Date().toISOString()}\t${receiptId}\t${args.channel}\t${args.message}\n`;
    await appendFile(path.join(dir, "notifications.log"), line, "utf8");
    return {
      content: [{ type: "text", text: `notification delivered to ${args.channel} (receipt ${receiptId})` }],
      details: { channel: args.channel, receiptId },
    };
  },
};
