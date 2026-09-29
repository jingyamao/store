import { afterEach, describe, it } from "node:test";
import { writeChapterText } from "../store/chapters.js";
import { writeTextFile } from "../store/file-io.js";
import { writeCollection } from "../store/bible.js";
import { COLLECTIONS } from "../store/collections.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { expect } from "../testing/expect.js";
import { reviewChapter } from "./index.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

describe("章节体检", () => {
  it("黑名单用词可以定位到行，手写正文也能检查", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeTextFile(ws.paths.styleFile, "## AI 味黑名单\n```\n仿佛\n```\n");
    await writeChapterText(ws.paths, "ch-0001", "第一行。\n仿佛有什么人在门外。");
    const result = await reviewChapter({ booksRoot: ws.booksRoot, chapter: "ch-0001" });
    expect(result.findings.some((finding) => finding.quote === "仿佛" && finding.line === 2)).toBe(true);
    expect(result.aiUsed).toBe(false);
  });
  it("已故人物在后续章节出现时提醒作者核对", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ id: "char_lin", name: "林渊", state: { alive: false, diedAt: "ch-0001" } } as never]);
    await writeChapterText(ws.paths, "ch-0002", "林渊站在院子里。");
    const result = await reviewChapter({ booksRoot: ws.booksRoot, chapter: "ch-0002" });
    expect(result.findings.some((finding) => finding.category === "一致性" && finding.message.includes("已故人物"))).toBe(true);
  });
  it("对未登记物品持有和不成对引号给出可定位提示", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ id: "char_lin", name: "林渊" } as never]);
    await writeCollection(ws.paths, COLLECTIONS.items, [{ id: "item_blade", name: "断岳刀" } as never]);
    await writeChapterText(ws.paths, "ch-0001", "林渊握住断岳刀，推开门。“谁在那里？");
    const result = await reviewChapter({ booksRoot: ws.booksRoot, chapter: "ch-0001" });
    expect(result.findings.some((finding) => finding.message.includes("未登记持有"))).toBe(true);
    expect(result.findings.some((finding) => finding.message.includes("数量不匹配"))).toBe(true);
  });
});
