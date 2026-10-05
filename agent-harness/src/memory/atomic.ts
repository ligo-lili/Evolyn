import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "../errors.js";

/**
 * 原子文件写：临时文件 + fsync + rename 替换。
 * memory 模块的唯一写盘原语——CORE.md 与记忆文件共用，保证写中途崩溃
 * 只会留下旧文件或完整新文件，绝无截断。单文件上限 512KB（§11）。
 *
 * 加固期修复：临时名固定为 `<file>.tmp` 时，两个进程并发写同一文件会互相
 * 踩踏——后开者截断前者的半成品、前者的 rename 把后者的内容落盘（还自以为
 * 成功）、后者的 rename 因 tmp 已被消费而 ENOENT。临时名加进程唯一后缀，
 * rename 原子性天然串行化并发写（后完成者胜出，恒为完整文件）。
 */

export const MAX_MEMORY_FILE_BYTES = 512 * 1024;

export function writeFileAtomic(file: string, data: string, maxBytes: number = MAX_MEMORY_FILE_BYTES): void {
  if (Buffer.byteLength(data, "utf8") > maxBytes) {
    throw new HarnessError(`memory file exceeds ${maxBytes} bytes: ${file}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, Buffer.from(data, "utf8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * 跨进程文件锁（加固期修复）：`wx` 独占创建 lockfile + 过期接管。
 *
 * 乐观锁的 read-check-write 三步在单进程内由 MutationGuard 串行化，但跨进程
 * （并发 run、run 进程 + CLI）没有任何原子性——两进程都读到 rev N、都通过
 * 校验、后写者静默覆盖前者。写入路径的临界区必须包进本锁：EEXIST 表示另
 * 一进程持锁，自旋等待；持锁进程崩溃留下的陈旧锁（> LOCK_STALE_MS）按过期
 * 接管，不让一次崩溃永久堵死写入。
 */

const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

/** 同步休眠（Atomics.wait 在 Node 主线程可用）——锁自旋用，不用定时器链。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock<T>(file: string, fn: () => T): T {
  const lockPath = `${file}.lock`;
  // Owner token: the release step only removes the lockfile when it STILL
  // holds our token — a stale-takeover successor's lock must never be deleted
  // by the process that (unknowingly) lost ownership. The old unconditional
  // rmSync let a holder that stalled past LOCK_STALE_MS cascade two successors
  // into the critical section (steal → original's finally deleted the
  // successor's lock → third process walks in).
  const token = `${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, token);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue; // 锁在 EEXIST 与 stat 之间被释放——立即重试
      }
      if (stale) {
        // 接管：删除陈旧锁后回到 wx 竞争。接管者与原持有者的隔离由上面的
        // 属主 token 保证——原持有者的释放步骤认不出自己的 token 时绝不动锁。
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // recontended — retry
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new HarnessError(
          `could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS}ms — another process holds it; ` +
            `delete the .lock file if that process is gone`,
        );
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.rmSync(lockPath, { force: true });
    } catch {
      // best-effort release; a leftover lock is reclaimed via the stale path
    }
  }
}
