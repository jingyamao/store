import { describe, it } from "node:test";
import { captureError, expect } from "../testing/expect.js";
import { CliError } from "./context.js";
import {
  describeIssue,
  expectsArrayIssue,
  parseValueForSchema,
  splitList,
  type AttemptResult,
} from "./value-parsing.js";

/** 模拟一个「列表字段」的校验器。 */
function arrayAttempt(value: unknown): AttemptResult<string[]> {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return { ok: true, value: value as string[] };
  }
  return {
    ok: false,
    message: "设置 cast 失败：Invalid input: expected array, received string（cast）",
    expectingArray: true,
  };
}

/** 模拟一个「字符串字段」的校验器。 */
function stringAttempt(value: unknown): AttemptResult<string> {
  if (typeof value === "string") return { ok: true, value };
  return { ok: false, message: "期望字符串", expectingArray: false };
}

/* ── splitList ────────────────────────────────── */

describe("splitList", () => {
  it("按逗号切分", () => {
    expect(splitList("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("忽略逗号后的空格", () => {
    expect(splitList("a, b , c")).toEqual(["a", "b", "c"]);
  });

  it("也接受空格分隔", () => {
    expect(splitList("a b c")).toEqual(["a", "b", "c"]);
  });

  it("剥掉方括号", () => {
    expect(splitList("[a,b]")).toEqual(["a", "b"]);
  });

  it("剥掉方括号与引号（PowerShell 折腾后的残骸）", () => {
    expect(splitList('[char_linyuan]')).toEqual(["char_linyuan"]);
    expect(splitList('["a","b"]')).toEqual(["a", "b"]);
  });

  it("剥掉单个元素上残留的引号", () => {
    expect(splitList('"a", "b"')).toEqual(["a", "b"]);
  });

  it("空串返回空数组", () => {
    expect(splitList("")).toEqual([]);
    expect(splitList("   ")).toEqual([]);
    expect(splitList("[]")).toEqual([]);
  });
});

/* ── parseValueForSchema ──────────────────────── */

describe("parseValueForSchema", () => {
  it("JSON 数组直接通过，不走兜底", () => {
    const result = parseValueForSchema('["char_linyuan","char_suwan"]', arrayAttempt);
    expect(result.value).toEqual(["char_linyuan", "char_suwan"]);
    expect(result.usedListFallback).toBe(false);
  });

  it("不加引号的逗号列表走兜底", () => {
    const result = parseValueForSchema("char_linyuan,char_suwan", arrayAttempt);
    expect(result.value).toEqual(["char_linyuan", "char_suwan"]);
    expect(result.usedListFallback).toBe(true);
  });

  it("PowerShell 吃掉双引号后的残骸也能救回来", () => {
    const result = parseValueForSchema("[char_linyuan]", arrayAttempt);
    expect(result.value).toEqual(["char_linyuan"]);
    expect(result.usedListFallback).toBe(true);
  });

  it("单个元素也能当列表", () => {
    const result = parseValueForSchema("char_linyuan", arrayAttempt);
    expect(result.value).toEqual(["char_linyuan"]);
    expect(result.usedListFallback).toBe(true);
  });

  it("普通文本里的逗号绝不会被切成列表", () => {
    const result = parseValueForSchema("先铺垫，再爆发，最后收束", stringAttempt);
    expect(result.value).toBe("先铺垫，再爆发，最后收束");
    expect(result.usedListFallback).toBe(false);
  });

  it("字符串字段拿到合法字符串时直接通过", () => {
    expect(parseValueForSchema("筑基后期", stringAttempt).value).toBe("筑基后期");
  });

  it("值类型不对时抛出可读的错误", async () => {
    // "123" 会被 JSON 解析成数字，对字符串字段就是类型错误
    const error = await captureError(() => parseValueForSchema("123", stringAttempt));
    expect(error instanceof CliError).toBe(true);
    expect((error as CliError).message).toBe("期望字符串");
  });

  it("数组兜底也失败时，报的是原始错误而不是兜底的错误", async () => {
    const alwaysFails = (): AttemptResult<string[]> => ({
      ok: false,
      message: "原始错误信息",
      expectingArray: true,
    });
    const error = await captureError(() => parseValueForSchema("a,b", alwaysFails));
    expect((error as CliError).message).toBe("原始错误信息");
  });
});

/* ── 错误信息 ─────────────────────────────────── */

describe("expectsArrayIssue", () => {
  it("认得出 zod v4 的 expected 字段", () => {
    expect(expectsArrayIssue({ message: "任意", expected: "array" })).toBe(true);
  });

  it("expected 字段改名后靠 message 兜底", () => {
    expect(
      expectsArrayIssue({ message: "Invalid input: expected array, received string" }),
    ).toBe(true);
  });

  it("别的类型不误判", () => {
    expect(expectsArrayIssue({ message: "expected string, received number" })).toBe(false);
    expect(expectsArrayIssue(undefined)).toBe(false);
  });
});

describe("describeIssue", () => {
  it("带上字段路径，方便定位", () => {
    expect(
      describeIssue({ message: "Invalid input", path: ["state", "realm"] }),
    ).toBe("Invalid input（state.realm）");
  });

  it("没有路径时只给消息", () => {
    expect(describeIssue({ message: "Invalid input" })).toBe("Invalid input");
    expect(describeIssue({ message: "Invalid input", path: [] })).toBe("Invalid input");
  });

  it("没有 issue 时给一句兜底", () => {
    expect(describeIssue(undefined)).toBe("不符合 schema");
  });
});
