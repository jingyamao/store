import { describe, it } from "node:test";
import { expect } from "../testing/expect.js";
import { isSummaryPlaceholder, scaffoldSummary, SUMMARY_SECTIONS } from "./summary.js";

describe("scaffoldSummary", () => {
  it("四个问题都在", () => {
    const text = scaffoldSummary();
    for (const section of SUMMARY_SECTIONS) {
      expect(text).toContain(`### ${section}`);
    }
  });

  it("有标题时写标题，没有就不写", () => {
    expect(scaffoldSummary("逐出宗门")).toContain("# 逐出宗门");
    // 注意：段落标题 `### 情节` 本身含 #，所以只断言没有一级标题
    expect(scaffoldSummary("").startsWith("# ")).toBe(false);
  });

  it("标题只有空白时不写标题行", () => {
    expect(scaffoldSummary("   ").startsWith("# ")).toBe(false);
  });

  it("不重复章节号 —— 注入时 context-pack 会加表头", () => {
    expect(scaffoldSummary("逐出宗门")).not.toContain("第 1 章");
  });
});

describe("isSummaryPlaceholder", () => {
  it("空串算没填", () => {
    expect(isSummaryPlaceholder("")).toBe(true);
    expect(isSummaryPlaceholder("   \n  ")).toBe(true);
  });

  it("刚生成的骨架算没填", () => {
    expect(isSummaryPlaceholder(scaffoldSummary())).toBe(true);
    expect(isSummaryPlaceholder(scaffoldSummary("逐出宗门"))).toBe(true);
  });

  it("括号说明本身就是提示，单独留着仍算没填", () => {
    expect(isSummaryPlaceholder("（这一章发生了什么？3-5 句，只写事实。）")).toBe(true);
  });

  it("只剩空项目符号时算没填", () => {
    expect(isSummaryPlaceholder("### 伏笔\n- 埋下：\n- 回收：")).toBe(true);
  });

  it("填了情节就算填了", () => {
    expect(isSummaryPlaceholder("### 情节\n林渊被逐出宗门。")).toBe(false);
  });

  it("只填了一个空项目符号的真实内容也算填了", () => {
    expect(isSummaryPlaceholder("### 状态变化\n- 人物：林渊（重伤）")).toBe(false);
  });

  it("项目符号后有真实内容就算填了", () => {
    expect(isSummaryPlaceholder("- 埋下：断岳刀的裂痕")).toBe(false);
  });

  it("纯散文（没有骨架结构）算填了", () => {
    expect(isSummaryPlaceholder("林渊被逐出宗门，流落到落霞谷。")).toBe(false);
  });

  it("括号里是真实内容时不会被误删", () => {
    expect(isSummaryPlaceholder("### 伏笔\n- 埋下：断岳刀的裂痕（刀身第三寸）")).toBe(false);
  });
});
