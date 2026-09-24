/**
 * CLI 全局上下文：工作区定位与错误处理约定。
 */

import { resolve } from "node:path";
import { booksRootFor } from "../store/paths.js";

export interface GlobalOptions {
  /** 工作区根目录，默认为 NOVEL_HOME 或当前目录。 */
  readonly dir?: string | undefined;
  readonly json?: boolean | undefined;
  /** 指定书籍；省略时自动探测。 */
  readonly book?: string | undefined;
}

/**
 * 解析工作区根目录。
 *
 * 优先级：--dir > NOVEL_HOME > 当前目录。
 */
export function resolveWorkspaceRoot(dir?: string): string {
  const chosen = dir ?? process.env["NOVEL_HOME"] ?? process.cwd();
  return resolve(chosen);
}

export function booksRootOf(options: GlobalOptions): string {
  return booksRootFor(resolveWorkspaceRoot(options.dir));
}

/** CLI 错误 —— 只打印 message，不打印堆栈。 */
export class CliError extends Error {
  override readonly name = "CliError";
}

export function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${message}\n\n`);
}
