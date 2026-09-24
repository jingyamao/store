/**
 * 项目级规则：文风锚定文档、总纲、境界体系、Bible 是否还是一片空白。
 *
 * 这些检查不会报「错误」—— 它们的作用是提醒作者「这个工具要发挥作用，
 * 还差哪些输入」，所以以 warning / info 为主。
 */

import { createReporter, type LintRule } from "../types.js";

/** style.md 少于这个字数就认为没有真正填写。 */
const MIN_STYLE_LENGTH = 200;
/** 模板里的正面范例占位符。 */
const STYLE_PLACEHOLDER = "（粘贴你自己的段落）";

/* ── 文风锚定 ─────────────────────────────────── */

const STYLE_ANCHOR = "style-anchor";

export const styleAnchor: LintRule = {
  name: STYLE_ANCHOR,
  description: "文风锚定文档 style.md 是否已真正填写",

  run(ctx) {
    const reporter = createReporter(STYLE_ANCHOR);
    const text = ctx.styleText;

    if (text.trim() === "") {
      reporter.warn("缺少 style.md —— 文风锚定是防止「文风漂移」的唯一手段", {
        field: "style.md",
      });
      return reporter.findings;
    }

    if (text.trim().length < MIN_STYLE_LENGTH) {
      reporter.warn(
        `style.md 只有 ${text.trim().length} 字，过于简略，锚定效果会很弱`,
        { field: "style.md" },
      );
    }

    if (text.includes(STYLE_PLACEHOLDER)) {
      reporter.warn(
        "style.md 第五节的「正面范例」仍是占位符。这一节是文风锚定里最有效的部分，建议从旧作里摘 2–3 段",
        { field: "style.md" },
      );
    }

    if (ctx.aiFlavorBlacklist.length === 0) {
      reporter.info(
        "style.md 第七节的 AI 味黑名单为空。这份清单是本工具最私有的资产，建议随写作持续增补",
        { field: "style.md" },
      );
    }

    return reporter.findings;
  },
};

/* ── 总纲 ─────────────────────────────────────── */

const MASTER_OUTLINE = "master-outline";

export const masterOutline: LintRule = {
  name: MASTER_OUTLINE,
  description: "全书总纲是否已填写",

  run(ctx) {
    const reporter = createReporter(MASTER_OUTLINE);
    const text = ctx.masterOutlineText;

    if (text.trim() === "") {
      reporter.warn("缺少 outline/master.md —— 全书总纲缺失会让长程一致性无从谈起", {
        field: "outline/master.md",
      });
    } else if (text.trim().length < 80) {
      reporter.info("outline/master.md 内容很少，建议至少写清核心冲突与主线脉络", {
        field: "outline/master.md",
      });
    }

    return reporter.findings;
  },
};

/* ── 境界体系 ─────────────────────────────────── */

const POWER_SYSTEM_EMPTY = "power-system-empty";

export const powerSystemEmpty: LintRule = {
  name: POWER_SYSTEM_EMPTY,
  description: "境界体系是否已定义",

  run(ctx) {
    const reporter = createReporter(POWER_SYSTEM_EMPTY);

    if (ctx.powerSystem.realms.length > 0) {
      if (ctx.powerSystem.rules.length === 0) {
        reporter.info(
          "境界体系已定义但 rules 为空。写死几条硬规则（如越级战斗上限）能显著减少后期失控",
          { field: "bible/power_system.yaml" },
        );
      }
      return reporter.findings;
    }

    const withRealm = ctx.collections.characters.filter(
      (character) => character.state.realm !== undefined && character.state.realm.trim() !== "",
    );

    if (withRealm.length > 0) {
      reporter.warn(
        `有 ${withRealm.length} 位角色填写了 state.realm，但境界体系尚未定义，无法做任何校验`,
        { field: "bible/power_system.yaml" },
      );
    } else {
      reporter.info("境界体系为空。若本书没有等级设定可忽略", {
        field: "bible/power_system.yaml",
      });
    }

    return reporter.findings;
  },
};

/* ── Bible 是否空白 ───────────────────────────── */

const EMPTY_BIBLE = "empty-bible";

export const emptyBible: LintRule = {
  name: EMPTY_BIBLE,
  description: "Bible 是否还是一张白纸",

  run(ctx) {
    const reporter = createReporter(EMPTY_BIBLE);
    const { characters, items, locations, factions, threads, settings } = ctx.collections;

    if (characters.length === 0) {
      reporter.warn("还没有任何人物卡 —— Bible 的价值主要来自人物与伏笔", {
        field: "bible/characters.yaml",
      });
    }

    if (characters.length > 0 && threads.length === 0) {
      reporter.info("还没有登记任何伏笔。开篇埋下的线索越早登记，后期越不容易漏", {
        field: "bible/threads.yaml",
      });
    }

    const total = characters.length + items.length + locations.length +
      factions.length + threads.length + settings.length;
    if (total === 0) {
      reporter.info("Bible 目前完全为空。可以用 `novel char add` 等命令开始填充", {
        field: "bible/",
      });
    }

    return reporter.findings;
  },
};

export const projectRules: readonly LintRule[] = [
  styleAnchor,
  masterOutline,
  powerSystemEmpty,
  emptyBible,
];
