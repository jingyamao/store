import { describe, it } from "node:test";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { expect } from "../testing/expect.js";
import {
  buildDraftPrompt,
  buildMessages,
  buildOpeningsPrompt,
  buildSystemPrompt,
  parseOpenings,
} from "./prompt.js";

const outline = ChapterOutlineSchema.parse({
  chapter: "ch-0004",
  title: "落霞谷",
  intent: "林渊第一次遇见苏晚",
  conflict: "两人都想拿走同一株药",
  mustInclude: ["断岳刀的裂痕第一次被提及"],
  forbidden: ["不能暴露苏晚的师门"],
});

/* ── 系统提示 ─────────────────────────────────── */

describe("buildSystemPrompt", () => {
  it("包含核心铁律", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch("以作者提供的设定为准");
    expect(prompt).toMatch("只写这一章要发生的事");
    expect(prompt).toMatch("不要使用 Markdown 标记");
  });

  it("给了视角就写进约束", () => {
    expect(buildSystemPrompt({ pov: "第三人称有限" })).toMatch("全章保持第三人称有限视角");
  });

  it("没给视角就不提这一条", () => {
    expect(buildSystemPrompt().includes("全章保持")).toBe(false);
    expect(buildSystemPrompt({ pov: "" }).includes("全章保持")).toBe(false);
  });

  it("黑名单词会被列出", () => {
    const prompt = buildSystemPrompt({ blacklist: ["仿佛", "不禁"] });
    expect(prompt).toMatch("仿佛");
    expect(prompt).toMatch("不禁");
  });

  it("黑名单为空时不出现那一行", () => {
    expect(buildSystemPrompt({ blacklist: [] }).includes("作者明确拉黑")).toBe(false);
  });

  it("系统提示里没有小说原文，不会被人物的对白污染", () => {
    const prompt = buildSystemPrompt({ pov: "第三人称有限" });
    expect(prompt.length).toBeLessThan(1200);
  });
});

/* ── 初稿提示 ─────────────────────────────────── */

describe("buildDraftPrompt", () => {
  const base = {
    outline,
    contextText: "# 文风锚定\n\n冷硬克制。",
    targetWords: 2500,
  };

  it("把细纲写成明确的任务清单", () => {
    const prompt = buildDraftPrompt(base);
    expect(prompt).toMatch("第 4 章");
    expect(prompt).toMatch("落霞谷");
    expect(prompt).toMatch("林渊第一次遇见苏晚");
    expect(prompt).toMatch("两人都想拿走同一株药");
    expect(prompt).toMatch("断岳刀的裂痕第一次被提及");
    expect(prompt).toMatch("不能暴露苏晚的师门");
    expect(prompt).toMatch("约 2500 字");
  });

  it("带上上下文", () => {
    expect(buildDraftPrompt(base)).toMatch("冷硬克制。");
  });

  it("没有标题时不出现空的标题行", () => {
    const prompt = buildDraftPrompt({
      ...base,
      outline: ChapterOutlineSchema.parse({ chapter: "ch-0004" }),
    });
    expect(prompt.includes("- 标题：")).toBe(false);
  });

  it("没有 mustInclude / forbidden 时不出现空小节", () => {
    const prompt = buildDraftPrompt({
      ...base,
      outline: ChapterOutlineSchema.parse({ chapter: "ch-0004" }),
    });
    expect(prompt.includes("## 必须写到")).toBe(false);
    expect(prompt.includes("## 绝对不要出现")).toBe(false);
  });

  it("选定开篇时要求续写而非重复", () => {
    const prompt = buildDraftPrompt({ ...base, chosenOpening: "刀锋擦过耳侧。" });
    expect(prompt).toMatch("已选定的开篇");
    expect(prompt).toMatch("不要重复它");
    expect(prompt).toMatch("刀锋擦过耳侧。");
  });

  it("输出要求放在最后（长上下文之后重申关键指令）", () => {
    const prompt = buildDraftPrompt(base);
    expect(prompt.lastIndexOf("# 输出要求")).toBeGreaterThan(prompt.indexOf("# 文风锚定"));
  });

  it("带上视角人物", () => {
    expect(buildDraftPrompt({ ...base, povLabel: "林渊" })).toMatch("视角人物：林渊");
  });
});

/* ── 开篇提示 ─────────────────────────────────── */

describe("buildOpeningsPrompt", () => {
  const base = { outline, contextText: "设定内容", targetWords: 2500, count: 3 };

  it("要求的数量与输出的标记数量一致", () => {
    const prompt = buildOpeningsPrompt(base);
    expect(prompt).toMatch("===方案1===");
    expect(prompt).toMatch("===方案2===");
    expect(prompt).toMatch("===方案3===");
    expect(prompt.includes("===方案4===")).toBe(false);
  });

  it("数量可配", () => {
    const prompt = buildOpeningsPrompt({ ...base, count: 5 });
    expect(prompt).toMatch("===方案5===");
  });

  it("明确要求角度不同", () => {
    expect(buildOpeningsPrompt(base)).toMatch("明显不同");
  });
});

/* ── 开篇解析 ─────────────────────────────────── */

describe("parseOpenings", () => {
  it("按标记切分", () => {
    const text = [
      "===方案1===",
      "第一版",
      "===方案2===",
      "第二版",
      "===方案3===",
      "第三版",
    ].join("\n");

    expect(parseOpenings(text, 3)).toEqual(["第一版", "第二版", "第三版"]);
  });

  it("容忍额外的空格与更长的等号", () => {
    const text = "===== 方案 1 =====\n内容甲\n=====方案2=====\n内容乙";
    expect(parseOpenings(text, 2)).toEqual(["内容甲", "内容乙"]);
  });

  it("忽略标记之前的客套话", () => {
    const text = "好的，以下是三个方案：\n\n===方案1===\n内容甲";
    expect(parseOpenings(text, 1)).toEqual(["内容甲"]);
  });

  it("只取要求数量的方案", () => {
    const text = "===方案1===\n甲\n===方案2===\n乙\n===方案3===\n丙";
    expect(parseOpenings(text, 2)).toEqual(["甲", "乙"]);
  });

  it("模型没按格式来就按空行兜底切分", () => {
    const long = "这是一段足够长的开篇内容。".repeat(10);
    const text = `${long}\n\n${long}\n\n${long}`;
    const parsed = parseOpenings(text, 3);

    expect(parsed).toHaveLength(3);
  });

  it("兜底时丢掉过短的碎片（多半是「好的，以下是…」这类客套）", () => {
    const long = "这是一段足够长的开篇内容。".repeat(10);
    const parsed = parseOpenings(`好的。\n\n${long}\n\n${long}`, 3);

    expect(parsed).toHaveLength(2);
  });

  it("完全无法解析时返回空数组而不是抛错", () => {
    expect(parseOpenings("", 3)).toEqual([]);
    expect(parseOpenings("   ", 3)).toEqual([]);
  });
});

/* ── 消息组装 ─────────────────────────────────── */

describe("buildMessages", () => {
  it("系统提示在前，用户提示在后", () => {
    const messages = buildMessages("系统", "用户");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toBe("系统");
    expect(messages[1]?.role).toBe("user");
  });
});
