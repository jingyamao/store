import { loadConfig } from "../../config/index.js";
import { askBook, rebuildSearchIndex, searchBook } from "../../search/index.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export async function runIndexRebuild(global: GlobalOptions): Promise<number> {
  const count = await rebuildSearchIndex(booksRootOf(global), global.book);
  process.stdout.write(global.json === true ? `${JSON.stringify({ indexed: count })}\n` : `${ui.green("✓")} 已索引 ${count} 份资料\n`);
  return 0;
}
export async function runSearch(query: string, global: GlobalOptions): Promise<number> {
  const hits = await searchBook(booksRootOf(global), global.book, query);
  if (global.json === true) process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
  else process.stdout.write(hits.length === 0 ? "没有匹配资料。\n" : hits.map((hit) => `${ui.bold(hit.source)}\n  ${hit.snippet}`).join("\n\n") + "\n");
  return 0;
}
export async function runAsk(question: string, global: GlobalOptions): Promise<number> {
  const config = await loadConfig(resolveWorkspaceRoot(global.dir));
  const result = await askBook({ booksRoot: booksRootOf(global), bookId: global.book, question, config });
  process.stdout.write(global.json === true
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${result.answer}\n\n资料来源：${result.hits.length === 0 ? "无" : "\n" + result.hits.map((hit, index) => `  [${index + 1}] ${hit.source}`).join("\n")}\n`);
  return 0;
}
