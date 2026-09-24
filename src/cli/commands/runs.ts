/**
 * `novel runs` —— 生成历史。
 *
 * 每次生成都在 runs/ 下留一份完整记录。这个命令让它变得可浏览 ——
 * 「上次那版初稿去哪了」不该需要自己去翻目录。
 */

import { listRuns } from "../../generate/run.js";
import { resolveBook } from "../../store/paths.js";
import { booksRootOf, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export interface RunsOptions {
  readonly limit?: number | undefined;
}

export async function runRuns(options: RunsOptions, global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const all = await listRuns(resolved.paths);
  const limit = options.limit ?? 20;
  const runs = all.slice(0, limit);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    return 0;
  }

  if (runs.length === 0) {
    process.stdout.write(
      `${ui.yellow("!")} 还没有任何生成记录。\n` +
        `  先写一份细纲，再运行 ${ui.cyan("novel write ch-0001")}。\n`,
    );
    return 0;
  }

  const rows = runs.map((run) => [
    run.runId,
    run.chapterId,
    formatTime(run.startedAt),
    run.dryRun ? ui.dim("dry-run") : ui.cyan("已生成"),
    run.applied ? ui.green("已落盘") : ui.dim("未落盘"),
    run.usedTokens === 0 ? ui.dim("—") : run.usedTokens.toLocaleString("en-US"),
    run.problems > 0 ? ui.yellow(`${run.problems} 处`) : ui.dim("—"),
  ]);

  const header =
    `${ui.bold("生成记录")} ${ui.dim(`(${runs.length}${all.length > runs.length ? ` / ${all.length}` : ""})`)}`;
  const hint =
    all.length > runs.length ? `\n${ui.dim(`仅显示最近 ${limit} 条，用 --limit 调整`)}` : "";

  process.stdout.write(
    `${header}\n\n${ui.renderTable(["记录", "章节", "时间", "状态", "落盘", "上下文", "体检"], rows)}${hint}\n`,
  );
  return 0;
}

function formatTime(iso: string): string {
  if (iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
