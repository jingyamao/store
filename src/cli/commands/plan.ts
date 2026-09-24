/**
 * `novel plan` —— 章节细纲。
 *
 * 细纲是人机协作的第一个决策点：作者定「本章要发生什么」，AI 负责
 * 「怎么写」。所以这一组命令的目标是「让写细纲的成本足够低」——
 * new 给出带说明的骨架，set 一次只改一个字段。
 */

import {
  ChapterOutlineSchema,
  scaffoldChapterOutline,
  type ChapterOutline,
} from "../../domain/outline.js";
import {
  chapterOutlinePath,
  listOutlinedChapters,
  readChapterOutline,
  writeChapterOutline,
} from "../../store/outlines.js";
import { dumpYaml } from "../../store/file-io.js";
import { resolveBook } from "../../store/paths.js";
import { getByPath, setByPath } from "../../util/dotted-path.js";
import { booksRootOf, CliError, type GlobalOptions } from "../context.js";
import { describeIssue, expectsArrayIssue, parseValueForSchema } from "../value-parsing.js";
import * as ui from "../ui.js";

async function requireOutline(
  chapterId: string,
  global: GlobalOptions,
): Promise<{ outline: ChapterOutline; paths: Awaited<ReturnType<typeof resolveBook>>["paths"] }> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const outline = await readChapterOutline(resolved.paths, chapterId);
  if (outline === undefined) {
    throw new CliError(
      `第 ${chapterId} 章还没有细纲。\n\n先运行：novel plan new ${chapterId}`,
    );
  }
  return { outline, paths: resolved.paths };
}

/* ── list ─────────────────────────────────────── */

export async function runPlanList(global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const chapters = await listOutlinedChapters(resolved.paths);

  if (global.json === true) {
    const outlines: ChapterOutline[] = [];
    for (const id of chapters) {
      const outline = await readChapterOutline(resolved.paths, id);
      if (outline !== undefined) outlines.push(outline);
    }
    process.stdout.write(`${JSON.stringify(outlines, null, 2)}\n`);
    return 0;
  }

  if (chapters.length === 0) {
    process.stdout.write(
      `${ui.yellow("!")} 还没有任何章节细纲。\n` +
        `  运行 ${ui.cyan("novel plan new ch-0001")} 开始写第一章。\n`,
    );
    return 0;
  }

  const rows: string[][] = [];
  for (const id of chapters) {
    const outline = await readChapterOutline(resolved.paths, id);
    if (outline === undefined) continue;
    rows.push([
      id,
      outline.title === "" ? ui.dim("（未拟）") : outline.title,
      outline.cast.length === 0 ? ui.dim("—") : String(outline.cast.length),
      outline.plantThreads.length + outline.advanceThreads.length === 0
        ? ui.dim("—")
        : String(outline.plantThreads.length + outline.advanceThreads.length),
      outline.intent === "" ? ui.dim("（未填意图）") : truncate(outline.intent, 28),
    ]);
  }

  process.stdout.write(
    `${ui.bold("章节细纲")} ${ui.dim(`(${chapters.length})`)}\n\n` +
      `${ui.renderTable(["章节", "标题", "人物", "伏笔", "意图"], rows)}\n`,
  );
  return 0;
}

function truncate(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, width).join("")}…`;
}

/* ── show ─────────────────────────────────────── */

export async function runPlanShow(chapterId: string, global: GlobalOptions): Promise<number> {
  const { outline, paths } = await requireOutline(chapterId, global);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(outline, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${ui.bold(outline.chapter)}` +
      `${outline.title === "" ? "" : `  ${outline.title}`}\n` +
      `${ui.dim(chapterOutlinePath(paths, chapterId))}\n\n` +
      `${dumpYaml(outline)}\n`,
  );
  return 0;
}

/* ── new ──────────────────────────────────────── */

export interface PlanNewOptions {
  readonly title?: string | undefined;
  readonly force?: boolean | undefined;
}

export async function runPlanNew(
  chapterId: string,
  options: PlanNewOptions,
  global: GlobalOptions,
): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);

  const existing = await readChapterOutline(resolved.paths, chapterId);
  if (existing !== undefined && options.force !== true) {
    throw new CliError(
      [
        `${chapterId} 的细纲已存在：${chapterOutlinePath(resolved.paths, chapterId)}`,
        "",
        "直接编辑它，或加 --force 重新生成骨架（会丢掉当前内容）。",
      ].join("\n"),
    );
  }

  // 章节 id 的格式校验在 schema 里，构造骨架时就会挡住 ch-1 这种写法
  const outline = scaffoldChapterOutline(chapterId, options.title ?? "");
  await writeChapterOutline(resolved.paths, outline);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(outline, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已创建细纲 ${ui.bold(chapterId)} → ${ui.dim(chapterOutlinePath(resolved.paths, chapterId))}\n\n` +
      "接下来填这几项（先填 cast 与 intent，收益最大）：\n" +
      ui.bullet(`cast           ${ui.dim(`出场人物 id，如 '["char_linyuan"]'`)}\n`) +
      ui.bullet(`intent         ${ui.dim("本章要达成什么")}\n`) +
      ui.bullet(`conflict       ${ui.dim("谁想要什么，什么在阻挡")}\n`) +
      ui.bullet(`mustInclude    ${ui.dim("必须写到的要点")}\n`) +
      ui.bullet(`forbidden      ${ui.dim("禁止出现的内容（防止提前泄底）")}\n`) +
      "\n" +
      `例如：${ui.cyan(`novel plan set ${chapterId} cast '["char_linyuan"]'`)}\n`,
  );
  return 0;
}

/* ── set ──────────────────────────────────────── */

export async function runPlanSet(
  chapterId: string,
  path: string,
  rawValue: string,
  global: GlobalOptions,
): Promise<number> {
  const { outline, paths } = await requireOutline(chapterId, global);

  const parsed = parseValueForSchema<ChapterOutline>(rawValue, (value) => {
    const candidate = structuredClone(outline) as unknown as Record<string, unknown>;
    try {
      setByPath(candidate, path, value);
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
        expectingArray: false,
      };
    }

    const result = ChapterOutlineSchema.safeParse(candidate);
    if (result.success) return { ok: true as const, value: result.data };

    const issue = result.error.issues[0];
    return {
      ok: false as const,
      message: `设置 ${path} 失败：${describeIssue(issue)}`,
      expectingArray: expectsArrayIssue(issue),
    };
  });

  // zod 会剥掉未知字段，所以拼错字段名时 safeParse 依然会通过。
  // 必须在落盘前确认值确实写到了目标路径上，否则用户会以为改成功了。
  const written = getByPath(parsed.value, path);
  if (written === undefined) {
    throw new CliError(
      [
        `${path} 没有写入 —— 这个字段不存在，多半是名字拼错了。`,
        "",
        `可用字段见：novel plan show ${chapterId}`,
      ].join("\n"),
    );
  }

  await writeChapterOutline(paths, parsed.value);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(parsed.value, null, 2)}\n`);
    return 0;
  }

  const hint = parsed.usedListFallback ? ui.dim("  （按逗号列表解析）") : "";
  process.stdout.write(
    `${ui.green("✓")} ${chapterId} · ${ui.bold(path)}\n  ${JSON.stringify(written)}${hint}\n`,
  );
  return 0;
}
