import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig, writeDefaultConfig } from "../config/index.js";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { MockProvider } from "../llm/mock.js";
import { writeAnyCollection } from "../store/bible.js";
import { findCollection } from "../store/collections.js";
import { writeTextFile } from "../store/file-io.js";
import { scaffoldChapterOutline, writeChapterOutline } from "../store/outlines.js";
import { captureError, expect, expectRejects } from "../testing/expect.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { checkDraft, generateChapter, listRuns, type RunRecord } from "./run.js";

const opened: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createWorkspace();
  opened.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.cleanup()));
});

/* ── 辅助 ─────────────────────────────────────── */

const STYLE = [
  "# 文风锚定",
  "",
  "冷硬克制，短句为主，情绪不直说。",
  "",
  "## 七、自定义 AI 味黑名单",
  "```",
  "仿佛",
  "不禁",
  "```",
  "",
].join("\n");

const OPENINGS_TEXT = [
  "===方案1===",
  "刀锋擦过耳侧，带起一线血珠。",
  "===方案2===",
  "苏晚站在谷口，看了他很久。",
  "===方案3===",
  "三天前，他还不知道落霞谷在哪。",
].join("\n");

async function seedBook(ws: TestWorkspace, options: { outline?: boolean } = {}): Promise<void> {
  const withOutline = options.outline !== false;

  const characters = findCollection("characters");
  if (characters === undefined) throw new Error("缺少 characters 集合");

  await writeAnyCollection(ws.paths, characters, [
    {
      id: "char_linyuan",
      name: "林渊",
      role: "protagonist",
      firstAppearance: "ch-0001",
    } as never,
  ]);

  await writeTextFile(ws.paths.styleFile, STYLE);
  await writeTextFile(ws.paths.masterOutlineFile, "# 全书总纲\n\n主角复仇。");

  if (withOutline) {
    await writeChapterOutline(
      ws.paths,
      ChapterOutlineSchema.parse({
        chapter: "ch-0004",
        title: "落霞谷",
        intent: "林渊遇见苏晚",
        cast: ["char_linyuan"],
      }),
    );
  }
}

function mockProvider(): MockProvider {
  return new MockProvider({ responses: [OPENINGS_TEXT, "林渊走进山谷。风很冷。"] });
}

