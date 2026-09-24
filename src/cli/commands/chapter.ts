/**
 * `novel chapter` —— 正文与摘要。
 *
 * 这条命令存在的理由：正文进入系统的通道不该只有模型。
 * 「自己写小说用」意味着大量章节是手写的，或者 AI 出稿之后被改到面目全非。
 * 那些内容同样要能进 chapters/，同样要能被 lint 和生成读到。
 *
 * 摘要同理，而且更关键：`recent` 层只能全文覆盖最近 N 章，更早的章节
 * 只能靠摘要进入上下文。没有摘要，写到第 30 章时模型对第 5 章一无所知。
 */

import { scaffoldSummary } from "../../domain/summary.js";
import { chapterNumber } from "../../domain/ids.js";
import {
  chapterPath,
  parseChapterId,
  readChapterText,
  readSummary,
  summaryPath,
  writeChapterText,
  writeSummary,
} from "../../store/chapters.js";
import { readTextFile } from "../../store/file-io.js";
import { readChapterOutline } from "../../store/outlines.js";
import { resolveBook } from "../../store/paths.js";
import { loadProgress } from "../../store/progress.js";
import { countWords } from "../../util/text.js";
import { booksRootOf, CliError, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

const MARK = ui.green("✓");
const ABSENT = ui.dim("—");

/** 从文件读取，`-` 表示标准输入。刻意不把参数设成可选 —— 否则会静默卡住等输入。 */
async function readInput(file: string): Promise<string> {
  if (file === "-") {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) chunks.push(chunk as string);
    return chunks.join("");
  }
  try {
    return await readTextFile(file);
  } catch {
    throw new CliError(`读不到文件：${file}`);
  }
}

/* ── list ─────────────────────────────────────── */

