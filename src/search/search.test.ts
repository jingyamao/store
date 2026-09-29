import { afterEach, describe, it } from "node:test";
import { writeChapterText, writeSummary } from "../store/chapters.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { expect } from "../testing/expect.js";
import { rebuildSearchIndex, searchBook } from "./index.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

describe("全文检索", () => {
  it("索引正文和摘要，支持中文片段查找", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeChapterText(ws.paths, "ch-0001", "林渊在落霞谷捡到断岳刀，刀背有一道裂痕。");
    await writeSummary(ws.paths, "ch-0001", "林渊得到断岳刀。刀背裂痕尚未解释。");
    const count = await rebuildSearchIndex(ws.booksRoot);
    expect(count).toBeGreaterThan(1);
    const hits = await searchBook(ws.booksRoot, undefined, "断岳刀裂痕");
    expect(hits.some((hit) => hit.source === "chapters/ch-0001.md")).toBe(true);
    expect(hits.some((hit) => hit.source === "summaries/ch-0001.md")).toBe(true);
  });
});