async function runOnce(
  ws: TestWorkspace,
  overrides: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<typeof generateChapter>>> {
  const config = await loadConfig(ws.root);
  return generateChapter({
    booksRoot: ws.booksRoot,
    chapterId: "ch-0004",
    config,
    provider: mockProvider(),
    ...overrides,
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/* ── dry-run ──────────────────────────────────── */

describe("--dry-run", () => {
  it("不调用模型，只落盘上下文", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const mock = mockProvider();
    const config = await loadConfig(ws.root);
    const result = await generateChapter({
      booksRoot: ws.booksRoot,
      chapterId: "ch-0004",
      config,
      provider: mock,
      dryRun: true,
    });

    expect(mock.calls).toHaveLength(0);
    expect(result.draft).toBeUndefined();
    expect(existsSync(join(result.runDir, "context.json"))).toBe(true);
    expect(existsSync(join(result.runDir, "prompt.txt"))).toBe(false);
    expect(result.record.dryRun).toBe(true);
  });

  it("不需要 API Key（生成之外的功能保持零配置可用）", async () => {
    const ws = await workspace();
    await seedBook(ws);

    // 没有配置任何密钥，且不注入 provider
    const config = await loadConfig(ws.root);
    expect(config.apiKey).toBeUndefined();

    const result = await generateChapter({
      booksRoot: ws.booksRoot,
      chapterId: "ch-0004",
      config,
      dryRun: true,
    });
    expect(result.record.dryRun).toBe(true);
  });

  it("上下文记录里能看到每层用了多少、来源是什么", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const result = await runOnce(ws, { dryRun: true });
    const layers = result.record.context.layers;

    expect(layers.length).toBe(6);
    const style = layers.find((layer) => layer.id === "style");
    expect(style?.sources.includes("style.md")).toBe(true);

    const entities = layers.find((layer) => layer.id === "entities");
    expect(entities?.sources.some((s) => s.includes("char_linyuan"))).toBe(true);
  });
});

/* ── 完整生成 ─────────────────────────────────── */

describe("完整生成", () => {
  it("留下完整的 runs 记录", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const result = await runOnce(ws);

    for (const file of ["context.json", "prompt-openings.txt", "prompt.txt", "openings.md", "draft.md", "run.json"]) {
      expect(existsSync(join(result.runDir, file))).toBe(true);
    }
  });

  it("解析出开篇并按选择续写", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const result = await runOnce(ws, { pick: 2 });

    expect(result.openings).toHaveLength(3);
    expect(result.pickedOpening).toBe("苏晚站在谷口，看了他很久。");

    const draftPrompt = readFileSync(join(result.runDir, "prompt.txt"), "utf8");
    expect(draftPrompt).toMatch("苏晚站在谷口，看了他很久。");
  });

  it("默认不写入 chapters/（人把关关键节点）", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const result = await runOnce(ws);

    expect(result.draft).toBe("林渊走进山谷。风很冷。");
    expect(result.outputFile).toBeUndefined();
    expect(existsSync(join(ws.paths.chaptersDir, "ch-0004.md"))).toBe(false);
  });

  it("记录里带上用量与阶段耗时", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const record = (await runOnce(ws)).record as RunRecord;

    expect(record.stages).toHaveLength(2);
    expect(record.stages[0]?.name).toBe("openings");
    expect(record.stages[1]?.name).toBe("draft");
    expect(record.usage.completionTokens).toBeGreaterThan(0);
    expect(record.model).toBe("mock-model");
  });

  it("两次生成不会互相覆盖", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const fixedClock = (): Date => new Date("2025-01-01T12:00:00");
    const first = await runOnce(ws, { now: fixedClock });
    const second = await runOnce(ws, { now: fixedClock });

    expect(first.runDir === second.runDir).toBe(false);
    expect(existsSync(first.runDir)).toBe(true);
    expect(existsSync(second.runDir)).toBe(true);
  });

  it("runs 目录名带章节号，便于翻找", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const result = await runOnce(ws);
    expect(/\d{8}-\d{6}-ch-0004$/.test(result.runDir)).toBe(true);
  });
});

/* ── 落盘 ─────────────────────────────────────── */

describe("--apply", () => {
  it("显式要求时才写入 chapters/", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const result = await runOnce(ws, { apply: true });

    expect(result.outputFile).toBeDefined();
    expect(readFileSync(join(ws.paths.chaptersDir, "ch-0004.md"), "utf8")).toMatch(
      "林渊走进山谷",
    );
    expect(result.record.applied).toBe(true);
  });

  it("拒绝覆盖已有内容，并告知初稿存在哪里", async () => {
    const ws = await workspace();
    await seedBook(ws);
    await writeTextFile(join(ws.paths.chaptersDir, "ch-0004.md"), "我自己写的内容");

    const error = await captureError(() => runOnce(ws, { apply: true }));
    expect(String(error)).toMatch("拒绝覆盖");
    expect(String(error)).toMatch("draft.md");
  });

  it("--force 才覆盖", async () => {
    const ws = await workspace();
    await seedBook(ws);
    await writeTextFile(join(ws.paths.chaptersDir, "ch-0004.md"), "我自己写的内容");

    await runOnce(ws, { apply: true, force: true });
    expect(readFileSync(join(ws.paths.chaptersDir, "ch-0004.md"), "utf8")).toMatch(
      "林渊走进山谷",
    );
  });

  it("与 --dry-run 同时使用会明确报错", async () => {
    const ws = await workspace();
    await seedBook(ws);

    await expectRejects(() => runOnce(ws, { apply: true, dryRun: true }));
  });
});

/* ── 错误路径 ─────────────────────────────────── */

