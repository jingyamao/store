/**
 * 章节进度统计。
 *
 * 把「细纲 / 正文 / 摘要」三份东西按章节对齐 —— 作者需要一个地方
 * 一眼看到哪里断了。
 *
 * 最要紧的一项是 `missingSummaries`：有正文却没摘要的章节，正是长程
 * 记忆的漏洞。写到第 30 章时，那些章节对模型等于不存在。
 */

import { chapterNumber, compareChapterId } from "../domain/ids.js";
import { isSummaryPlaceholder } from "../domain/summary.js";
import {
  listChapterIds,
  listSummaryIds,
  readChapterText,
  readSummary,
} from "./chapters.js";
import { countWords } from "../util/text.js";
import { listOutlinedChapters, readChapterOutline } from "./outlines.js";
import type { BookPaths } from "./paths.js";

export interface ChapterProgress {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly hasOutline: boolean;
  readonly hasText: boolean;
  /** 摘要在，且不是没填过的骨架。 */
  readonly hasSummary: boolean;
  /** 摘要文件在，但内容还是骨架。 */
  readonly summaryIsPlaceholder: boolean;
  readonly words: number;
  readonly targetWords: number | undefined;
}

export interface BookProgress {
  readonly chapters: readonly ChapterProgress[];
  /** 有正文但缺有效摘要的章节 —— 长程记忆的漏洞。 */
  readonly missingSummaries: readonly string[];
  /** 有正文但连细纲都没有的章节。 */
  readonly orphans: readonly string[];
  readonly totalWords: number;
  readonly writtenChapters: number;
  readonly outlinedChapters: number;
}

/** 章节号之外的排序键；非法 id 排到最后。 */
function sortKey(id: string): number {
  try {
    return chapterNumber(id);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function loadProgress(paths: BookPaths): Promise<BookProgress> {
  const [textIds, summaryIds, outlineIds] = await Promise.all([
    listChapterIds(paths),
    listSummaryIds(paths),
    listOutlinedChapters(paths),
  ]);

  const allIds = [...new Set([...textIds, ...outlineIds, ...summaryIds])].sort((a, b) => {
    const diff = sortKey(a) - sortKey(b);
    return diff !== 0 ? diff : compareChapterId(a, b);
  });

  const textSet = new Set(textIds);
  const summarySet = new Set(summaryIds);
  const outlineSet = new Set(outlineIds);

  const chapters: ChapterProgress[] = [];
  for (const id of allIds) {
    const outline = outlineSet.has(id) ? await readChapterOutline(paths, id) : undefined;
    const text = textSet.has(id) ? await readChapterText(paths, id) : undefined;

    let hasSummary = false;
    let summaryIsPlaceholder = false;
    if (summarySet.has(id)) {
      const summary = (await readSummary(paths, id)) ?? "";
      summaryIsPlaceholder = isSummaryPlaceholder(summary);
      hasSummary = !summaryIsPlaceholder;
    }

    chapters.push({
      id,
      number: sortKey(id),
      title: outline?.title ?? "",
      hasOutline: outlineSet.has(id),
      hasText: textSet.has(id),
      hasSummary,
      summaryIsPlaceholder,
      words: text === undefined ? 0 : countWords(text),
      targetWords: outline?.targetWords,
    });
  }

  const written = chapters.filter((chapter) => chapter.hasText);

  return {
    chapters,
    missingSummaries: written
      .filter((chapter) => !chapter.hasSummary)
      .map((chapter) => chapter.id),
    orphans: written
      .filter((chapter) => !chapter.hasOutline)
      .map((chapter) => chapter.id),
    totalWords: written.reduce((sum, chapter) => sum + chapter.words, 0),
    writtenChapters: written.length,
    outlinedChapters: chapters.filter((chapter) => chapter.hasOutline).length,
  };
}
