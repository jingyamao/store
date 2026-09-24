/**
 * 目录约定与书籍定位。
 *
 * 约定（详见 docs/tech-plan.md §3.1）：
 *   <workspace>/books/<book_id>/
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const BOOKS_DIRNAME = "books";

export interface BookPaths {
  /** 书籍根目录 books/<id> */
  readonly root: string;
  readonly bookFile: string;
  readonly styleFile: string;
  readonly bibleDir: string;
  readonly outlineDir: string;
  readonly masterOutlineFile: string;
  readonly volumesDir: string;
  readonly chaptersOutlineDir: string;
  readonly chaptersDir: string;
  readonly summariesDir: string;
  readonly runsDir: string;
  readonly indexPath: string;
}

export function booksRootFor(workspaceRoot: string): string {
  return join(workspaceRoot, BOOKS_DIRNAME);
}

export function bookPathsFor(booksRoot: string, bookId: string): BookPaths {
  const root = join(booksRoot, bookId);
  return {
    root,
    bookFile: join(root, "book.yaml"),
    styleFile: join(root, "style.md"),
    bibleDir: join(root, "bible"),
    outlineDir: join(root, "outline"),
    masterOutlineFile: join(root, "outline", "master.md"),
    volumesDir: join(root, "outline", "volumes"),
    chaptersOutlineDir: join(root, "outline", "chapters"),
    chaptersDir: join(root, "chapters"),
    summariesDir: join(root, "summaries"),
    runsDir: join(root, "runs"),
    indexPath: join(root, "index.sqlite"),
  };
}

/** 扫描 books/ 下所有合法书籍（含 book.yaml 的目录）。 */
export async function listBookIds(booksRoot: string): Promise<string[]> {
  if (!existsSync(booksRoot)) return [];
  const entries = await readdir(booksRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(booksRoot, name, "book.yaml")))
    .sort();
}

export interface ResolvedBook {
  readonly id: string;
  readonly paths: BookPaths;
}

/**
 * 定位书籍。
 *
 * 未显式指定 id 时自动探测：只有一本书就直接用，多本书则要求显式指定。
 * 自用工具下这个便利性很重要 —— 大多数时候只维护一本书。
 */
export async function resolveBook(booksRoot: string, bookId?: string): Promise<ResolvedBook> {
  if (bookId !== undefined) {
    const paths = bookPathsFor(booksRoot, bookId);
    if (!existsSync(paths.bookFile)) {
      throw new Error(
        `找不到书籍 "${bookId}"（期望 ${paths.bookFile} 存在）。\n` +
          `可运行 \`novel status --all\` 查看已有书籍。`,
      );
    }
    return { id: bookId, paths };
  }

  const ids = await listBookIds(booksRoot);
  const first = ids[0];
  if (first === undefined) {
    throw new Error(
      `当前目录下还没有任何书籍。\n请先运行 \`novel init <book-id>\` 创建一本。`,
    );
  }
  if (ids.length > 1) {
    throw new Error(
      `发现多本书，请显式指定 book-id：\n` +
        ids.map((id) => `  · ${id}`).join("\n"),
    );
  }
  return { id: first, paths: bookPathsFor(booksRoot, first) };
}
