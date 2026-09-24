/**
 * 测试用的临时工作区。
 *
 * 每个测试在系统临时目录里建一本完整的书，测完删掉 —— 不污染仓库，
 * 也不依赖任何网络或外部状态。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookPathsFor, type BookPaths } from "../store/paths.js";
import { initBook } from "../store/scaffold.js";

export interface TestWorkspace {
  readonly root: string;
  readonly booksRoot: string;
  readonly bookId: string;
  readonly paths: BookPaths;
  cleanup(): Promise<void>;
}

export async function createWorkspace(bookId = "demo"): Promise<TestWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "novel-test-"));
  const booksRoot = join(root, "books");
  const paths = await initBook(booksRoot, { bookId, title: "测试书" });

  return {
    root,
    booksRoot,
    bookId,
    paths,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 只建一个空临时目录，用于测配置这类与书籍无关的东西。 */
export async function createTempDir(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "novel-cfg-"));
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** 便捷包装：在指定工作区里跑一轮 lint。 */
export { bookPathsFor };
