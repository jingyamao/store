import { describe, it } from "node:test";
import { expect } from "../testing/expect.js";
import { scaffoldSummary } from "../domain/summary.js";
import { writeChapterText, writeSummary } from "./chapters.js";
import { loadProgress } from "./progress.js";
import { scaffoldChapterOutline, writeChapterOutline } from "./outlines.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";

function setup(): Promise<TestWorkspace> {
  return createWorkspace("progress-demo");
}

describe("loadProgress", () => {
  it("空书返回空结果", async () => {
    const ws = await setup();
    const progress = await loadProgress(ws.paths);

    expect(progress.chapters).toHaveLength(0);
    expect(progress.totalWords).toBe(0);
    expect(progress.writtenChapters).toBe(0);
    expect(progress.missingSummaries).toHaveLength(0);
  });

  it("列出只有细纲的章节，并标记没有正文", async () => {
    const ws = await setup();
    await writeChapterOutline(ws.paths, scaffoldChapterOutline("ch-0001", "逐出宗门"));

    const progress = await loadProgress(ws.paths);
    const chapter = progress.chapters[0];

    expect(progress.chapters).toHaveLength(1);
    expect(chapter?.hasOutline).toBe(true);
    expect(chapter?.hasText).toBe(false);
    expect(chapter?.title).toBe("逐出宗门");
    expect(progress.missingSummaries).toHaveLength(0);
  });

  it("统计字数（中文口径，不数 ASCII）", async () => {
    const ws = await setup();
    await writeChapterText(ws.paths, "ch-0001", "林渊握紧断岳刀。");

    const progress = await loadProgress(ws.paths);
    // 7 个汉字 + 1 个句号，标点按平台口径也算字数
    expect(progress.chapters[0]?.words).toBe(8);
    expect(progress.totalWords).toBe(8);
  });

  it("ASCII 不计入字数 —— 中文小说的字数就是汉字数", async () => {
    const ws = await setup();
    await writeChapterText(ws.paths, "ch-0001", "他说 OK 就走了。");

    const progress = await loadProgress(ws.paths);
    // 他说 + 就走了 + 句号 = 6；空格与 "OK" 都不算
    expect(progress.chapters[0]?.words).toBe(6);
  });

  it("有正文没摘要时记进 missingSummaries —— 长程记忆的漏洞", async () => {
    const ws = await setup();
    await writeChapterText(ws.paths, "ch-0001", "林渊握紧断岳刀。");
    await writeChapterText(ws.paths, "ch-0002", "苏晚没有说话。");

    const progress = await loadProgress(ws.paths);
    expect(progress.missingSummaries).toEqual(["ch-0001", "ch-0002"]);
    expect(progress.writtenChapters).toBe(2);
  });

  it("只有摘要骨架不算覆盖", async () => {
    const ws = await setup();
    await writeChapterText(ws.paths, "ch-0001", "林渊握紧断岳刀。");
    await writeSummary(ws.paths, "ch-0001", scaffoldSummary("逐出宗门"));

    const progress = await loadProgress(ws.paths);
    const chapter = progress.chapters[0];

    expect(chapter?.hasSummary).toBe(false);
    expect(chapter?.summaryIsPlaceholder).toBe(true);
    expect(progress.missingSummaries).toEqual(["ch-0001"]);
  });

  it("填了内容就算覆盖", async () => {
    const ws = await setup();
    await writeChapterText(ws.paths, "ch-0001", "林渊握紧断岳刀。");
    await writeSummary(ws.paths, "ch-0001", "### 情节\n林渊被逐出宗门。");

    const progress = await loadProgress(ws.paths);
    const chapter = progress.chapters[0];

    expect(chapter?.hasSummary).toBe(true);
    expect(chapter?.summaryIsPlaceholder).toBe(false);
    expect(progress.missingSummaries).toHaveLength(0);
  });

  it("有正文没细纲时记进 orphans", async () => {
    const ws = await setup();
    await writeChapterOutline(ws.paths, scaffoldChapterOutline("ch-0001", "有细纲"));
    await writeChapterText(ws.paths, "ch-0001", "第一章正文。");
    await writeChapterText(ws.paths, "ch-0002", "第二章正文。");

    const progress = await loadProgress(ws.paths);
    expect(progress.orphans).toEqual(["ch-0002"]);
    expect(progress.writtenChapters).toBe(2);
    expect(progress.outlinedChapters).toBe(1);
  });

  it("三份数据按章节号合并去重并排序", async () => {
    const ws = await setup();
    // 只有摘要：ch-0003
    await writeSummary(ws.paths, "ch-0003", "### 情节\n有摘要。");
    // 只有细纲：ch-0001
    await writeChapterOutline(ws.paths, scaffoldChapterOutline("ch-0001", "一"));
    // 只有正文：ch-0002
    await writeChapterText(ws.paths, "ch-0002", "第二章正文。");

    const progress = await loadProgress(ws.paths);
    expect(progress.chapters.map((chapter) => chapter.id)).toEqual([
      "ch-0001",
      "ch-0002",
      "ch-0003",
    ]);
  });

  it("超过 9999 章时排序仍然正确（章节号是数字而非字符串）", async () => {
    const ws = await setup();
    await writeChapterText(ws.paths, "ch-10000", "很长的一章。");
    await writeChapterText(ws.paths, "ch-9999", "短一章。");

    const progress = await loadProgress(ws.paths);
    expect(progress.chapters.map((chapter) => chapter.id)).toEqual(["ch-9999", "ch-10000"]);
  });

  it("细纲里的目标字数会带出来", async () => {
    const ws = await setup();
    const outline = { ...scaffoldChapterOutline("ch-0001", "逐出宗门"), targetWords: 3000 };
    await writeChapterOutline(ws.paths, outline);
    await writeChapterText(ws.paths, "ch-0001", "正文。");

    const progress = await loadProgress(ws.paths);
    expect(progress.chapters[0]?.targetWords).toBe(3000);
  });
});
