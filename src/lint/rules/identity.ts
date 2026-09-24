/**
 * 身份类规则：重复 id、专名冲突、书籍元信息一致性。
 *
 * 专名冲突是「AI 写崩」最常见的表现之一 ——
 * 一旦两个实体共用同一个称呼，生成时模型就无法判断该召回哪张卡。
 */

import { createReporter, namedGroups, type LintRule } from "../types.js";

/* ── 集合内重复 id ─────────────────────────────── */

const DUPLICATE_IDS = "duplicate-ids";

export const duplicateIds: LintRule = {
  name: DUPLICATE_IDS,
  description: "同一集合内是否存在重复 id",

  run(ctx) {
    const reporter = createReporter(DUPLICATE_IDS);

    // 注：跨集合重复在结构上不可能 —— schema 用前缀（char_/item_/...）
    // 做了命名空间隔离。所以只需要查集合内部。
    const groups: Array<{ label: string; ids: string[] }> = [
      { label: "人物", ids: ctx.collections.characters.map((e) => e.id) },
      { label: "物品", ids: ctx.collections.items.map((e) => e.id) },
      { label: "地点", ids: ctx.collections.locations.map((e) => e.id) },
      { label: "势力", ids: ctx.collections.factions.map((e) => e.id) },
      { label: "伏笔", ids: ctx.collections.threads.map((e) => e.id) },
      { label: "设定", ids: ctx.collections.settings.map((e) => e.id) },
    ];

    for (const { label, ids } of groups) {
      const counts = new Map<string, number>();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, count] of counts) {
        if (count > 1) {
          reporter.error(`${label}集合中 id "${id}" 重复出现 ${count} 次`, { subject: id });
        }
      }
    }

    return reporter.findings;
  },
};

/* ── 专名冲突 ─────────────────────────────────── */

const ALIAS_CONFLICT = "alias-conflict";

interface Claim {
  readonly id: string;
  readonly label: string;
  readonly kind: "name" | "alias";
}

export const aliasConflict: LintRule = {
  name: ALIAS_CONFLICT,
  description: "不同实体是否声明了相同或重叠的名称 / 别名",

  run(ctx) {
    const reporter = createReporter(ALIAS_CONFLICT);
    const claims = new Map<string, Claim[]>();

    const claim = (surface: string, value: Claim) => {
      const key = surface.trim();
      if (key === "") return;
      const bucket = claims.get(key);
      if (bucket === undefined) claims.set(key, [value]);
      else bucket.push(value);
    };

    for (const { label, entities } of namedGroups(ctx)) {
      for (const entity of entities) {
        claim(entity.name, { id: entity.id, label, kind: "name" });
        for (const alias of entity.aliases) {
          claim(alias, { id: entity.id, label, kind: "alias" });
        }
      }
    }

    for (const [surface, list] of claims) {
      // 同一实体的 name 又被写进 aliases 是冗余，不是冲突
      const byId = new Map<string, Claim>();
      for (const item of list) {
        if (!byId.has(item.id)) byId.set(item.id, item);
      }
      const distinct = [...byId.values()];

      if (distinct.length === 1) {
        const only = distinct[0];
        if (only !== undefined && list.length > 1) {
          reporter.warn(`「${surface}」在 ${only.id} 中重复声明（name 与 aliases 内容重叠）`, {
            subject: only.id,
            field: "aliases",
          });
        }
        continue;
      }

      const detail = distinct.map((item) => `${item.label}:${item.id}`).join("、");
      const labels = new Set(distinct.map((item) => item.label));
      const subject = distinct[0]?.id;

      if (labels.size === 1) {
        reporter.error(
          `专名冲突：「${surface}」被同集合内的多个实体占用 —— ${detail}`,
          subject !== undefined ? { subject, field: "name" } : { field: "name" },
        );
      } else {
        reporter.warn(
          `专名重叠：「${surface}」出现在不同集合中 —— ${detail}（生成时可能召回错误的卡）`,
          subject !== undefined ? { subject } : undefined,
        );
      }
    }

    return reporter.findings;
  },
};

/* ── 书籍元信息 ───────────────────────────────── */

const BOOK_MISMATCH = "book-meta-mismatch";

export const bookMetaMismatch: LintRule = {
  name: BOOK_MISMATCH,
  description: "book.yaml 的 id 与所在目录名是否一致",

  run(ctx) {
    const reporter = createReporter(BOOK_MISMATCH);

    if (ctx.book.id !== ctx.bookId) {
      reporter.error(
        `book.yaml 中的 id 是 "${ctx.book.id}"，但所在目录名是 "${ctx.bookId}"`,
        { subject: ctx.bookId, field: "id" },
      );
    }

    if (ctx.book.title.trim() === "") {
      reporter.warn("book.yaml 的 title 为空", { field: "title" });
    }

    return reporter.findings;
  },
};

export const identityRules: readonly LintRule[] = [
  duplicateIds,
  aliasConflict,
  bookMetaMismatch,
];
