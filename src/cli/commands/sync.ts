import { loadConfig } from "../../config/index.js";
import { createLintContext, runLint, summarize } from "../../lint/index.js";
import { resolveBook } from "../../store/paths.js";
import { applySync, proposeSync, readProposal, type SyncProposal } from "../../sync/index.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

function render(proposal: SyncProposal): string {
  const lines = [`${ui.bold(proposal.chapter)} 状态提案`, "", `摘要：\n${proposal.summary}`, ""];
  if (proposal.changes.length === 0) lines.push("没有提取到明确的状态变化。");
  for (const [index, change] of proposal.changes.entries()) {
    const applied = proposal.applied.includes(index + 1) ? " [已应用]" : "";
    lines.push(`${index + 1}. ${change.id} ${change.field}${applied}`);
    lines.push(`   ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
    lines.push(`   依据：${change.evidence}`);
  }
  lines.push("", `摘要：${proposal.summaryApplied ? "已应用" : "待确认"}`);
  return lines.join("\n") + "\n";
}

export async function runSyncPropose(chapter: string, force: boolean, global: GlobalOptions): Promise<number> {
  const config = await loadConfig(resolveWorkspaceRoot(global.dir));
  const proposal = await proposeSync({ booksRoot: booksRootOf(global), bookId: global.book, chapter, config, force });
  process.stdout.write(global.json === true ? `${JSON.stringify(proposal, null, 2)}\n` : render(proposal));
  return 0;
}

export async function runSyncShow(chapter: string, global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const proposal = await readProposal(resolved.paths, chapter);
  process.stdout.write(global.json === true ? `${JSON.stringify(proposal, null, 2)}\n` : render(proposal));
  return 0;
}

export async function runSyncApply(chapter: string, acceptText: string | undefined, summary: boolean, global: GlobalOptions): Promise<number> {
  const booksRoot = booksRootOf(global);
  const resolved = await resolveBook(booksRoot, global.book);
  const proposal = await readProposal(resolved.paths, chapter);
  const accept = acceptText === undefined || acceptText.trim() === ""
    ? []
    : acceptText.split(",").map((part) => Number(part.trim()));
  await applySync(resolved.paths, proposal, { accept, acceptSummary: summary });
  const findings = runLint(await createLintContext(booksRoot, resolved.id));
  const counts = summarize(findings);
  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ accepted: accept, summaryApplied: summary, lint: counts }, null, 2)}\n`);
  } else {
    process.stdout.write(`${ui.green("✓")} 已写回 ${accept.length} 项状态${summary ? "及摘要" : ""}；lint：${counts.error} 错误、${counts.warning} 警告\n`);
  }
  return 0;
}
