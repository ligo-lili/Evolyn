import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { execTool } from "./exec.js";
import { sendNotificationTool } from "./send-notification.js";

/** AgentTool generics are per-tool, so the shared collection erases to `any`. */
export type AnyAgentTool = AgentTool<any, any>;

export const DEMO_TOOLS: AnyAgentTool[] = [readFileTool, writeFileTool, execTool, sendNotificationTool];
