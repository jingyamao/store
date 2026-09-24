/**
 * lint 引擎入口。
 *
 * 用法：
 *   const ctx = await createLintContext(booksRoot, bookId);
 *   const findings = runLint(ctx);
 */

import { buildEntityIndex, collectionsOf, loadBible } from "../store/bible.js";
import { latestChapterNumber, loadChapters } from "../store/chapters.js";
import { readTextFileOr } from "../store/file-io.js";
import { chapterRules } from "./rules/chapters.js";
import { characterRules } from "./rules/characters.js";
import { identityRules } from "./rules/identity.js";
import { projectRules } from "./rules/project.js";
import { referenceRules } from "./rules/references.js";
import { threadRules } from "./rules/threads.js";
import {
  DEFAULT_LINT_OPTIONS,
  SEVERITY_ORDER,
  type Finding,
  type LintContext,
  type LintOptions,
  type LintRule,
  type Severity,
} from "./types.js";

export * from "./types.js";

/**
 * 全部规则。顺序即输出分组的依据 —— 身份 → 引用 → 人物 → 伏笔 → 章节 → 项目。
 */
export const ALL_RULES: readonly LintRule[] = [
  ...identityRules,
  ...referenceRules,
  ...characterRules,
  ...threadRules,
  ...chapterRules,
  ...projectRules,
];

/* ── AI 味黑名单解析 ──────────────────────────── */

/**
 * 从 style.md 第七节解析作者的私有 AI 味黑名单。
 *
 * 必须找到标题才解析 —— 否则会把「正面范例」里的正文当成黑名单。
 */
export function parseAiFlavorBlacklist(styleText: string): string[] {
  const lines = styleText.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) => line.includes("AI 味黑名单") || line.includes("AI味黑名单"),
  );
  if (headingIndex === -1) return [];

  const terms: string[] = [];
  let inFence = false;

  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const term = line.trim();
    if (term === "" || term.startsWith("#")) continue;
    terms.push(term);
  }

  return [...new Set(terms)];
}

/* ── 上下文 ───────────────────────────────────── */

export async function createLintContext(
  booksRoot: string,
  bookId?: string,
  options?: Partial<LintOptions>,
): Promise<LintContext> {
  const bible = await loadBible(booksRoot, bookId);
  const collections = collectionsOf(bible);

  const [chapters, styleText, masterOutlineText] = await Promise.all([
    loadChapters(bible.paths),
    readTextFileOr(bible.paths.styleFile, ""),
    readTextFileOr(bible.paths.masterOutlineFile, ""),
  ] as const);

  return {
    bookId: bible.bookId,
    book: bible.book,
    paths: bible.paths,
    collections,
    powerSystem: bible.powerSystem,
    timeline: bible.timeline,
    index: buildEntityIndex(collections),
    chapters,
    styleText,
    masterOutlineText,
    aiFlavorBlacklist: parseAiFlavorBlacklist(styleText),
    latestChapterNumber: latestChapterNumber(chapters),
    options: { ...DEFAULT_LINT_OPTIONS, ...options },
  };
}

/* ── 执行 ─────────────────────────────────────── */

/**
 * 跑规则。
 *
 * 单条规则抛异常不会中断整轮 lint —— 会降级成一条 error，这样
 * 一条写坏的规则不至于让作者完全看不到其他问题。
 */
export function runLint(ctx: LintContext, rules: readonly LintRule[] = ALL_RULES): Finding[] {
  const findings: Finding[] = [];

  for (const rule of rules) {
    try {
      findings.push(...rule.run(ctx));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      findings.push({
        rule: rule.name,
        severity: "error",
        message: `规则执行失败：${reason}`,
      });
    }
  }

  return sortFindings(dedupeFindings(findings));
}

/* ── 结果整理 ─────────────────────────────────── */

export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.rule}\u0000${finding.severity}\u0000${finding.subject ?? ""}\u0000${finding.field ?? ""}\u0000${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

/** 稳定排序：严重度 → 主题 → 字段 → 规则 → 信息。保证输出可 diff。 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;

    const bySubject = (a.subject ?? "").localeCompare(b.subject ?? "");
    if (bySubject !== 0) return bySubject;

    const byField = (a.field ?? "").localeCompare(b.field ?? "");
    if (byField !== 0) return byField;

    const byRule = a.rule.localeCompare(b.rule);
    if (byRule !== 0) return byRule;

    return a.message.localeCompare(b.message);
  });
}

export type SeverityCounts = Record<Severity, number>;

export function summarize(findings: readonly Finding[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** 是否存在阻断性问题（用于 CLI 退出码）。 */
export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === "error");
}
