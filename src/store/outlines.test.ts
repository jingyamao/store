import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { SchemaMismatchError, writeTextFile } from "./file-io.js";
import {
  chapterOutlinePath,
  listOutlinedChapters,
  readChapterOutline,
  scaffoldChapterOutline,
  writeChapterOutline,
} from "./outlines.js";
import { captureError, expect } from "../testing/expect.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";

const opened: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createWorkspace();
  opened.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.cleanup()));
});

describe("scaffoldChapterOutline", () => {
  it("生成可用的骨架，所有列表为空", () => {
    const outline = scaffoldChapterOutline("ch-0001", "逐出宗门");

    expect(outline.chapter).toBe("ch-0001");
    expect(outline.title).toBe("逐出宗门");
    expect(outline.cast).toEqual([]);
    expect(outline.plantThreads).toEqual([]);
    expect(outline.mustInclude).toEqual([]);
    expect(outline.intent).toBe("");
  });

  it("标题可省略", () => {
    expect(scaffoldChapterOutline("ch-0001").title).toBe("");
  });

  it("拒绝非法章节 id", () => {
    expect(() => scaffoldChapterOutline("chapter-1")).toThrow();
  });
});

describe("细纲读写", () => {
  it("写入后能原样读回", async () => {
    const ws = await workspace();
    const outline = ChapterOutlineSchema.parse({
      chapter: "ch-0001",
      title: "逐出宗门",
      intent: "交代主角被逐的起因",
      conflict: "林渊被诬陷偷窃宗门灵药",
      cast: ["char_linyuan"],
      locations: ["loc_qingyunzong"],
      advanceThreads: ["thread_001"],
      mustInclude: ["断岳刀第一次出现"],
      forbidden: ["不能提前暴露苏晚的身份"],
      targetWords: 3000,
    });

    await writeChapterOutline(ws.paths, outline);
    const readBack = await readChapterOutline(ws.paths, "ch-0001");

    expect(readBack).toEqual(outline);
  });

  it("文件落在约定路径", async () => {
    const ws = await workspace();
    await writeChapterOutline(ws.paths, scaffoldChapterOutline("ch-0007"));

    expect(chapterOutlinePath(ws.paths, "ch-0007")).toBe(
      join(ws.paths.chaptersOutlineDir, "ch-0007.yaml"),
    );
    expect(await readChapterOutline(ws.paths, "ch-0007")).toBeDefined();
  });

  it("不存在时返回 undefined 而不是抛错", async () => {
    const ws = await workspace();
    expect(await readChapterOutline(ws.paths, "ch-0099")).toBeUndefined();
  });

  it("illegal 章节 id 无法写入", async () => {
    const ws = await workspace();
    const broken = { ...scaffoldChapterOutline("ch-0001"), chapter: "ch-1" };
    const error = await captureError(() => writeChapterOutline(ws.paths, broken as never));
    expect(error instanceof SchemaMismatchError).toBe(true);
  });

  it("手写的坏数据被拒绝", async () => {
    const ws = await workspace();
    await writeTextFile(chapterOutlinePath(ws.paths, "ch-0002"), "chapter: ch-0002\ncast: char_a\n");

    const error = await captureError(() => readChapterOutline(ws.paths, "ch-0002"));
    expect(error instanceof SchemaMismatchError).toBe(true);
    expect((error as SchemaMismatchError).message).toMatch("cast");
  });
});

describe("listOutlinedChapters", () => {
  it("按章节序升序返回", async () => {
    const ws = await workspace();
    for (const id of ["ch-0003", "ch-0001", "ch-0012", "ch-0002"]) {
      await writeChapterOutline(ws.paths, scaffoldChapterOutline(id));
    }
    expect(await listOutlinedChapters(ws.paths)).toEqual([
      "ch-0001",
      "ch-0002",
      "ch-0003",
      "ch-0012",
    ]);
  });

  it("没有任何细纲时返回空数组", async () => {
    const ws = await workspace();
    expect(await listOutlinedChapters(ws.paths)).toEqual([]);
  });
});
