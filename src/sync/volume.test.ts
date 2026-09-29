import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../config/index.js";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { generateChapter } from "../generate/run.js";
import { MockProvider } from "../llm/mock.js";
import { writeChapterText, writeSummary } from "../store/chapters.js";
import { writeChapterOutline } from "../store/outlines.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { expect } from "../testing/expect.js";
import { adoptVolumeSummary, proposeVolumeSummary } from "./volume.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

describe("卷摘要", () => {
  it("从所属章节摘要提案，人工采用后进入后续章节上下文", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({ chapter: "ch-0001", volume: "vol-01" }));
    await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({ chapter: "ch-0002", volume: "vol-02" }));
    await writeChapterText(ws.paths, "ch-0001", "林渊得到一把刀。");
    await writeSummary(ws.paths, "ch-0001", "林渊得到断岳刀，刀背裂痕未解。");
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: ["林渊得刀，裂痕谜题仍待揭开。"] });
    const proposal = await proposeVolumeSummary({ booksRoot: ws.booksRoot, volume: "vol-01", config, provider });
    expect(proposal.applied).toBe(false);
    await adoptVolumeSummary(ws.paths, "vol-01");
    const run = await generateChapter({ booksRoot: ws.booksRoot, chapterId: "ch-0002", config, dryRun: true });
    expect(run.contextPack.layers.some((layer) => layer.items.some((item) => item.source === "summaries/vol-01.md"))).toBe(true);
  });

  it("长卷分批读取所有章节摘要，不遗漏靠后的章节", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    for (const [chapter, marker] of [["ch-0001", "卷首线索"], ["ch-0002", "卷末真相"]] as const) {
      await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({ chapter, volume: "vol-01" }));
      await writeSummary(ws.paths, chapter, `${marker}${"情节进展。".repeat(2600)}`);
    }
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ handler: () => "这一段的关键情节已记录。" });
    const proposal = await proposeVolumeSummary({ booksRoot: ws.booksRoot, volume: "vol-01", config, provider });
    const prompts = provider.calls.map((call) => call.messages.map((message) => message.content).join("\n")).join("\n");
    expect(provider.calls.length).toBe(3);
    expect(prompts).toMatch("卷首线索");
    expect(prompts).toMatch("卷末真相");
    expect(proposal.chapters).toHaveLength(2);
  });
});
