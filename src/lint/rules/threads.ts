/**
 * 伏笔类规则 —— 本项目最具差异化的模块。
 *
 * 挖坑不填是网文读者的头号怨念，而这个问题完全可以被系统解决：
 * 只要每条伏笔都登记了「何时埋下」，就能精确算出「已经多少章没提了」。
 */

import { chapterNumber, formatChapterId } from "../../domain/ids.js";
import { createReporter, type LintRule } from "../types.js";

/** 章节 id 已由 schema 校验过，这里只是防御性包装。 */
function safeChapterNumber(id: string): number | undefined {
  try {
    return chapterNumber(id);
  } catch {
    return undefined;
  }
}

/* ── 长期未回收 ───────────────────────────────── */

const THREAD_EXPIRY = "thread-expiry";

export const threadExpiry: LintRule = {
  name: THREAD_EXPIRY,
  description: "未回收的伏笔是否已经拖了太多章",

  run(ctx) {
    const reporter = createReporter(THREAD_EXPIRY);
    const current = ctx.latestChapterNumber;

    // 还没有任何章节正文时，无从计算「拖了多少章」
    if (current === 0) return reporter.findings;

    for (const thread of ctx.collections.threads) {
      if (thread.status !== "open" && thread.status !== "hinted") continue;
      // 缺 plantedAt 的情况由 thread-status 规则负责报告
      if (thread.plantedAt === undefined) continue;

      const planted = safeChapterNumber(thread.plantedAt);
      if (planted === undefined) continue;

      const age = current - planted;
      if (age >= ctx.options.threadExpiryChapters) {
        reporter.warn(
          `伏笔「${thread.title}」(${thread.id}) 自 ${thread.plantedAt} 埋设，` +
            `已过 ${age} 章仍未回收`,
          { subject: thread.id, field: "status" },
        );
      }

      if (thread.targetResolve !== undefined) {
        const target = safeChapterNumber(thread.targetResolve);
        if (target !== undefined && target < current) {
          reporter.warn(
            `伏笔「${thread.title}」(${thread.id}) 计划在 ${thread.targetResolve} 回收，` +
              `但当前已写到 ${formatChapterId(current)}`,
            { subject: thread.id, field: "targetResolve" },
          );
        }
      }
    }

    return reporter.findings;
  },
};

/* ── 章节先后顺序 ─────────────────────────────── */

const THREAD_ORDER = "thread-order";

export const threadOrder: LintRule = {
  name: THREAD_ORDER,
  description: "伏笔的埋设 / 计划回收 / 实际回收章节顺序是否合理",

  run(ctx) {
    const reporter = createReporter(THREAD_ORDER);

    for (const thread of ctx.collections.threads) {
      const planted =
        thread.plantedAt !== undefined ? safeChapterNumber(thread.plantedAt) : undefined;

      if (planted !== undefined && thread.targetResolve !== undefined) {
        const target = safeChapterNumber(thread.targetResolve);
        if (target !== undefined && target <= planted) {
          reporter.error(
            `伏笔「${thread.title}」(${thread.id}) 的计划回收章节 ${thread.targetResolve} ` +
              `不晚于埋设章节 ${thread.plantedAt}，顺序颠倒`,
            { subject: thread.id, field: "targetResolve" },
          );
        }
      }

      if (planted !== undefined && thread.resolvedAt !== undefined) {
        const resolved = safeChapterNumber(thread.resolvedAt);
        if (resolved !== undefined && resolved < planted) {
          reporter.error(
            `伏笔「${thread.title}」(${thread.id}) 的实际回收章节 ${thread.resolvedAt} ` +
              `早于埋设章节 ${thread.plantedAt}`,
            { subject: thread.id, field: "resolvedAt" },
          );
        }
      }
    }

    return reporter.findings;
  },
};

/* ── 状态与字段自洽 ───────────────────────────── */

const THREAD_STATUS = "thread-status";

export const threadStatus: LintRule = {
  name: THREAD_STATUS,
  description: "伏笔的 status 与 plantedAt / resolvedAt 是否自洽",

  run(ctx) {
    const reporter = createReporter(THREAD_STATUS);

    for (const thread of ctx.collections.threads) {
      const isResolved = thread.status === "resolved";

      if (isResolved && thread.resolvedAt === undefined) {
        reporter.warn(
          `伏笔「${thread.title}」(${thread.id}) 标记为已回收，但未填写 resolvedAt`,
          { subject: thread.id, field: "resolvedAt" },
        );
      }

      if (!isResolved && thread.resolvedAt !== undefined) {
        reporter.warn(
          `伏笔「${thread.title}」(${thread.id}) 填写了 resolvedAt = ${thread.resolvedAt}，` +
            `但 status 仍是 "${thread.status}"`,
          { subject: thread.id, field: "status" },
        );
      }

      if (!isResolved && thread.plantedAt === undefined) {
        reporter.warn(
          `伏笔「${thread.title}」(${thread.id}) 未登记 plantedAt，无法计算「拖了多少章」`,
          { subject: thread.id, field: "plantedAt" },
        );
      }

      if (thread.related.length === 0) {
        reporter.info(
          `伏笔「${thread.title}」(${thread.id}) 未关联任何实体，生成时可能无法被召回`,
          { subject: thread.id, field: "related" },
        );
      }
    }

    return reporter.findings;
  },
};

export const threadRules: readonly LintRule[] = [threadExpiry, threadOrder, threadStatus];
