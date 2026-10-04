import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";

/**
 * 原子文件写：临时文件 + fsync + rename 替换。
 * memory 模块的唯一写盘原语——CORE.md 与记忆文件共用，保证写中途崩溃
 * 只会留下旧文件或完整新文件，绝无截断。单文件上限 512KB（§11）。
 */

export const MAX_MEMORY_FILE_BYTES = 512 * 1024;

export function writeFileAtomic(file: string, data: string, maxBytes: number = MAX_MEMORY_FILE_BYTES): void {
  if (Buffer.byteLength(data, "utf8") > maxBytes) {
    throw new HarnessError(`memory file exceeds ${maxBytes} bytes: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, Buffer.from(data, "utf8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
