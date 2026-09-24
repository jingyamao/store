/**
 * 章节 id 工具：统一使用 `ch-0001` 形式（四位补零）。
 *
 * 章节 id 是 Bible 中所有时间锚点的基准（firstAppearance / plantedAt /
 * resolvedAt / diedAt ...），因此格式必须唯一且可比较大小。
 */

const CHAPTER_ID_RE = /^ch-(\d{4,})$/;

export function isChapterId(value: string): boolean {
  return CHAPTER_ID_RE.test(value);
}

/** 把 `ch-0007` 转成数字 7。非法格式直接抛错，不静默返回 NaN。 */
export function chapterNumber(id: string): number {
  const matched = CHAPTER_ID_RE.exec(id);
  const digits = matched?.[1];
  if (digits === undefined) {
    throw new Error(`非法章节 id: ${id}（期望形如 ch-0001）`);
  }
  return Number.parseInt(digits, 10);
}

/** 把数字 7 转成 `ch-0007`。 */
export function formatChapterId(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`非法章节序号: ${n}`);
  }
  return `ch-${String(n).padStart(4, "0")}`;
}

/** 章节 id 的比较器，可直接传给 Array#sort。 */
export function compareChapterId(a: string, b: string): number {
  return chapterNumber(a) - chapterNumber(b);
}
