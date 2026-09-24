/**
 * 文本度量工具。
 *
 * 终端列宽计算与 token 估算都依赖同一件事：一个字符「有多宽、有多重」。
 * 所以字符分类集中在这里，避免两处各写一份码点范围表、然后逐渐分叉。
 */

export interface CharClasses {
  /** 全角字符：中日韩文字与标点。 */
  readonly fullWidth: number;
  /** ASCII 可打印字符。 */
  readonly ascii: number;
  /** 其余窄字符：注音、西里尔、带变音符的拉丁字母等。 */
  readonly other: number;
}

/**
 * 全角 / 宽字符的码点范围。
 *
 * 除了汉字本身，也覆盖了 CJK 标点（U+3000–U+303F）——
 * 「，」「。」「『』」在终端里同样占两列，在分词器里同样接近一个 token。
 */
export function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // 韩文字母
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // 中日韩部首、标点
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // 假名、注音、兼容字符
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // 基本汉字
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // 彝文
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 韩文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // 兼容汉字
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角形式
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

/** 按类别统计字符数。换行与制表符计入 ascii。 */
export function classifyChars(text: string): CharClasses {
  let fullWidth = 0;
  let ascii = 0;
  let other = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isFullWidthCodePoint(codePoint)) fullWidth += 1;
    else if (codePoint < 0x80) ascii += 1;
    else other += 1;
  }

  return { fullWidth, ascii, other };
}

/** 终端里实际占用的列数。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右侧补空格 —— 直接用 padEnd 会让中英混排的表格错位。 */
export function padEndWidth(text: string, width: number): string {
  const padding = width - displayWidth(text);
  return padding > 0 ? text + " ".repeat(padding) : text;
}

/**
 * 中文写作里更直观的度量：字数（不含空白，也不含 ASCII）。
 *
 * 网文的「字数」就是汉字数，标点也算 —— 这正是平台统计的口径。
 * 所以这里刻意不数 ASCII 单词：`OK` 不该算进一部中文小说的字数。
 */
export function countWords(text: string): number {
  const counts = classifyChars(text);
  return counts.fullWidth + counts.other;
}
