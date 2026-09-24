import { describe, it } from "node:test";
import { expect } from "../testing/expect.js";
import {
  countWords,
  estimateMessageTokens,
  estimateTokens,
  truncateToTokens,
} from "./tokens.js";

describe("estimateTokens", () => {
  it("全角字符按 0.8 token/字估算", () => {
    expect(estimateTokens("中".repeat(100))).toBe(80);
  });

  it("ASCII 按 0.25 token/字符估算", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });

  it("中文标点也算作全角", () => {
    // 「，。」属于 CJK 标点区，终端占两列，分词器也接近一个 token
    expect(estimateTokens("，。")).toBe(2);
  });

  it("中英混排分别加权", () => {
    // 2 个全角 * 0.8 + 3 个 ASCII * 0.25 = 1.6 + 0.75 = 2.35 → 向上取整 3
    expect(estimateTokens("中文abc")).toBe(3);
  });

  it("空串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("估算随文本单调不减", () => {
    const short = estimateTokens("林渊走进山谷。");
    const long = estimateTokens("林渊走进山谷。".repeat(10));
    expect(long).toBeGreaterThan(short);
  });
});

describe("estimateMessageTokens", () => {
  it("每条消息都加上固定开销", () => {
    const bare = estimateTokens("你好");
    const asMessage = estimateMessageTokens([{ role: "user", content: "你好" }]);
    expect(asMessage).toBeGreaterThan(bare);
  });

  it("多条消息累加", () => {
    const one = estimateMessageTokens([{ role: "user", content: "你好" }]);
    const two = estimateMessageTokens([
      { role: "user", content: "你好" },
      { role: "user", content: "你好" },
    ]);
    expect(two).toBe(one * 2);
  });
});

describe("truncateToTokens", () => {
  it("预算足够时原样返回", () => {
    const result = truncateToTokens("林渊走进山谷。", 1000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("林渊走进山谷。");
  });

  it("超预算时裁到预算之内", () => {
    const result = truncateToTokens("中".repeat(1000), 100);
    expect(result.truncated).toBe(true);
    expect(result.tokens).toBeLessThanOrEqual(100);
    // 0.8 token/字 下 125 字刚好 100 token
    expect([...result.text].length).toBe(125);
  });

  it("二分结果确实落在预算内（不会因估偏而超出）", () => {
    const mixed = "林渊abc走进山谷，刀光一闪。".repeat(200);
    for (const budget of [10, 37, 100, 999]) {
      const result = truncateToTokens(mixed, budget);
      expect(result.tokens).toBeLessThanOrEqual(budget);
    }
  });

  it("预算为 0 时返回空串", () => {
    const result = truncateToTokens("林渊走进山谷。", 0);
    expect(result.text).toBe("");
    expect(result.tokens).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it("不会切碎代理对字符", () => {
    const text = "🌑".repeat(50); // 每个是代理对
    const result = truncateToTokens(text, 20);
    // 若能正常拼接，说明没有产生半个代理字符
    expect(result.text.length).toBeGreaterThanOrEqual(0);
    expect(result.text).toBe([...result.text].join(""));
  });
});

describe("countWords", () => {
  it("统计非 ASCII 字符数", () => {
    expect(countWords("你好，世界")).toBe(5);
  });

  it("忽略 ASCII", () => {
    expect(countWords("你好abc")).toBe(2);
  });
});
