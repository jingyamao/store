/** Serialize Bible transactions across CLI processes and browser requests. */
import { existsSync } from "node:fs";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BookPaths } from "../store/paths.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function withNamedLock<T>(paths: BookPaths, filename: string, work: () => Promise<T>): Promise<T> {
  const file = join(paths.root, filename);
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      const handle = await open(file, "wx");
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A process may be between creating the lock and writing its owner.
      const age = await stat(file).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 5_000) {
        const owner: { pid?: number } = await readFile(file, "utf8").then((raw) => JSON.parse(raw) as { pid?: number }, () => ({}));
        if (typeof owner.pid !== "number" || !isAlive(owner.pid)) {
          await unlink(file).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) throw new Error(`书籍文件正被其他进程使用，请稍后重试；若进程已退出，请检查 ${filename}`);
      await sleep(50);
    }
  }
  try { return await work(); }
  finally { if (existsSync(file)) await unlink(file); }
}

export function withSyncLock<T>(paths: BookPaths, work: () => Promise<T>): Promise<T> {
  return withNamedLock(paths, ".sync.lock", work);
}

/** 序列化来自写作台和采用初稿的正文写入。 */
export function withChapterLock<T>(paths: BookPaths, work: () => Promise<T>): Promise<T> {
  return withNamedLock(paths, ".chapter.lock", work);
}
