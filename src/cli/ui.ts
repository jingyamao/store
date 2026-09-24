/**
 * CLI 输出工具。
 *
 * 两个细节值得说明：
 *   1. 颜色只在 TTY 下启用，并尊重 NO_COLOR（管道/重定向时输出保持干净）。
 *   2. 表格按「显示宽度」而不是字符数对齐 —— 中日韩字符占两列，
 *      用 String#length 对齐会错位。
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export function colorEnabled(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["FORCE_COLOR"] !== undefined) return true;
  return process.stdout.isTTY === true;
}

export function paint(code: keyof typeof ANSI, text: string): string {
  return colorEnabled() ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

export const bold = (text: string): string => paint("bold", text);
export const dim = (text: string): string => paint("dim", text);
export const red = (text: string): string => paint("red", text);
export const green = (text: string): string => paint("green", text);
export const yellow = (text: string): string => paint("yellow", text);
export const cyan = (text: string): string => paint("cyan", text);
export const gray = (text: string): string => paint("gray", text);

/* ── 显示宽度 ─────────────────────────────────── */

// 既要本地使用（renderTable / keyValue），又要对外保持 ui.displayWidth 这个入口
import { displayWidth, padEndWidth } from "../util/text.js";

export { displayWidth, padEndWidth };

/* ── 表格 ─────────────────────────────────────── */

const COLUMN_GAP = "  ";

/**
 * 渲染一张左对齐表格。列宽按显示宽度计算，因此中英混排也能对齐。
 * 传入的单元格不应包含 ANSI 转义（会算错宽度）。
 */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const columnCount = header.length;
  const widths: number[] = [];

  for (let i = 0; i < columnCount; i++) {
    widths[i] = displayWidth(header[i] ?? "");
  }
  for (const row of rows) {
    for (let i = 0; i < columnCount; i++) {
      const cell = row[i] ?? "";
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    }
  }

  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => padEndWidth(cell, widths[index] ?? 0))
      .join(COLUMN_GAP)
      .trimEnd();

  const lines = [renderRow(header)];
  lines.push(widths.map((width) => "─".repeat(width)).join(COLUMN_GAP));
  for (const row of rows) lines.push(renderRow(row));

  return lines.join("\n");
}

/* ── 结构化输出辅助 ───────────────────────────── */

export function heading(text: string): string {
  return bold(text);
}

export function bullet(text: string): string {
  return `  ${dim("·")} ${text}`;
}

export function keyValue(key: string, value: string): string {
  return `${dim(padEndWidth(key, 10))} ${value}`;
}
