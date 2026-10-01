import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const USAGE: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { ...ZERO_COST },
};

export const FAKE_MODEL: Model<"openai-completions"> = {
  id: "fake-model",
  name: "Fake Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost:9",
  reasoning: false,
  input: ["text"],
  cost: { ...ZERO_COST },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

export function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: StopReason,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: FAKE_MODEL.api,
    provider: FAKE_MODEL.provider,
    model: FAKE_MODEL.id,
    usage: { ...USAGE, cost: { ...ZERO_COST } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/** Scripted StreamFn: one AssistantMessage per model call, emitted as a realistic event sequence. */
export function scriptedStreamFn(steps: AssistantMessage[]): StreamFn {
  let call = 0;
  return (_model, _context, _options) => {
    const message = steps[call++];
    if (!message) throw new Error(`unexpected extra stream call #${call}`);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    message.content.forEach((block, contentIndex) => {
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
        stream.push({ type: "text_end", contentIndex, partial: message });
      } else if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
      }
    });
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    return stream;
  };
}

export interface TempCwd {
  readonly dir: string;
  enter(): void;
  leave(): void;
}

/**
 * Fresh temp dir + chdir so tool side effects and traces stay out of the repo.
 * 加固期 (P2): NESTED enter() calls reuse the current dir (depth-counted) —
 * previously each enter allocated a new temp dir whose `prev` clobbered the
 * outer one, leaking every dir whose owner never called leave (storage.test
 * entered once per test with a single afterAll leave).
 */
/**
 * Fresh temp dir + chdir so tool side effects and traces stay out of the repo.
 * Every enter() allocates a FRESH dir (tests stay isolated from each other);
 * leave() undoes its own enter. 加固期 (P2): every allocated dir is also
 * registered for a best-effort process-exit sweep, so unmatched enter/leave
 * pairs (storage.test enters per test with a single afterAll leave) no longer
 * leak temp directories.
 */
export function makeTempCwd(): TempCwd {
  interface Entry {
    prev: string;
    dir: string;
  }
  const stack: Entry[] = [];
  const allocated: string[] = [];
  let sweepRegistered = false;

  const rm = (target: string): void => {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 9) {
          console.warn(`[test cleanup] could not remove ${target}: ${err instanceof Error ? err.message : err}`);
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  };

  if (!sweepRegistered) {
    sweepRegistered = true;
    process.on("exit", () => {
      for (const dir of allocated) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort: open handles (AV/indexer/sqlite) can block removal
        }
      }
    });
  }

  return {
    get dir() {
      return stack.at(-1)?.dir ?? "";
    },
    enter() {
      const prev = process.cwd();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-harness-test-"));
      allocated.push(dir);
      stack.push({ prev, dir });
      process.chdir(dir);
    },
    leave() {
      const top = stack.pop();
      if (!top) return; // never entered — nothing to restore
      process.chdir(top.prev);
      rm(top.dir);
      const index = allocated.indexOf(top.dir);
      if (index !== -1) allocated.splice(index, 1);
    },
  };
}
