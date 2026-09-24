/**
 * 命令行值解析。
 *
 * 除了 JSON，还支持不加引号的逗号 / 空格列表。原因很具体：
 * Windows PowerShell 5.1 向原生命令传参时会吃掉内层双引号，
 *
 *   novel char set char_linyuan aliases '["渊哥"]'
 *
 * 到了进程里变成 [渊哥]，JSON.parse 直接失败。与其让用户去背转义规则，
 * 不如让 char_linyuan,char_suwan 这种写法也能用。
 *
 * 兜底只在「schema 期望数组、但给的是字符串」时触发，
 * 所以 intent「先铺垫，再爆发」这类含逗号的普通文本不受影响。
 */

import { CliError } from "./context.js";
import { parseScalar } from "../util/dotted-path.js";

export interface AttemptFailure {
  readonly ok: false;
  readonly message: string;
  /** 失败是否因为「目标字段要数组，却给了字符串」。 */
  readonly expectingArray: boolean;
}

export type AttemptResult<T> = { readonly ok: true; readonly value: T } | AttemptFailure;

export interface ParsedValue<T> {
  readonly value: T;
  /** 是否走了列表兜底 —— 用于给用户一句提示。 */
  readonly usedListFallback: boolean;
}

/**
 * 解析命令行值并校验。
 *
 * @param attempt 用候选值试构造一次目标对象并校验。会被调用一到两次。
 */
export function parseValueForSchema<T>(
  raw: string,
  attempt: (value: unknown) => AttemptResult<T>,
): ParsedValue<T> {
  const direct = attempt(parseScalar(raw));
  if (direct.ok) return { value: direct.value, usedListFallback: false };

  if (direct.expectingArray) {
    const items = splitList(raw);
    if (items.length > 0) {
      const retry = attempt(items);
      if (retry.ok) return { value: retry.value, usedListFallback: true };
    }
  }

  throw new CliError(direct.message);
}

/**
 * 把 `a,b,c`、`a b c`、`[a,b]`、`["a","b"]` 统统切成列表。
 *
 * 方括号与引号都要剥掉 —— 它们正是 PowerShell 折腾之后留下的残骸。
 */
export function splitList(raw: string): string[] {
  let text = raw.trim();

  if (
    (text.startsWith("[") && text.endsWith("]")) ||
    (text.startsWith("{") && text.endsWith("}"))
  ) {
    text = text.slice(1, -1);
  }

  return text
    .split(/[,\s]+/)
    .map((entry) => entry.replace(/^["']+|["']+$/g, "").trim())
    .filter((entry) => entry !== "");
}

/** 判断一个 zod 校验错误是否在说「期望数组」。 */
export function expectsArrayIssue(
  issue: { message: string; expected?: unknown } | undefined,
): boolean {
  if (issue === undefined) return false;
  // expected 是 zod v4 的字段；message 兜底，防止将来字段改名后静默失效
  return issue.expected === "array" || issue.message.includes("expected array");
}

/** 把校验错误压成一行，并带上字段路径。 */
export function describeIssue(
  issue: { message: string; path?: readonly PropertyKey[] } | undefined,
): string {
  if (issue === undefined) return "不符合 schema";
  const path = issue.path;
  const where = path !== undefined && path.length > 0 ? `（${path.map(String).join(".")}）` : "";
  return `${issue.message}${where}`;
}
