/**
 * Token 估算。
 *
 * 刻意不引入 tiktoken 之类的分词器：它是原生依赖，且各模型分词器互不相同，
 * 精确计数换不来实际收益。这里用「按字符类别加权」的估算 ——
 * 宁可略微高估（浪费一点上下文窗口），也不要低估（超出窗口导致请求直接失败）。
 *
 * 权重依据：主流分词器对中文大致是 1 个 token 对应 1.2–1.5 个汉字，
 * 英文约 4 个字符 1 个 token。
 */

import { classifyChars, type CharClasses } from "../util/text.js";
import type { LlmMessage } from "../llm/types.js";

// LlmMessage 是模型层的基本概念，定义在 llm/types.ts；
// 这里重新导出，让只关心 token 的调用方不必多引一个模块。
export type { LlmMessage };

export interface TokenEstimatorOptions {
  /** 每个全角字符（中日韩文字与标点）折算的 token 数。 */
  readonly tokensPerFullWidthChar: number;
  /** 每个 ASCII 字符折算的 token 数。 */
  readonly tokensPerAsciiChar: number;
  /** 每个其他窄字符折算的 token 数。 */
  readonly tokensPerOtherChar: number;
  /** 每条消息的固定开销（角色标记等）。 */
  readonly messageOverhead: number;
}

export const DEFAULT_TOKEN_OPTIONS: TokenEstimatorOptions = {
  tokensPerFullWidthChar: 0.8,
  tokensPerAsciiChar: 0.25,
  tokensPerOtherChar: 0.5,
  messageOverhead: 4,
};

export function tokenCountOf(
  counts: CharClasses,
  options: TokenEstimatorOptions = DEFAULT_TOKEN_OPTIONS,
): number {
  const raw =
    counts.fullWidth * options.tokensPerFullWidthChar +
    counts.ascii * options.tokensPerAsciiChar +
    counts.other * options.tokensPerOtherChar;
  return Math.ceil(raw);
}

export function estimateTokens(
  text: string,
  options: TokenEstimatorOptions = DEFAULT_TOKEN_OPTIONS,
): number {
  return tokenCountOf(classifyChars(text), options);
}

export function estimateMessageTokens(
  messages: readonly LlmMessage[],
  options: TokenEstimatorOptions = DEFAULT_TOKEN_OPTIONS,
): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message.content, options) + options.messageOverhead,
    0,
  );
}

export interface TruncationResult {
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
}

/**
 * 把文本裁到 token 预算之内。
 *
 * 用二分查找而不是「按比例切一刀」：按比例切会因中英混排而估偏，
 * 二分能保证结果确实落在预算内。
 */
export function truncateToTokens(
  text: string,
  budget: number,
  options: TokenEstimatorOptions = DEFAULT_TOKEN_OPTIONS,
): TruncationResult {
  const total = estimateTokens(text, options);
  if (total <= budget) return { text, tokens: total, truncated: false };
  if (budget <= 0) return { text: "", tokens: 0, truncated: true };

  // 用码点数组切分，避免把代理对（emoji、扩展汉字）切成半个字符
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  let best = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = chars.slice(0, mid).join("");
    if (estimateTokens(candidate, options) <= budget) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const sliced = chars.slice(0, best).join("");
  return { text: sliced, tokens: estimateTokens(sliced, options), truncated: true };
}

/** 中文写作里更直观的度量：字数（不含空白）。 */
export { countWords } from "../util/text.js";