export async function runChapterList(global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const progress = await loadProgress(resolved.paths);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(progress, null, 2)}\n`);
    return 0;
  }

  if (progress.chapters.length === 0) {
    process.stdout.write(
      `${ui.yellow("!")} 这本书还是空的。\n\n` +
        `  先写细纲：${ui.cyan("novel plan new ch-0001")}\n` +
        `  或直接建正文：${ui.cyan("novel chapter new ch-0001")}\n`,
    );
    return 0;
  }

  const rows = progress.chapters.map((chapter) => [
    chapter.id,
    chapter.title === "" ? ui.dim("（未拟）") : chapter.title,
    chapter.hasOutline ? MARK : ABSENT,
    chapter.hasText ? MARK : ABSENT,
    chapter.hasText ? fmt(chapter.words) : ABSENT,
    chapter.hasSummary ? MARK : chapter.summaryIsPlaceholder ? ui.yellow("空") : ABSENT,
  ]);

  const lines: string[] = [];
  lines.push(
    `${ui.bold("章节进度")} ${ui.dim(`(${progress.chapters.length})`)}\n\n` +
      ui.renderTable(["章节", "标题", "细纲", "正文", "字数", "摘要"], rows),
  );

  lines.push("");
  lines.push(
    ui.dim(
      `合计 ${fmt(progress.totalWords)} 字 · 正文 ${progress.writtenChapters} 章 · ` +
        `细纲 ${progress.outlinedChapters} 章`,
    ),
  );

  lines.push(...hints(progress.missingSummaries, progress.orphans, progress.chapters));

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function hints(
  missingSummaries: readonly string[],
  orphans: readonly string[],
  chapters: readonly { id: string; summaryIsPlaceholder: boolean; hasText: boolean }[],
): string[] {
  const lines: string[] = [];

  const placeholders = chapters
    .filter((chapter) => chapter.hasText && chapter.summaryIsPlaceholder)
    .map((chapter) => chapter.id);

  if (missingSummaries.length > 0) {
    lines.push("");
    lines.push(
      `${ui.yellow("!")} ${missingSummaries.length} 章有正文但没有摘要 —— ` +
        `摘要是更早章节进入模型上下文的唯一途径\n` +
        `  ${ui.cyan(`novel chapter summary new ${missingSummaries[0]}`)}`,
    );
    if (placeholders.length > 0) {
      lines.push(
        ui.dim(`  （其中 ${placeholders.length} 章建了摘要骨架但还没填内容）`),
      );
    }
  }

  if (orphans.length > 0) {
    lines.push("");
    lines.push(
      ui.dim(
        `${orphans.length} 章有正文但没有细纲：${orphans.slice(0, 5).join("、")}` +
          `${orphans.length > 5 ? " …" : ""}\n` +
          `  不影响 lint 与生成，但补上细纲能让上下文更准`,
      ),
    );
  }

  return lines;
}

/* ── new / show ───────────────────────────────── */

export interface ChapterNewOptions {
  readonly force?: boolean | undefined;
}

export async function runChapterNew(
  chapterId: string,
  options: ChapterNewOptions,
  global: GlobalOptions,
): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  parseChapterId(chapterId);

  const existing = await readChapterText(resolved.paths, chapterId);
  if (existing !== undefined && existing.trim() !== "" && options.force !== true) {
    throw new CliError(
      [
        `${chapterId} 的正文已存在：${chapterPath(resolved.paths, chapterId)}`,
        "",
        "直接编辑它，或加 --force 用空模板覆盖（会丢掉现有内容）。",
      ].join("\n"),
    );
  }

  const outline = await readChapterOutline(resolved.paths, chapterId);
  const heading = outline?.title
    ? `# 第 ${chapterNumber(chapterId)} 章 ${outline.title}`
    : `# 第 ${chapterNumber(chapterId)} 章`;
  const text = `${heading}\n\n`;

  await writeChapterText(resolved.paths, chapterId, text);

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify({ chapterId, path: chapterPath(resolved.paths, chapterId) }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已创建正文 ${ui.bold(chapterId)} → ${ui.dim(chapterPath(resolved.paths, chapterId))}\n\n` +
      `写完之后：\n` +
      ui.bullet(`补摘要 ${ui.cyan(`novel chapter summary new ${chapterId}`)}\n`) +
      ui.bullet(`体检   ${ui.cyan("novel lint")}\n`),
  );
  return 0;
}

export async function runChapterShow(chapterId: string, global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const text = await readChapterText(resolved.paths, chapterId);

  if (text === undefined) {
    throw new CliError(
      `第 ${chapterId} 章还没有正文。\n\n` +
        `  自己写：${`novel chapter new ${chapterId}`}\n` +
        `  让 AI 写：${`novel write ${chapterId}`}`,
    );
  }

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        { chapterId, words: countWords(text), path: chapterPath(resolved.paths, chapterId) },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${ui.bold(chapterId)}  ${ui.dim(`${fmt(countWords(text))} 字 · ${chapterPath(resolved.paths, chapterId)}`)}\n\n` +
      `${text.trimEnd()}\n`,
  );
  return 0;
}

/* ── import ───────────────────────────────────── */

export interface ChapterImportOptions {
  readonly force?: boolean | undefined;
}

