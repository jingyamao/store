/**
 * 章节正文的读写。
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { chapterNumber, compareChapterId } from "../domain/ids.js";
import { readTextFile, writeTextFile } from "./file-io.js";
import type { BookPaths } from "./paths.js";

const CHAPTER_FILE_RE = /^(ch-\d{4,})\.md$/;

/** 列出 chapters/ 下所有已存在的章节 id，按章节序升序。 */
export async function listChapterIds(paths: BookPaths): Promise<string[]> {
  if (!existsSync(paths.chaptersDir)) return [];
  const entries = await readdir(paths.chaptersDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => CHAPTER_FILE_RE.exec(entry.name)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort(compareChapterId);
}

/** 载入全部章节正文：章节 id → 文本。 */
export async function loadChapters(paths: BookPaths): Promise<Map<string, string>> {
  const ids = await listChapterIds(paths);
  const chapters = new Map<string, string>();
  for (const id of ids) {
    chapters.set(id, await readTextFile(join(paths.chaptersDir, `${id}.md`)));
  }
  return chapters;
}

/** 已写到的最大章节号；没有任何章节时返回 0。 */
export function latestChapterNumber(chapters: ReadonlyMap<string, string>): number {
  let max = 0;
  for (const id of chapters.keys()) {
    try {
      max = Math.max(max, chapterNumber(id));
    } catch {
      // 文件名已由正则过滤，这里理论上不可达
    }
  }
  return max;
}

/* ── 写入 ─────────────────────────────────────── */

export function chapterPath(paths: BookPaths, chapterId: string): string {
  return join(paths.chaptersDir, `${chapterId}.md`);
}

export async function readChapterText(
  paths: BookPaths,
  chapterId: string,
): Promise<string | undefined> {
  const filePath = chapterPath(paths, chapterId);
  if (!existsSync(filePath)) return undefined;
  return readTextFile(filePath);
}

export async function writeChapterText(
  paths: BookPaths,
  chapterId: string,
  text: string,
): Promise<void> {
  const validated = parseChapterId(chapterId);
  await writeTextFile(chapterPath(paths, validated), text);
}

/** 校验章节 id 格式，返回规范化结果。 */
export function parseChapterId(chapterId: string): string {
  if (!CHAPTER_FILE_RE.test(`${chapterId}.md`)) {
    throw new Error(`非法章节 id: ${chapterId}（期望形如 ch-0001）`);
  }
  return chapterId;
}

/* ── 摘要 ─────────────────────────────────────── */

/**
 * 载入章节摘要：章节 id → 摘要文本。
 *
 * 摘要是长程记忆的载体。M2 只负责「有就读」，写入由 M4 的状态回写负责，
 * 所以这里对缺失目录完全宽容。
 */
export async function loadSummaries(paths: BookPaths): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  if (!existsSync(paths.summariesDir)) return summaries;

  const entries = await readdir(paths.summariesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const id = CHAPTER_FILE_RE.exec(entry.name)?.[1];
    if (id === undefined) continue;
    summaries.set(id, await readTextFile(join(paths.summariesDir, entry.name)));
  }

  return summaries;
}
