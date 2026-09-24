/**
 * `novel write` —— 单章生成。
 *
 * 这一条命令是整个工具的中心：把 Context Pack 交给模型，拿回初稿。
 * 默认只写进 runs/，要落盘得显式 --apply。
 */

import { loadConfig } from "../../config/index.js";
import { chapterNumber } from "../../domain/ids.js";
import type { RunRecord } from "../../generate/run.js";
import { generateChapter, type GenerateResult } from "../../generate/run.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export interface WriteOptions {
  readonly dryRun?: boolean | undefined;
  readonly openings?: number | undefined;
  readonly pick?: number | undefined;
  readonly words?: number | undefined;
  readonly apply?: boolean | undefined;
  readonly force?: boolean | undefined;
}

function fmt(value: number): string {
  return value.toLocaleString("en-US");
}

function bar(used: number, total: number, width = 12): string {
  if (total <= 0) return " ".repeat(width);
  const filled = Math.min(width, Math.round((used / total) * width));
  return "█".repeat(filled) + ui.dim("░".repeat(width - filled));
}

function printContext(record: RunRecord): string[] {
  const lines: string[] = [];
  const { context } = record;
  const pct = context.budgetTokens > 0
    ? Math.round((context.usedTokens / context.budgetTokens) * 100)
    : 0;

  lines.push(
    `${ui.heading("上下文")}  ${ui.bold(fmt(context.usedTokens))} ${ui.dim("/")} ${fmt(context.budgetTokens)} token` +
      `  ${ui.dim(`窗口 ${fmt(context.contextWindow)}，预留输出 ${fmt(context.reserveForOutput)}`)}` +
      `  ${bar(context.usedTokens, context.budgetTokens)} ${pct}%`,
  );
  lines.push("");

  const rows = context.layers.map((layer) => [
    layer.label,
    `${fmt(layer.usedTokens)} / ${fmt(layer.budgetTokens)}`,
    String(layer.itemCount),
    layer.droppedItems > 0 ? ui.yellow(`丢弃 ${layer.droppedItems}`) : ui.dim("—"),
  ]);

  lines.push(ui.renderTable(["层", "用量", "条目", "裁剪"], rows));
  return lines;
}

function printFindings(record: RunRecord): string[] {
  const lines: string[] = [];

  if (record.warnings.length > 0) {
    lines.push("");
    lines.push(ui.heading("告警"));
    for (const warning of record.warnings) {
      lines.push(ui.bullet(ui.yellow(warning)));
    }
  }

  if (record.draftCheck.length > 0) {
    lines.push("");
    lines.push(ui.heading("初稿体检"));
    for (const finding of record.draftCheck) {
      const mark =
        finding.level === "error" ? ui.red("✗") : finding.level === "warn" ? ui.yellow("!") : ui.cyan("·");
      lines.push(ui.bullet(`${mark} ${finding.message}`));
    }
  }

  return lines;
}

export async function runWrite(
  chapterId: string,
  options: WriteOptions,
  global: GlobalOptions,
): Promise<number> {
  const workspaceRoot = resolveWorkspaceRoot(global.dir);
  const config = await loadConfig(workspaceRoot);
  const booksRoot = booksRootOf(global);

  const quiet = global.json === true;
  const progress = quiet ? (): void => {} : (message: string): void => {
    process.stdout.write(`${ui.dim("·")} ${message}\n`);
  };

  const result: GenerateResult = await generateChapter({
    booksRoot,
    bookId: global.book,
    chapterId,
    config,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.openings !== undefined ? { openings: options.openings } : {}),
    ...(options.pick !== undefined ? { pick: options.pick } : {}),
    ...(options.words !== undefined ? { targetWords: options.words } : {}),
    ...(options.apply !== undefined ? { apply: options.apply } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
    onProgress: progress,
  });

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: result.runId,
          runDir: result.runDir,
          record: result.record,
          openings: result.openings,
          pickedOpening: result.pickedOpening ?? null,
          draft: result.draft ?? null,
          outputFile: result.outputFile ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${ui.bold(result.record.bookId)} · 第 ${chapterNumber(chapterId)} 章`,
  );
  lines.push("");
  lines.push(...printContext(result.record));
  lines.push(...printFindings(result.record));

  lines.push("");
  lines.push(ui.heading("产物"));

  if (result.record.dryRun) {
    lines.push(ui.bullet(`上下文  ${ui.dim(`${result.runDir}/context.json`)}`));
  } else {
    lines.push(ui.bullet(`提示词  ${ui.dim(`${result.runDir}/prompt.txt`)}`));
    if (result.openings.length > 0) {
      lines.push(
        ui.bullet(
          `开篇    ${ui.dim(`${result.runDir}/openings.md`)}  ${ui.dim(`（选中方案 ${result.record.openings.picked}）`)}`,
        ),
      );
    }
    lines.push(ui.bullet(`初稿    ${ui.dim(`${result.runDir}/draft.md`)}`));
  }
  lines.push(ui.bullet(`记录    ${ui.dim(`${result.runDir}/run.json`)}`));

  if (result.record.dryRun) {
    lines.push("");
    lines.push(
      ui.dim("这是 --dry-run：没有调用模型，也没有产生费用。去掉该参数即可真正生成。"),
    );
  } else if (result.outputFile !== undefined) {
    lines.push("");
    lines.push(`${ui.green("✓")} 已写入 ${ui.bold(result.outputFile)}`);
  } else {
    lines.push("");
    lines.push(
      `${ui.yellow("!")} 初稿尚未进入 ${ui.bold("chapters/")} —— 读过之后确认要采用，再运行：\n` +
        `  ${ui.cyan(`novel write ${chapterId} --apply`)}`,
    );
  }

  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
