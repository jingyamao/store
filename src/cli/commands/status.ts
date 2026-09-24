/**
 * `novel status [book-id]` —— Bible 与进度的仪表盘。
 *
 * 刻意不重复 lint 的详细输出，只给一行汇总；要看细节就跑 `novel lint`。
 */

import { formatChapterId } from "../../domain/ids.js";
import { chapterNumber } from "../../domain/ids.js";
import { createLintContext, runLint, summarize } from "../../lint/index.js";
import { loadProgress } from "../../store/progress.js";
import { listBookIds } from "../../store/paths.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export interface StatusOptions {
  readonly bookId?: string | undefined;
  readonly all?: boolean | undefined;
  readonly skipLint?: boolean | undefined;
}

async function runAll(global: GlobalOptions): Promise<number> {
  const booksRoot = booksRootOf(global);
  const ids = await listBookIds(booksRoot);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ workspace: resolveWorkspaceRoot(global.dir), books: ids }, null, 2)}\n`);
    return 0;
  }

  if (ids.length === 0) {
    process.stdout.write(
      `${ui.yellow("!")} ${resolveWorkspaceRoot(global.dir)} 下还没有任何书籍。\n` +
        `  运行 ${ui.cyan("novel init <book-id>")} 创建一本。\n`,
    );
    return 0;
  }

  const rows: string[][] = [];
  for (const id of ids) {
    // 逐本装载只为统计规模，成本可接受（个人使用规模）
    const ctx = await createLintContext(booksRoot, id);
    const written = ctx.latestChapterNumber;
    const counts = summarize(runLint(ctx));
    rows.push([
      id,
      ctx.book.title,
      written === 0 ? "—" : formatChapterId(written),
      `${ctx.collections.characters.length} 人物`,
      `${ctx.collections.threads.length} 伏笔`,
      counts.error > 0 ? ui.red(`${counts.error} 错误`) : ui.green("干净"),
    ]);
  }

  process.stdout.write(
    `${ui.bold("书籍列表")} ${ui.dim(`(${ids.length})`)}\n\n` +
      `${ui.renderTable(["ID", "书名", "写至", "规模", "伏笔", "lint"], rows)}\n`,
  );
  return 0;
}

export async function runStatus(options: StatusOptions, global: GlobalOptions): Promise<number> {
  if (options.all === true) return runAll(global);

  const booksRoot = booksRootOf(global);
  const ctx = await createLintContext(booksRoot, options.bookId);
  const counts = options.skipLint === true ? undefined : summarize(runLint(ctx));

  const { book, collections, chapters } = ctx;
  const written = ctx.latestChapterNumber;
  const progress = await loadProgress(ctx.paths);
  const summaryCovered = progress.chapters.filter(
    (chapter) => chapter.hasText && chapter.hasSummary,
  ).length;

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          bookId: ctx.bookId,
          title: book.title,
          pov: book.pov,
          genres: book.genres,
          author: book.author,
          targetPlatform: book.targetPlatform,
          progress: {
            chaptersWritten: chapters.size,
            latestChapter: written === 0 ? null : formatChapterId(written),
            totalWords: progress.totalWords,
            summariesCovered: summaryCovered,
            missingSummaries: progress.missingSummaries,
          },
          bible: {
            characters: collections.characters.length,
            items: collections.items.length,
            locations: collections.locations.length,
            factions: collections.factions.length,
            threads: collections.threads.length,
            openThreads: collections.threads.filter(
              (thread) => thread.status === "open" || thread.status === "hinted",
            ).length,
            settings: collections.settings.length,
            realms: ctx.powerSystem.realms.length,
          },
          aiFlavorBlacklist: ctx.aiFlavorBlacklist.length,
          lint: counts ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines: string[] = [];

  /* 基本信息 */
  lines.push(`${ui.bold(book.title)} ${ui.dim(`(${ctx.bookId})`)}`);
  lines.push("");
  lines.push(ui.keyValue("视角", book.pov));
  if (book.author !== "") lines.push(ui.keyValue("作者", book.author));
  if (book.genres.length > 0) lines.push(ui.keyValue("题材", book.genres.join("、")));
  if (book.targetPlatform !== undefined) {
    lines.push(ui.keyValue("目标平台", book.targetPlatform));
  }
  if (book.logline !== "") lines.push(ui.keyValue("一句话", book.logline));

  /* 进度 */
  lines.push("");
  lines.push(ui.heading("进度"));
  if (written === 0) {
    lines.push(ui.bullet(ui.dim("尚未写出任何章节（chapters/ 为空）")));
  } else {
    lines.push(
      ui.bullet(
        `已写 ${ui.bold(String(chapters.size))} 章，` +
          `最新 ${formatChapterId(written)}` +
          `  ${ui.dim(`共 ${progress.totalWords.toLocaleString("en-US")} 字`)}`,
      ),
    );

    const missing = progress.missingSummaries.length;
    lines.push(
      ui.bullet(
        `摘要覆盖 ${summaryCovered}/${chapters.size} 章` +
          (missing > 0 ? ui.yellow(`  ← 缺 ${missing} 章`) : ""),
      ),
    );

    if (missing > 0) {
      lines.push(
        ui.bullet(
          ui.dim(
            "摘要是更早章节进入模型上下文的唯一途径，缺了它们长程记忆会断\n" +
              `    novel chapter summary new ${progress.missingSummaries[0]}`,
          ),
        ),
      );
    }
  }

  /* Bible 规模 */
  lines.push("");
  lines.push(ui.heading("Bible"));
  const openThreads = collections.threads.filter(
    (thread) => thread.status === "open" || thread.status === "hinted",
  ).length;

  lines.push(
    ui.renderTable(
      ["集合", "数量", "集合", "数量"],
      [
        [
          "人物",
          String(collections.characters.length),
          "物品",
          String(collections.items.length),
        ],
        [
          "地点",
          String(collections.locations.length),
          "势力",
          String(collections.factions.length),
        ],
        [
          "伏笔",
          `${collections.threads.length}${openThreads > 0 ? ui.dim(`（未回收 ${openThreads}）`) : ""}`,
          "设定",
          String(collections.settings.length),
        ],
        [
          "境界体系",
          ctx.powerSystem.realms.length === 0
            ? ui.dim("未定义")
            : `${ctx.powerSystem.realms.length} 个境界`,
          "AI味黑名单",
          ctx.aiFlavorBlacklist.length === 0
            ? ui.dim("未填写")
            : `${ctx.aiFlavorBlacklist.length} 条`,
        ],
      ],
    ),
  );

  /* 伏笔待办 */
  const backlog = collections.threads
    .filter(
      (thread) =>
        (thread.status === "open" || thread.status === "hinted") &&
        thread.plantedAt !== undefined,
    )
    .map((thread) => ({
      thread,
      age: written - chapterNumber(thread.plantedAt as string),
    }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 5);

  if (backlog.length > 0) {
    lines.push("");
    lines.push(ui.heading("伏笔待办") + ui.dim("  拖得最久的 5 条"));
    for (const { thread, age } of backlog) {
      const ageLabel = age >= 60 ? ui.red(`${age} 章未提`) : ui.dim(`${age} 章未提`);
      lines.push(
        ui.bullet(
          `${ui.dim(thread.plantedAt ?? "?")}  ${thread.title}  ${ageLabel}`,
        ),
      );
    }
  }

  /* lint 汇总 */
  if (counts !== undefined) {
    lines.push("");
    const parts = [
      counts.error > 0 ? ui.red(`错误 ${counts.error}`) : ui.dim("错误 0"),
      counts.warning > 0 ? ui.yellow(`警告 ${counts.warning}`) : ui.dim("警告 0"),
      counts.info > 0 ? ui.cyan(`提示 ${counts.info}`) : ui.dim("提示 0"),
    ];
    lines.push(`${ui.heading("lint")}  ${parts.join(ui.dim(" · "))}`);
    if (counts.error + counts.warning > 0) {
      lines.push(ui.bullet(ui.dim("运行 novel lint 查看详情")));
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