describe("错误路径", () => {
  it("没有细纲时给出下一步命令", async () => {
    const ws = await workspace();
    await seedBook(ws, { outline: false });

    const error = await captureError(() => runOnce(ws));
    expect(String(error)).toMatch("还没有细纲");
    expect(String(error)).toMatch("novel plan new ch-0004");
  });

  it("没有 API Key 时给出三种解决方式", async () => {
    const ws = await workspace();
    await seedBook(ws);
    await writeDefaultConfig(ws.root);

    const config = await loadConfig(ws.root);
    const error = await captureError(() =>
      generateChapter({
        booksRoot: ws.booksRoot,
        chapterId: "ch-0004",
        config,
        // 不注入 provider，走 createProvider
      }),
    );

    expect(String(error)).toMatch("没有找到模型 API Key");
    expect(String(error)).toMatch("--dry-run");
  });
});

/* ── 初稿自检 ─────────────────────────────────── */

describe("checkDraft", () => {
  const base = { targetWords: 100, blacklist: ["仿佛"], castNames: ["林渊"] };

  it("命中黑名单词报 error", () => {
    const findings = checkDraft("林渊仿佛看见了什么。", base);
    const hit = findings.find((f) => f.level === "error");
    expect(hit?.message).toMatch("仿佛");
  });

  it("字数明显不足时警告（多半被截断）", () => {
    const findings = checkDraft("太短了。", base);
    expect(findings.some((f) => f.message.includes("明显短于目标"))).toBe(true);
  });

  it("字数超出较多时只提示", () => {
    const long = "字".repeat(300);
    const findings = checkDraft(long, base);
    expect(findings.some((f) => f.level === "info" && f.message.includes("超出目标"))).toBe(true);
  });

  it("细纲列了但正文没出现的人物会被点出", () => {
    const findings = checkDraft("苏晚走了过来。", base);
    expect(findings.some((f) => f.message.includes("没出现的人物"))).toBe(true);
    expect(findings.some((f) => f.message.includes("林渊"))).toBe(true);
  });

  it("正文里出现 Markdown 标记会被提示", () => {
    const findings = checkDraft("## 第四章\n\n" + "字".repeat(120), base);
    expect(findings.some((f) => f.message.includes("Markdown"))).toBe(true);
  });

  it("干净的初稿没有任何发现", () => {
    const clean = "林渊走进山谷，风很冷。他握紧了断岳刀，刀身那道裂痕又深了一分。";
    // 31 字，目标 30 字 —— 落在 ±15% 容差内
    expect(checkDraft(clean, { ...base, targetWords: 30 })).toEqual([]);
  });

  it("自检结果写进 runs 记录", async () => {
    const ws = await workspace();
    await seedBook(ws);

    const mock = new MockProvider({
      responses: [OPENINGS_TEXT, "林渊仿佛听见了什么。"],
    });
    const config = await loadConfig(ws.root);
    const result = await generateChapter({
      booksRoot: ws.booksRoot,
      chapterId: "ch-0004",
      config,
      provider: mock,
    });

    expect(result.record.draftCheck.some((f) => f.level === "error")).toBe(true);
    const saved = readJson<RunRecord>(join(result.runDir, "run.json"));
    expect(saved.draftCheck.length).toBeGreaterThan(0);
  });
});

/* ── 历史记录 ─────────────────────────────────── */

describe("listRuns", () => {
  it("列出历史生成，最新的在前", async () => {
    const ws = await workspace();
    await seedBook(ws);

    await runOnce(ws, { now: () => new Date("2025-01-01T10:00:00") });
    await runOnce(ws, { now: () => new Date("2025-01-02T10:00:00") });

    const runs = await listRuns(ws.paths);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.runId).toMatch(/^20250102/);
    expect(runs[0]?.chapterId).toBe("ch-0004");
  });

  it("没有记录时返回空数组", async () => {
    const ws = await workspace();
    expect(await listRuns(ws.paths)).toEqual([]);
  });

  it("记录损坏时跳过它而不是整体失败", async () => {
    const ws = await workspace();
    await seedBook(ws);
    await runOnce(ws);

    await writeTextFile(join(ws.paths.runsDir, "坏记录", "run.json"), "{ 不是 JSON");
    expect(await listRuns(ws.paths)).toHaveLength(1);
  });
});
