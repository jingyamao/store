/**
 * 章节细纲的读写。
 *
 * 路径：outline/chapters/<ch-0001>.yaml
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareChapterId } from "../domain/ids.js";
import {
  ChapterOutlineSchema,
  type ChapterOutline,
} from "../domain/outline.js";
import { readYamlValidated, validate, writeYamlFile } from "./file-io.js";
import type { BookPaths } from "./paths.js";

const OUTLINE_FILE_RE = /^(ch-\d{4,})\.yaml$/;

const OUTLINE_HEADER = [
  "本章细纲 —— 人机协作的第一个人为决策点。",
  "cast / locations / items 决定装配上下文时注入哪些卡；",
  "plantThreads / advanceThreads 决定注入哪些伏笔。",
  "mustInclude 是硬性要求，forbidden 用于防止提前泄底。",
].join("\n");

export function chapterOutlinePath(paths: BookPaths, chapterId: string): string {
  return join(paths.chaptersOutlineDir, `${chapterId}.yaml`);
}

export async function readChapterOutline(
  paths: BookPaths,
  chapterId: string,
): Promise<ChapterOutline | undefined> {
  const filePath = chapterOutlinePath(paths, chapterId);
  if (!existsSync(filePath)) return undefined;
  return readYamlValidated(filePath, ChapterOutlineSchema);
}

export async function writeChapterOutline(
  paths: BookPaths,
  outline: ChapterOutline,
): Promise<void> {
  const checked = validate(ChapterOutlineSchema, outline, `章节细纲 ${outline.chapter}`);
  await writeYamlFile(chapterOutlinePath(paths, checked.chapter), checked, OUTLINE_HEADER);
}

/** 列出所有已写细纲的章节，按章节序升序。 */
export async function listOutlinedChapters(paths: BookPaths): Promise<string[]> {
  if (!existsSync(paths.chaptersOutlineDir)) return [];
  const entries = await readdir(paths.chaptersOutlineDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => OUTLINE_FILE_RE.exec(entry.name)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort(compareChapterId);
}

export { scaffoldChapterOutline } from "../domain/outline.js";
