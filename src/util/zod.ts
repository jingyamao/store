/**
 * zod 辅助工具。
 */

import { z } from "zod";

/**
 * 让一个「内部字段自带 default」的 object schema，在整体缺省时
 * 也能得到完整默认值。
 *
 * 注意：zod v4 的 .default() 会短路解析、直接返回字面量，
 * 所以不能写 .default({})，否则内部字段的 default 不会生效。
 *
 * 例：SpeechStyleSchema.default(parsedDefault(SpeechStyleSchema))
 */
export function parsedDefault<T>(schema: z.ZodType<T>): () => T {
  return () => schema.parse({});
}
