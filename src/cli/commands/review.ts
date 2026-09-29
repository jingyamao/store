import { loadConfig } from "../../config/index.js";
import { reviewChapter } from "../../review/index.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export async function runReview(chapter: string, ai: boolean, global: GlobalOptions): Promise<number> {
  const config = ai ? await loadConfig(resolveWorkspaceRoot(global.dir)) : undefined;
  const result = await reviewChapter({ booksRoot: booksRootOf(global), bookId: global.book, chapter, ai, config });
  if (global.json === true) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const lines = [`${ui.bold(chapter)} 章节体检`, `正文 ${result.metrics.words} 字 · ${result.metrics.paragraphs} 段 · 对白 ${Math.round(result.metrics.dialogueRatio * 100)}%`, ""];
    if (result.findings.length === 0) lines.push("未发现规则问题；主观质量仍需作者审阅。");
    for (const finding of result.findings) lines.push(`${finding.severity === "warning" ? ui.yellow("!") : ui.cyan("·")} [${finding.category}] ${finding.line === undefined ? "" : `第 ${finding.line} 行：`}${finding.message}`);
    process.stdout.write(lines.join("\n") + "\n");
  }
  return 0;
}
