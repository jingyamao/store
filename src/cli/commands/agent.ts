import { runWritingAgent } from "../../agent/run.js";
import { loadConfig } from "../../config/index.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export async function runAgentWrite(chapterId: string, options: { dryRun?: boolean; words?: number }, global: GlobalOptions): Promise<number> {
  const config = await loadConfig(resolveWorkspaceRoot(global.dir));
  const result = await runWritingAgent({
    booksRoot: booksRootOf(global), bookId: global.book, chapterId, config,
    dryRun: options.dryRun === true,
    ...(options.words === undefined ? {} : { targetWords: options.words }),
    onProgress: global.json === true ? undefined : (message) => process.stderr.write(`${ui.dim("·")} ${message}\n`),
  });
  if (global.json === true) {
    process.stdout.write(JSON.stringify({ runDir: result.runDir, record: result.record, draft: result.draft ?? null }, null, 2) + "\n");
    return 0;
  }
  const lines = [
    "",
    `${ui.bold(result.record.bookId)} · ${chapterId} · Agent`,
    `上下文 ${result.record.context.usedTokens.toLocaleString()} / ${result.record.context.budgetTokens.toLocaleString()} token`,
    `本次模型用量 ${((result.record.usage.promptTokens) + result.record.usage.completionTokens).toLocaleString()} token`,
    `运行记录 ${result.runDir}`,
  ];
  for (const warning of result.record.warnings) lines.push(`${ui.yellow("!")} ${warning}`);
  if (result.record.dryRun) lines.push("已保存记忆快照；未调用模型。查看 context.json 后去掉 --dry-run 生成初稿。");
  else {
    for (const finding of result.record.draftCheck) lines.push(`${finding.level === "error" ? ui.red("✗") : ui.yellow("!")} ${finding.message}`);
    lines.push(`初稿 ${result.runDir}/draft.md`);
    lines.push(`审阅后采用：novel adopt ${result.runDir.split(/[\\/]/).at(-1)}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
