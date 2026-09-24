/**
 * 引用类规则：跨实体引用必须指向真实存在的实体。
 *
 * 这是 Bible 最容易腐烂的地方 —— 删掉一张人物卡，别处七八个引用就悬空了。
 * 之所以能用确定性规则做，是因为 id 有前缀命名空间（char_/item_/...），
 * 所以「引用类型对不对」和「目标存不存在」都可以精确判定。
 */

import { createReporter, type LintRule } from "../types.js";

const DANGLING = "dangling-reference";

/** 伏笔 related 可以指向任意实体。 */
const ANY_PREFIXES = ["char_", "item_", "loc_", "faction_", "setting_", "thread_"] as const;

export const danglingReference: LintRule = {
  name: DANGLING,
  description: "跨实体引用是否指向真实存在的实体",

  run(ctx) {
    const reporter = createReporter(DANGLING);

    const check = (
      subject: string,
      field: string,
      id: string | undefined,
      prefix: string,
      kindLabel: string,
    ): void => {
      if (id === undefined || id.trim() === "") return;
      if (!id.startsWith(prefix) || !ctx.index.has(id)) {
        reporter.error(`${subject} 的 ${field} 引用了不存在的${kindLabel} "${id}"`, {
          subject,
          field,
        });
      }
    };

    for (const character of ctx.collections.characters) {
      check(character.id, "state.location", character.state.location, "loc_", "地点");

      character.state.possession.forEach((itemId, index) => {
        check(character.id, `state.possession[${index}]`, itemId, "item_", "物品");
      });

      character.relationships.forEach((relation, index) => {
        if (relation.target === character.id) {
          reporter.warn(`${character.id} 的 relationships[${index}] 指向自己`, {
            subject: character.id,
            field: `relationships[${index}].target`,
          });
          return;
        }
        check(character.id, `relationships[${index}].target`, relation.target, "char_", "人物");
      });
    }

    for (const location of ctx.collections.locations) {
      if (location.parent === location.id) {
        reporter.warn(`${location.id} 的 parent 指向自己`, {
          subject: location.id,
          field: "parent",
        });
        continue;
      }
      check(location.id, "parent", location.parent, "loc_", "地点");
    }

    for (const faction of ctx.collections.factions) {
      check(faction.id, "base", faction.base, "loc_", "地点");
    }

    for (const thread of ctx.collections.threads) {
      thread.related.forEach((id, index) => {
        const hasKnownPrefix = ANY_PREFIXES.some((prefix) => id.startsWith(prefix));
        if (!hasKnownPrefix || !ctx.index.has(id)) {
          reporter.error(`${thread.id} 的 related[${index}] 引用了不存在的实体 "${id}"`, {
            subject: thread.id,
            field: `related[${index}]`,
          });
        }
      });
    }

    // 时间线事件指向的章节应当已经写出来
    if (ctx.chapters.size > 0) {
      for (const event of ctx.timeline.events) {
        if (!ctx.chapters.has(event.chapter)) {
          reporter.warn(
            `时间线事件「${event.summary}」指向尚未写出的章节 ${event.chapter}`,
            { subject: event.id, field: "chapter" },
          );
        }
      }
    }

    return reporter.findings;
  },
};

export const referenceRules: readonly LintRule[] = [danglingReference];
