import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { readChapterText, writeChapterText } from "./chapters.js";
import { readChapterOutline, writeChapterOutline } from "./outlines.js";
import { compareRevision, diffLines, HistoryConflictError, listRevisions, readRevision, restoreRevision } from "./history.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

async function workspace(): Promise<TestWorkspace> {
  const ws = await createWorkspace();
  opened.push(ws);
  return ws;
}

describe("章节版本历史", () => {
  it("正文变化前保存旧版，重复保存不增加版本，恢复后仍可撤销", async () => {
    const ws = await workspace();
    await writeChapterText(ws.paths, "ch-0001", "第一版\n相同段落");
    if ((await listRevisions(ws.paths, "ch-0001", "text")).length !== 1) throw new Error("首次创建不应产生旧版本");
    await writeChapterText(ws.paths, "ch-0001", "第二版\n相同段落");
    await writeChapterText(ws.paths, "ch-0001", "第二版\n相同段落");
    const revisions = await listRevisions(ws.paths, "ch-0001", "text");
    if (revisions.length !== 2 || revisions[1]?.reason !== "save") throw new Error("重复保存产生了多余版本");
    const old = revisions[1];
    if (old === undefined || await readRevision(ws.paths, "ch-0001", "text", old.id) !== "第一版\n相同段落") throw new Error("旧版内容不可读");
    const diff = await compareRevision(ws.paths, "ch-0001", "text", old.id);
    if (!diff.lines.some((line) => line.kind === "remove" && line.text === "第一版") || !diff.lines.some((line) => line.kind === "add" && line.text === "第二版")) {
      throw new Error("逐行差异不正确");
    }
    let conflict = false;
    try { await restoreRevision(ws.paths, "ch-0001", "text", old.id, "0".repeat(64)); }
    catch (error) { conflict = error instanceof HistoryConflictError; }
    if (!conflict) throw new Error("恢复未阻止过期预览覆盖当前内容");
    await restoreRevision(ws.paths, "ch-0001", "text", old.id, diff.currentHash);
    if (await readChapterText(ws.paths, "ch-0001") !== "第一版\n相同段落") throw new Error("旧版恢复失败");
    const after = await listRevisions(ws.paths, "ch-0001", "text");
    const undo = after.find((entry) => entry.reason === "restore");
    if (undo === undefined || await readRevision(ws.paths, "ch-0001", "text", undo.id) !== "第二版\n相同段落") throw new Error("恢复前内容没有保留");
    await restoreRevision(ws.paths, "ch-0001", "text", undo.id, after[0]!.hash);
    if (await readChapterText(ws.paths, "ch-0001") !== "第二版\n相同段落") throw new Error("恢复操作不能撤销");
  });

  it("细纲恢复前校验快照，损坏或越界版本不能覆盖当前细纲", async () => {
    const ws = await workspace();
    await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({ chapter: "ch-0002", title: "旧标题" }));
    await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({ chapter: "ch-0002", title: "新标题" }));
    const versions = await listRevisions(ws.paths, "ch-0002", "outline");
    const old = versions[1];
    if (old === undefined) throw new Error("旧细纲版本缺失");
    await restoreRevision(ws.paths, "ch-0002", "outline", old.id, versions[0]!.hash);
    if ((await readChapterOutline(ws.paths, "ch-0002"))?.title !== "旧标题") throw new Error("旧细纲恢复失败");
    let rejected = false;
    try { await readRevision(ws.paths, "ch-0002", "outline", "../../book.yaml"); } catch { rejected = true; }
    if (!rejected) throw new Error("越界版本 ID 被接受");
    await writeFile(join(ws.paths.historyDir, "ch-0002", "outline", `${old.id}.gz`), "broken");
    rejected = false;
    try { await readRevision(ws.paths, "ch-0002", "outline", old.id); } catch { rejected = true; }
    if (!rejected || (await readChapterOutline(ws.paths, "ch-0002"))?.title !== "旧标题") throw new Error("损坏快照未被拒绝或破坏了当前文件");
  });

  it("长差异走有界内存分支，仍保留改动内容", () => {
    const old = Array.from({ length: 550 }, (_, index) => `旧${index}`).join("\n");
    const next = Array.from({ length: 550 }, (_, index) => `新${index}`).join("\n");
    const lines = diffLines(old, next);
    if (lines.filter((line) => line.kind === "remove").length !== 550 || lines.filter((line) => line.kind === "add").length !== 550) {
      throw new Error("长差异遗漏内容");
    }
  });
});
