/**
 * 人物类规则：境界合法性、生死状态一致性、主角数量、档案完整度、物品归属冲突。
 *
 * 这些全部是确定性检查 —— 不需要任何模型调用，毫秒级出结果。
 */

import { createReporter, type LintRule } from "../types.js";
import type { Character, CharacterRole } from "../../domain/schemas.js";

/** 主要角色：档案缺失会真正影响生成质量，因此用 warning。 */
const MAJOR_ROLES: ReadonlySet<CharacterRole> = new Set([
  "protagonist",
  "deuteragonist",
  "antagonist",
]);

/* ── 境界必须能在体系中找到 ────────────────────── */

const REALM_VALIDITY = "realm-validity";

export const realmValidity: LintRule = {
  name: REALM_VALIDITY,
  description: "人物当前境界是否属于已定义的境界体系",

  run(ctx) {
    const reporter = createReporter(REALM_VALIDITY);
    const defined = ctx.powerSystem.realms.map((realm) => realm.name);

    // 体系为空时由 power-system-empty 规则单独报告，这里不重复刷屏
    if (defined.length === 0) return reporter.findings;

    for (const character of ctx.collections.characters) {
      const realm = character.state.realm;
      if (realm === undefined || realm.trim() === "") continue;

      // 允许「筑基后期」「炼气三层」这类带小层次的写法 —— 只要以某个境界名开头即可
      const matched = defined.some((name) => realm.startsWith(name));
      if (!matched) {
        reporter.error(
          `${character.name}（${character.id}）的境界 "${realm}" 不在境界体系中。已定义：${defined.join("、")}`,
          { subject: character.id, field: "state.realm" },
        );
      }
    }

    return reporter.findings;
  },
};

/* ── 生死状态一致性 ───────────────────────────── */

const LIFE_CONSISTENCY = "life-consistency";

export const lifeConsistency: LintRule = {
  name: LIFE_CONSISTENCY,
  description: "state.alive 与 state.diedAt 是否自洽",

  run(ctx) {
    const reporter = createReporter(LIFE_CONSISTENCY);

    for (const character of ctx.collections.characters) {
      const { alive, diedAt, goals } = character.state;

      if (!alive && diedAt === undefined) {
        reporter.error(
          `${character.name}（${character.id}）标记为已死亡，但缺少 state.diedAt`,
          { subject: character.id, field: "state.diedAt" },
        );
      }

      if (alive && diedAt !== undefined) {
        reporter.error(
          `${character.name}（${character.id}）填写了 state.diedAt = ${diedAt}，但 state.alive 仍为 true`,
          { subject: character.id, field: "state.alive" },
        );
      }

      if (!alive && goals.length > 0) {
        reporter.info(
          `${character.name}（${character.id}）已死亡，但 state.goals 仍有 ${goals.length} 条。若由他人继承请注明`,
          { subject: character.id, field: "state.goals" },
        );
      }
    }

    return reporter.findings;
  },
};

/* ── 主角数量 ─────────────────────────────────── */

const PROTAGONIST_COUNT = "protagonist-count";

export const protagonistCount: LintRule = {
  name: PROTAGONIST_COUNT,
  description: "是否恰好有一位主角",

  run(ctx) {
    const reporter = createReporter(PROTAGONIST_COUNT);
    const characters = ctx.collections.characters;
    if (characters.length === 0) return reporter.findings;

    const protagonists = characters.filter((c) => c.role === "protagonist");

    if (protagonists.length === 0) {
      reporter.warn("没有标记为主角（role: protagonist）的人物，生成时可能缺少视角锚点", {
        field: "role",
      });
    } else if (protagonists.length > 1) {
      reporter.warn(
        `标记了 ${protagonists.length} 位主角：${protagonists.map((c) => c.name).join("、")}。若非有意为之，建议只保留一位`,
        { subject: protagonists[0]?.id, field: "role" },
      );
    }

    return reporter.findings;
  },
};

/* ── 档案完整度 ───────────────────────────────── */

const PROFILE_INCOMPLETE = "profile-incomplete";

/** 缺哪些字段会真正影响生成质量 —— 打算做成「待办清单」，而不是指责。 */
function gapsOf(character: Character): Array<{ field: string; note: string }> {
  const gaps: Array<{ field: string; note: string }> = [];

  if (character.personality.length === 0) {
    gaps.push({ field: "personality", note: "性格要点为空" });
  }
  if (character.firstAppearance === undefined) {
    gaps.push({ field: "firstAppearance", note: "未登记首次出场章节" });
  }
  if (character.state.asOfChapter === undefined) {
    gaps.push({ field: "state.asOfChapter", note: "state 未标注对应章节" });
  }

  return gaps;
}

export const profileIncomplete: LintRule = {
  name: PROFILE_INCOMPLETE,
  description: "人物卡是否缺少会影响生成质量的关键字段",

  run(ctx) {
    const reporter = createReporter(PROFILE_INCOMPLETE);

    for (const character of ctx.collections.characters) {
      const major = MAJOR_ROLES.has(character.role);
      for (const gap of gapsOf(character)) {
        const message = `${character.name}（${character.id}）：${gap.note}`;
        if (major) {
          reporter.warn(message, { subject: character.id, field: gap.field });
        } else {
          reporter.info(message, { subject: character.id, field: gap.field });
        }
      }

      // 口癖是人物辨识度的核心，但龙套没有也无妨
      const hasSpeech = character.speechStyle.patterns.length > 0;
      if (major && !hasSpeech) {
        reporter.info(
          `${character.name}（${character.id}）：speechStyle.patterns 为空，对白可能缺少辨识度`,
          { subject: character.id, field: "speechStyle.patterns" },
        );
      }
    }

    return reporter.findings;
  },
};

/* ── 物品归属冲突 ─────────────────────────────── */

const POSSESSION_CONFLICT = "possession-conflict";

export const possessionConflict: LintRule = {
  name: POSSESSION_CONFLICT,
  description: "同一件物品是否被多个角色同时持有",

  run(ctx) {
    const reporter = createReporter(POSSESSION_CONFLICT);
    const holders = new Map<string, string[]>();

    for (const character of ctx.collections.characters) {
      for (const itemId of character.state.possession) {
        const bucket = holders.get(itemId);
        const label = `${character.name}（${character.id}）`;
        if (bucket === undefined) holders.set(itemId, [label]);
        else bucket.push(label);
      }
    }

    for (const [itemId, names] of holders) {
      if (names.length > 1) {
        reporter.warn(
          `物品 "${itemId}" 同时被 ${names.length} 个角色持有：${names.join("、")}`,
          { subject: itemId, field: "state.possession" },
        );
      }
    }

    return reporter.findings;
  },
};

export const characterRules: readonly LintRule[] = [
  realmValidity,
  lifeConsistency,
  protagonistCount,
  profileIncomplete,
  possessionConflict,
];
