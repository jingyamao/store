/**
 * `novel lint [book-id]` —— 确定性检查。
 *
 * 退出码：0 = 干净；1 = 发现问题（或在 --strict 下有警告）。
 */

import {
  ALL_RULES,
  createLintContext,
  runLint,
  SEVERITY_LABEL,
  summarize,
  type Finding,
  type Severity,
} from "../../lint/index.js";
import { booksRootOf, CliError, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export interface LintCommandOptions {
  readonly bookId?: string | undefined;
  readonly threadExpiry?: number | undefined;
  readonly strict?: boolean | undefined;
  readonly rule?: string | undefined;
}

const SEVERITY_ICON: Record<Severity, string> = {
  error: "✗",
  warning: "!",
  info: "·",
};

function paintSeverity(severity: Severity, text: string): string {
  switch (severity) {
    case "error":
      return ui.red(text);
    case "warning":
      return ui.yellow(text);
    case "info":
      return ui.cyan(text);
  }
}

function formatFinding(finding: Finding): string {
  const icon = paintSeverity(finding.severity, SEVERITY_ICON[finding.severity]);
  const rule = ui.dim(`[${finding.rule}]`);

  const location: string[] = [];
  if (finding.subject !== undefined) location.push(finding.subject);
  if (finding.field !== undefined) location.push(finding.field);
  const suffix = location.length > 0 ? ` ${ui.dim(`(${location.join(" · ")})`)}` : "";

  return `  ${icon} ${rule} ${finding.message}${suffix}`;
}

export async function runLintCommand(
  options: LintCommandOptions,
  global: GlobalOptions,
): Promise<number> {
  const booksRoot = booksRootOf(global);

  const ctx = await createLintContext(
    booksRoot,
    options.bookId ?? global.book,
    options.threadExpiry !== undefined
      ? { threadExpiryChapters: options.threadExpiry }
      : undefined,
  );

  let rules = ALL_RULES;
  if (options.rule !== undefined) {
    const needle = options.rule.trim();
    rules = ALL_RULES.filter((rule) => rule.name === needle);
    if (rules.length === 0) {
      throw new CliError(
        `未知规则 "${options.rule}"。可用规则：\n${ALL_RULES.map((rule) => `  · ${rule.name}  ${rule.description}`).join("\n")}`,
      );
    }
  }

  const findings = runLint(ctx, rules);
  const counts = summarize(findings);
  const failing = counts.error > 0 || (options.strict === true && counts.warning > 0);

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify({ bookId: ctx.bookId, summary: counts, findings }, null, 2)}\n`,
    );
    return failing ? 1 : 0;
  }

  const lines: string[] = [];
  lines.push(`${ui.bold(ctx.book.title)} ${ui.dim(`(${ctx.bookId})`)} ${ui.dim("· lint")}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push(`${ui.green("✓")} 全部通过${ui.dim("（规则数 " + rules.length + "）")}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  for (const severity of ["error", "warning", "info"] as const) {
    const bucket = findings.filter((finding) => finding.severity === severity);
    if (bucket.length === 0) continue;

    lines.push(paintSeverity(severity, ui.bold(`${SEVERITY_LABEL[severity]} (${bucket.length})`)));
    for (const finding of bucket) lines.push(formatFinding(finding));
    lines.push("");
  }

  const summaryParts = [
    counts.error > 0 ? ui.red(`错误 ${counts.error}`) : ui.dim("错误 0"),
    counts.warning > 0 ? ui.yellow(`警告 ${counts.warning}`) : ui.dim("警告 0"),
    counts.info > 0 ? ui.cyan(`提示 ${counts.info}`) : ui.dim("提示 0"),
  ];
  lines.push(summaryParts.join(ui.dim(" · ")));

  if (failing) {
    lines.push("");
    lines.push(
      ui.dim(
        options.strict === true && counts.error === 0
          ? "（--strict：警告也视为失败）"
          : "（存在错误，退出码 1）",
      ),
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return failing ? 1 : 0;
}
