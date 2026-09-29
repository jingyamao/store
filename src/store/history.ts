/** 正文与章节细纲的不可变压缩历史。调用方在并发写入时持有章节锁。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { ChapterIdSchema } from "../domain/schemas.js";
import { atomicWrite, readTextFile } from "./file-io.js";
import type { BookPaths } from "./paths.js";

export type HistoryKind = "text" | "outline";
export type HistoryReason = "save" | "import" | "adopt" | "restore";

export interface Revision {
  readonly id: string;
  readonly at: string;
  readonly reason: HistoryReason | "current";
  readonly hash: string;
}

export interface DiffLine { readonly kind: "equal" | "add" | "remove"; readonly text: string }

export class HistoryConflictError extends Error {
  override readonly name = "HistoryConflictError";
}

const RevisionPattern = /^(\d{8}T\d{9}Z)-([0-9a-f]{12})-(save|import|adopt|restore)-([0-9a-f]{64})$/;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

function contentPath(paths: BookPaths, chapter: string, kind: HistoryKind): string {
  const id = ChapterIdSchema.parse(chapter);
  return kind === "text" ? join(paths.chaptersDir, `${id}.md`) : join(paths.chaptersOutlineDir, `${id}.yaml`);
}

function historyPath(paths: BookPaths, chapter: string, kind: HistoryKind): string {
  return join(paths.historyDir, ChapterIdSchema.parse(chapter), kind);
}

function parseRevision(id: string): Revision {
  const match = RevisionPattern.exec(id);
  if (match === null) throw new Error(`非法历史版本 ID：${id}`);
  const stamp = match[1] ?? "";
  const at = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
  if (Number.isNaN(Date.parse(at))) throw new Error(`非法历史版本时间：${id}`);
  return { id, at, reason: match[3] as HistoryReason, hash: match[4] ?? "" };
}

/** 在覆盖前保存旧内容；内容没有变化时不创建版本。 */
export async function writeVersionedContent(
  paths: BookPaths, chapter: string, kind: HistoryKind, next: string, reason: HistoryReason = "save",
): Promise<boolean> {
  const file = contentPath(paths, chapter, kind);
  const previous = existsSync(file) ? await readTextFile(file) : undefined;
  if (previous === next) return false;
  if (previous !== undefined) {
    const dir = historyPath(paths, chapter, kind);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    const id = `${stamp}-${randomUUID().replace(/-/g, "").slice(0, 12)}-${reason}-${hash(previous)}`;
    const target = join(dir, `${id}.gz`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, gzipSync(Buffer.from(previous, "utf8")), { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  await atomicWrite(file, next);
  return true;
}

export async function listRevisions(paths: BookPaths, chapter: string, kind: HistoryKind): Promise<Revision[]> {
  const file = contentPath(paths, chapter, kind);
  const versions: Revision[] = [];
  if (existsSync(file)) {
    const [content, info] = await Promise.all([readTextFile(file), stat(file)]);
    versions.push({ id: "current", at: info.mtime.toISOString(), reason: "current", hash: hash(content) });
  }
  const dir = historyPath(paths, chapter, kind);
  if (!existsSync(dir)) return versions;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".gz")) continue;
    const id = name.slice(0, -3);
    if (RevisionPattern.test(id)) versions.push(parseRevision(id));
  }
  const current = versions.find((entry) => entry.id === "current");
  const archived = versions.filter((entry) => entry.id !== "current").sort((a, b) => b.id.localeCompare(a.id));
  return current === undefined ? archived : [current, ...archived];
}

export async function readRevision(paths: BookPaths, chapter: string, kind: HistoryKind, id: string): Promise<string> {
  if (id === "current") {
    const file = contentPath(paths, chapter, kind);
    if (!existsSync(file)) throw new Error(`${chapter} 尚无当前${kind === "text" ? "正文" : "细纲"}`);
    return readTextFile(file);
  }
  const revision = parseRevision(id);
  const file = join(historyPath(paths, chapter, kind), `${id}.gz`);
  if (!existsSync(file)) throw new Error(`找不到历史版本：${id}`);
  let content: string;
  try { content = gunzipSync(await readFile(file)).toString("utf8"); }
  catch { throw new Error(`历史版本已损坏：${id}`); }
  if (hash(content) !== revision.hash) throw new Error(`历史版本内容校验失败：${id}`);
  return content;
}

/** 逐行差异；过长的改动区采用保守的整块展示，避免平方级内存。 */
export function diffLines(previous: string, current: string): DiffLine[] {
  const before = previous.split("\n");
  const after = current.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  const result: DiffLine[] = before.slice(0, prefix).map((text) => ({ kind: "equal", text }));
  if (oldMiddle.length * newMiddle.length > 250_000) {
    result.push(...oldMiddle.map((text) => ({ kind: "remove" as const, text })));
    result.push(...newMiddle.map((text) => ({ kind: "add" as const, text })));
  } else {
    const table = Array.from({ length: oldMiddle.length + 1 }, () => new Uint32Array(newMiddle.length + 1));
    for (let i = oldMiddle.length - 1; i >= 0; i -= 1) {
      for (let j = newMiddle.length - 1; j >= 0; j -= 1) {
        table[i]![j] = oldMiddle[i] === newMiddle[j] ? 1 + table[i + 1]![j + 1]! : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0; let j = 0;
    while (i < oldMiddle.length || j < newMiddle.length) {
      if (i < oldMiddle.length && j < newMiddle.length && oldMiddle[i] === newMiddle[j]) {
        result.push({ kind: "equal", text: oldMiddle[i]! }); i += 1; j += 1;
      } else if (j < newMiddle.length && (i === oldMiddle.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
        result.push({ kind: "add", text: newMiddle[j]! }); j += 1;
      } else {
        result.push({ kind: "remove", text: oldMiddle[i]! }); i += 1;
      }
    }
  }
  result.push(...before.slice(before.length - suffix).map((text) => ({ kind: "equal" as const, text })));
  return result;
}

export async function compareRevision(paths: BookPaths, chapter: string, kind: HistoryKind, id: string): Promise<{
  currentHash: string; revision: Revision; lines: DiffLine[];
}> {
  const [current, previous, versions] = await Promise.all([
    readRevision(paths, chapter, kind, "current"),
    readRevision(paths, chapter, kind, id),
    listRevisions(paths, chapter, kind),
  ]);
  const revision = versions.find((entry) => entry.id === id);
  if (revision === undefined) throw new Error(`找不到历史版本：${id}`);
  return { currentHash: hash(current), revision, lines: diffLines(previous, current) };
}

export async function restoreRevision(
  paths: BookPaths, chapter: string, kind: HistoryKind, id: string, expectedCurrentHash: string,
): Promise<{ hash: string; changed: boolean }> {
  if (id === "current") throw new Error("请选择旧版本进行恢复");
  const file = contentPath(paths, chapter, kind);
  const current = existsSync(file) ? await readTextFile(file) : "";
  if (hash(current) !== expectedCurrentHash) throw new HistoryConflictError("当前文件在预览后已变化，请重新查看版本历史");
  const previous = await readRevision(paths, chapter, kind, id);
  if (kind === "outline") {
    const parsed = ChapterOutlineSchema.parse(parseYaml(previous) as unknown);
    if (parsed.chapter !== chapter) throw new Error("历史细纲所属章节与目标不一致");
  }
  const changed = await writeVersionedContent(paths, chapter, kind, previous, "restore");
  return { hash: hash(previous), changed };
}
