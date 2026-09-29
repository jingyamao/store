import { startWorkbench } from "../../web/server.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";

export async function runServe(port: number, global: GlobalOptions): Promise<number> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("端口必须是 0 到 65535 的整数");
  const { url } = await startWorkbench({ booksRoot: booksRootOf(global), workspaceRoot: resolveWorkspaceRoot(global.dir), bookId: global.book, port });
  process.stdout.write(`本地写作台：${url}\n按 Ctrl+C 结束。\n`);
  return 0;
}
