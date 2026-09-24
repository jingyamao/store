/**
 * lint 引擎的类型定义。
 *
 * 规则一律是「纯函数」：接收一个已经装载好的 LintContext，返回 Finding[]。
 * 文件 IO 全部在 createLintContext 阶段完成，规则本身不碰磁盘 ——
 * 这样规则极易测试，也不会因为 IO 失败而半途而废。
 */

import type { Book, PowerSystem, Timeline } from "../domain/schemas.js";
import type { BibleCollections, IndexedEntity } from "../store/bible.js";
import type { BookPaths } from "../store/paths.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  /** 产出该问题的规则名。 */
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  /** 涉及的实体 id 或文件，用于过滤与定位。 */
  readonly subject?: string;
  /** 字段级定位，如 `state.realm`。 */
  readonly field?: string;
}

export interface LintOptions {
  /** 伏笔超过多少章未回收就报警。 */
  readonly threadExpiryChapters: number;
}

export const DEFAULT_LINT_OPTIONS: LintOptions = {
  threadExpiryChapters: 60,
};

export interface LintContext {
  readonly bookId: string;
  readonly book: Book;
  readonly paths: BookPaths;
  readonly collections: BibleCollections;
  readonly powerSystem: PowerSystem;
  readonly timeline: Timeline;
  /** 全 Bible 的 id → 实体索引。 */
  readonly index: Map<string, IndexedEntity>;
  /** 已存在的章节正文：章节 id → 文本。 */
  readonly chapters: Map<string, string>;

  readonly styleText: string;
  readonly masterOutlineText: string;
  /** 从 style.md 第七节解析出的 AI 味黑名单。 */
  readonly aiFlavorBlacklist: string[];

  /** 已写到的最大章节号；0 表示还没有任何章节。 */
  readonly latestChapterNumber: number;
  readonly options: LintOptions;
}

export interface LintRule {
  readonly name: string;
  readonly description: string;
  run(ctx: LintContext): Finding[];
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

/** 带 name/aliases 的实体（人物 / 物品 / 地点 / 势力）。 */
export interface NamedEntity {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  /** 首次出场章节 —— 章节交叉校验用。 */
  readonly firstAppearance?: string | undefined;
}

/** 规则内收集结果的便捷工具。 */
export interface Reporter {
  error(message: string, extra?: { subject?: string; field?: string }): void;
  warn(message: string, extra?: { subject?: string; field?: string }): void;
  info(message: string, extra?: { subject?: string; field?: string }): void;
  readonly findings: Finding[];
}

export function createReporter(rule: string): Reporter {
  const findings: Finding[] = [];
  const push = (
    severity: Severity,
    message: string,
    extra?: { subject?: string; field?: string },
  ) => {
    findings.push({
      rule,
      severity,
      message,
      ...(extra?.subject !== undefined ? { subject: extra.subject } : {}),
      ...(extra?.field !== undefined ? { field: extra.field } : {}),
    });
  };

  return {
    error: (message, extra) => push("error", message, extra),
    warn: (message, extra) => push("warning", message, extra),
    info: (message, extra) => push("info", message, extra),
    findings,
  };
}

/** 取四大「有名有姓」的集合，供专名相关规则复用。 */
export function namedGroups(
  ctx: LintContext,
): Array<{ label: string; key: string; entities: readonly NamedEntity[] }> {
  return [
    { label: "人物", key: "characters", entities: ctx.collections.characters },
    { label: "物品", key: "items", entities: ctx.collections.items },
    { label: "地点", key: "locations", entities: ctx.collections.locations },
    { label: "势力", key: "factions", entities: ctx.collections.factions },
  ];
}
