/**
 * 章节交叉校验规则 —— 这是「登记」与「实际正文」的对账。
 *
 * 只有已经写出正文的章节参与校验；空 Bible 或还没开写时不会有任何噪音。
 *
 * 注意复杂度：反向检查是 O(实体数 × 章节数) 的子串扫描。
 * 自用规模（数百章 × 数百实体）下耗时可接受，但这是本引擎里最慢的一环。
 */

import { chapterNumber, compareChapterId } from "../../domain/ids.js";
import { createReporter, namedGroups, type LintRule, type NamedEntity } from "../types.js";

const CHAPTER_PRESENCE = "chapter-presence";

/** 单字名做子串匹配会疯狂误报，因此反向检查只认 2 字以上的称呼。 */
const MIN_SURFACE_LENGTH = 2;

function surfacesOf(entity: NamedEntity): string[] {
  const all = [entity.name, ...entity.aliases]
    .map((surface) => surface.trim())
    .filter((surface) => surface.length > 0);
  return [...new Set(all)];
}

export const chapterPresence: LintRule = {
  name: CHAPTER_PRESENCE,
  description: "实体的 firstAppearance 登记与实际正文是否吻合",

  run(ctx) {
    const reporter = createReporter(CHAPTER_PRESENCE);

    if (ctx.chapters.size === 0) return reporter.findings;

    const chapterIds = [...ctx.chapters.keys()].sort(compareChapterId);

    for (const { label, entities } of namedGroups(ctx)) {
      for (const entity of entities) {
        const surfaces = surfacesOf(entity);
        if (surfaces.length === 0) continue;

        const firstAppearance = entity.firstAppearance;

        // 正向：登记了首次出场章节，但那一章正文里根本没出现
        if (firstAppearance !== undefined) {
          const text = ctx.chapters.get(firstAppearance);
          if (text !== undefined && !surfaces.some((surface) => text.includes(surface))) {
            reporter.warn(
              `${label}「${entity.name}」(${entity.id}) 登记首次出场为 ${firstAppearance}，` +
                `但该章正文中未出现其名称或别名`,
              { subject: entity.id, field: "firstAppearance" },
            );
          }

          // 反向：在登记的首次出场之前就已经出现了
          const limit = chapterNumber(firstAppearance);
          const searchable = surfaces.filter((surface) => surface.length >= MIN_SURFACE_LENGTH);

          if (searchable.length > 0) {
            for (const chapterId of chapterIds) {
              if (chapterNumber(chapterId) >= limit) break;
              const text = ctx.chapters.get(chapterId);
              if (text === undefined) continue;

              const hit = searchable.find((surface) => text.includes(surface));
              if (hit !== undefined) {
                reporter.info(
                  `${label}「${entity.name}」(${entity.id}) 在 ${chapterId} 中已出现（"${hit}"），` +
                    `但 firstAppearance 登记为 ${firstAppearance}`,
                  { subject: entity.id, field: "firstAppearance" },
                );
                break;
              }
            }
          }
        }
      }
    }

    return reporter.findings;
  },
};

export const chapterRules: readonly LintRule[] = [chapterPresence];