export async function runChapterImport(
  chapterId: string,
  file: string,
  options: ChapterImportOptions,
  global: GlobalOptions,
): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  parseChapterId(chapterId);

  const incoming = (await readInput(file)).trim();
  if (incoming === "") {
    throw new CliError(`${file === "-" ? "标准输入" : file} 是空的，没有可导入的内容。`);
  }

  const existing = await readChapterText(resolved.paths, chapterId);
  if (
    existing !== undefined &&
    existing.trim() !== "" &&
    options.force !== true
  ) {
    throw new CliError(
      [
        `${chapterId} 已经有正文了，拒绝覆盖。`,
        "",
        `当前 ${fmt(countWords(existing))} 字，新内容 ${fmt(countWords(incoming))} 字。`,
        "确认要替换就加 --force。",
      ].join("\n"),
    );
  }

  await writeChapterText(resolved.paths, chapterId, `${incoming}\n`);

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        { chapterId, words: countWords(incoming), path: chapterPath(resolved.paths, chapterId) },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已导入正文 ${ui.bold(chapterId)}  ${fmt(countWords(incoming))} 字\n` +
      `  ${ui.dim(chapterPath(resolved.paths, chapterId))}\n`,
  );
  return 0;
}

/* ── summary ──────────────────────────────────── */

async function requireText(
  paths: Awaited<ReturnType<typeof resolveBook>>["paths"],
  chapterId: string,
): Promise<void> {
  const text = await readChapterText(paths, chapterId);
  if (text === undefined || text.trim() === "") {
    throw new CliError(
      [
        `第 ${chapterId} 章还没有正文，先写正文再写摘要。`,
        "",
        "摘要要写的是「这一章实际发生了什么」，凭空写没有意义。",
      ].join("\n"),
    );
  }
}

export async function runSummaryShow(chapterId: string, global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const summary = await readSummary(resolved.paths, chapterId);

  if (summary === undefined || summary.trim() === "") {
    throw new CliError(
      [
        `第 ${chapterId} 章还没有摘要。`,
        "",
        `  建骨架：novel chapter summary new ${chapterId}`,
        `  直接写：novel chapter summary set ${chapterId} <文件>`,
      ].join("\n"),
    );
  }

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ chapterId, summary }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${ui.bold(chapterId)} 摘要  ${ui.dim(summaryPath(resolved.paths, chapterId))}\n\n` +
      `${summary.trimEnd()}\n`,
  );
  return 0;
}

export interface SummaryNewOptions {
  readonly force?: boolean | undefined;
}

export async function runSummaryNew(
  chapterId: string,
  options: SummaryNewOptions,
  global: GlobalOptions,
): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  await requireText(resolved.paths, chapterId);

  const existing = await readSummary(resolved.paths, chapterId);
  if (existing !== undefined && existing.trim() !== "" && options.force !== true) {
    throw new CliError(
      [
        `${chapterId} 的摘要已存在：${summaryPath(resolved.paths, chapterId)}`,
        "",
        "直接编辑它，或加 --force 重新生成骨架。",
      ].join("\n"),
    );
  }

  const outline = await readChapterOutline(resolved.paths, chapterId);
  const text = scaffoldSummary(outline?.title ?? "");

  await writeSummary(resolved.paths, chapterId, text);

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify({ chapterId, path: summaryPath(resolved.paths, chapterId) }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已创建摘要骨架 ${ui.bold(chapterId)} → ${ui.dim(summaryPath(resolved.paths, chapterId))}\n\n` +
      "四个问题各写一两行就够了 —— 摘要不需要文采，只需要准确：\n" +
      ui.bullet(`情节       ${ui.dim("发生了什么（这是模型唯一能读到的版本）")}\n`) +
      ui.bullet(`状态变化   ${ui.dim("谁到了哪、伤成什么样、手里拿着什么")}\n`) +
      ui.bullet(`伏笔       ${ui.dim("这一章埋了什么、收了什么")}\n`) +
      ui.bullet(`遗留       ${ui.dim("下一章开头要接住什么")}\n`),
  );
  return 0;
}

export async function runSummarySet(
  chapterId: string,
  file: string,
  global: GlobalOptions,
): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);

  const incoming = (await readInput(file)).trim();
  if (incoming === "") {
    throw new CliError(`${file === "-" ? "标准输入" : file} 是空的，没有可写入的内容。`);
  }

  await writeSummary(resolved.paths, chapterId, `${incoming}\n`);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ chapterId, summary: incoming }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已写入摘要 ${ui.bold(chapterId)} → ${ui.dim(summaryPath(resolved.paths, chapterId))}\n`,
  );
  return 0;
}
