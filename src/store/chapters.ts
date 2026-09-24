/**
 * 章节正文的读取。
 *
 * M0/M1 只需要「读」—— 用于 lint 做「登记 vs 实际出现」的交叉校验。
 * 写入与生成在 M2 才需要。
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { chapterNumber, compareChapterId } from "../domain/ids.js";
import { readTextFile } from "./file-io.js";
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
