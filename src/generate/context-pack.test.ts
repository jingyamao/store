import { afterEach, describe, it } from "node:test";
import { BudgetConfigSchema, GenerationConfigSchema, type BudgetConfig } from "../config/index.js";
import { ChapterOutlineSchema, type ChapterOutline } from "../domain/outline.js";
import { loadBible, writeAnyCollection, type Bible } from "../store/bible.js";
import { findCollection } from "../store/collections.js";
import { expect } from "../testing/expect.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import {
  allocateBudget,
  assembleContextPack,
  describeContextPack,
  renderContextPack,
  type ContextLayer,
  type ContextPack,
  type ContextSources,
} from "./context-pack.js";
import type { ContextLayerId } from "./layers.js";

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

async function seed(ws: TestWorkspace, key: string, entities: unknown[]): Promise<void> {
  const def = findCollection(key);
  if (def === undefined) throw new Error(`未知集合：${key}`);
  await writeAnyCollection(ws.paths, def, entities as never);
}

function outline(fields: Record<string, unknown> = {}): ChapterOutline {
  return ChapterOutlineSchema.parse({ chapter: "ch-0004", ...fields });
}

function budget(overrides: Record<string, unknown> = {}): BudgetConfig {
  return BudgetConfigSchema.parse({ contextWindow: 10000, reserveForOutput: 1000, ...overrides });
}

function makeSources(bible: Bible, overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    bookId: bible.bookId,
    outline: outline(),
    styleText: "",
    masterOutlineText: "",
    bible,
    chapters: new Map(),
    summaries: new Map(),
    ...overrides,
  };
}

function packOf(sources: ContextSources, overrides: Record<string, unknown> = {}): ContextPack {
  return assembleContextPack(sources, {
    budget: budget(),
    generation: GenerationConfigSchema.parse({}),
    ...overrides,
  });
}

function layer(pack: ContextPack, id: ContextLayerId): ContextLayer {
  const found = pack.layers.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`没有这一层：${id}`);
  return found;
}

/* ── 预算分配 ─────────────────────────────────── */

describe("allocateBudget", () => {
  it("先扣掉输出预留", () => {
    const result = allocateBudget(budget({ contextWindow: 10000, reserveForOutput: 2000 }));
    expect(result.total).toBe(8000);
  });

  it("按占比切分并归一化", () => {
    const result = allocateBudget(
      budget({
        contextWindow: 1000,
        reserveForOutput: 0,
        layers: { style: 1, global: 0, entities: 0, threads: 0, recent: 0, summaries: 0 },
      }),
    );
    // 只有 style 有占比，独吞全部
    expect(result.perLayer.style).toBe(1000);
    expect(result.perLayer.entities).toBe(0);
  });

  it("占比不必凑成 1，会自动归一化", () => {
    const result = allocateBudget(
      budget({
        contextWindow: 100,
        reserveForOutput: 0,
        layers: { style: 1, global: 1, entities: 0, threads: 0, recent: 0, summaries: 0 },
      }),
    );
    expect(result.perLayer.style).toBe(50);
    expect(result.perLayer.global).toBe(50);
  });

  it("占比全为 0 时退化为均分，而不是什么都不给", () => {
    const result = allocateBudget(
      budget({
        contextWindow: 600,
        reserveForOutput: 0,
        layers: { style: 0, global: 0, entities: 0, threads: 0, recent: 0, summaries: 0 },
      }),
    );
    expect(result.perLayer.style).toBe(100);
    expect(result.perLayer.recent).toBe(100);
  });

  it("预留大于窗口时可用量为 0，不出现负数", () => {
    const result = allocateBudget(budget({ contextWindow: 1000, reserveForOutput: 5000 }));
    expect(result.total).toBe(0);
    expect(result.perLayer.style).toBe(0);
  });

  it("用 floor 而非 round，避免四舍五入后超出窗口", () => {
    const result = allocateBudget(budget({ contextWindow: 1000, reserveForOutput: 0 }));
    const sum = Object.values(result.perLayer).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(1000);
  });
});

/* ── 实体层 ───────────────────────────────────── */

describe("实体层", () => {
  it("细纲里列出的人物卡会进上下文", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist" },
      { id: "char_suwan", name: "苏晚", role: "deuteragonist" },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(makeSources(bible, { outline: outline({ cast: ["char_linyuan"] }) }));
    const entities = layer(pack, "entities");

    expect(entities.items).toHaveLength(1);
    expect(entities.items[0]?.source).toMatch("char_linyuan");
    expect(entities.items[0]?.text).toMatch("林渊");
  });

  it("自动带上人物当前所在地点与持有物", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      {
        id: "char_linyuan",
        name: "林渊",
        role: "protagonist",
        state: { location: "loc_luoxiagu", possession: ["item_duanyue"] },
      },
    ]);
    await seed(ws, "locations", [{ id: "loc_luoxiagu", name: "落霞谷" }]);
    await seed(ws, "items", [{ id: "item_duanyue", name: "断岳刀" }]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    // 细纲只说了人物，没说地点和物品
    const pack = packOf(makeSources(bible, { outline: outline({ cast: ["char_linyuan"] }) }));
    const sources = layer(pack, "entities").items.map((item) => item.source);

    expect(sources.some((s) => s.includes("loc_luoxiagu"))).toBe(true);
    expect(sources.some((s) => s.includes("item_duanyue"))).toBe(true);
  });

  it("视角人物排在主角之前（视角决定语感与信息边界）", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist" },
      { id: "char_suwan", name: "苏晚", role: "deuteragonist" },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(
      makeSources(bible, {
        outline: outline({ cast: ["char_linyuan", "char_suwan"], povCharacter: "char_suwan" }),
      }),
    );

    expect(layer(pack, "entities").items[0]?.source).toMatch("char_suwan");
  });

  it("空数组字段不会浪费 token", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist", personality: ["散漫"] },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(makeSources(bible, { outline: outline({ cast: ["char_linyuan"] }) }));
    const text = layer(pack, "entities").items[0]?.text ?? "";

    // knownSecrets / goals / injuries 都是空的，不该出现在上下文里
    expect(text.includes("knownSecrets")).toBe(false);
    expect(text.includes("goals")).toBe(false);
    expect(text.includes("散漫")).toBe(true);
  });

  it("引用了不存在的实体时安静跳过，不抛错", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(makeSources(bible, { outline: outline({ cast: ["char_ghost"] }) }));
    expect(layer(pack, "entities").items).toHaveLength(0);
  });
});

/* ── 文风层 ───────────────────────────────────── */

describe("文风层", () => {
  it("style.md 进上下文且优先级最高", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(
      makeSources(bible, {
        styleText: "冷硬克制，短句为主。",
        masterOutlineText: "全书总纲内容。",
      }),
    );

    expect(layer(pack, "style").items[0]?.source).toBe("style.md");
    expect(layer(pack, "style").items[0]?.priority).toBeGreaterThan(
      layer(pack, "global").items[0]?.priority ?? 0,
    );
  });

  it("汇总出场人物的硬性禁忌", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      {
        id: "char_linyuan",
        name: "林渊",
        role: "protagonist",
        forbidden: ["绝不会主动示弱"],
      },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(
      makeSources(bible, {
        styleText: "冷硬。",
        outline: outline({ cast: ["char_linyuan"] }),
      }),
    );

    const forbidden = layer(pack, "style").items.find((item) =>
      item.source.includes("forbidden"),
    );
    expect(forbidden?.text).toMatch("绝不会主动示弱");
    expect(forbidden?.text).toMatch("林渊");
  });
});

/* ── 伏笔层 ───────────────────────────────────── */

describe("伏笔层", () => {
  it("细纲点名的伏笔优先于环境伏笔", async () => {
    const ws = await workspace();
    await seed(ws, "threads", [
      { id: "thread_001", title: "点名要推进的", plantedAt: "ch-0001" },
      { id: "thread_002", title: "顺手带上的", plantedAt: "ch-0002" },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(
      makeSources(bible, { outline: outline({ advanceThreads: ["thread_002"] }) }),
    );
    const items = layer(pack, "threads").items;

    expect(items[0]?.source).toMatch("thread_002");
    expect(items[0]?.text).toMatch("本章需推进或回收");
  });

  it("埋得越久的伏笔优先级越高", async () => {
    const ws = await workspace();
    await seed(ws, "threads", [
      { id: "thread_001", title: "很早埋的", plantedAt: "ch-0001" },
      { id: "thread_002", title: "刚埋的", plantedAt: "ch-0003" },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(makeSources(bible));
    const items = layer(pack, "threads").items;

    const old = items.find((item) => item.source.includes("thread_001"));
    const fresh = items.find((item) => item.source.includes("thread_002"));
    expect(old?.priority ?? 0).toBeGreaterThan(fresh?.priority ?? 0);
  });

  it("已回收的伏笔不再进上下文", async () => {
    const ws = await workspace();
    await seed(ws, "threads", [
      {
        id: "thread_001",
        title: "已经回收了",
        plantedAt: "ch-0001",
        status: "resolved",
        resolvedAt: "ch-0002",
      },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    expect(layer(packOf(makeSources(bible)), "threads").items).toHaveLength(0);
  });

  it("超期伏笔会明确标注", async () => {
    const ws = await workspace();
    await seed(ws, "threads", [{ id: "thread_001", title: "拖了很久", plantedAt: "ch-0001" }]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const sources = makeSources(bible, { threadExpiryChapters: 1 });
    const item = layer(packOf(sources), "threads").items[0];

    expect(item?.text).toMatch("已明显超期");
  });
});

/* ── 近期层 ───────────────────────────────────── */

describe("近期正文层", () => {
  const chapters = new Map([
    ["ch-0001", "第一章正文"],
    ["ch-0002", "第二章正文"],
    ["ch-0003", "第三章正文"],
    ["ch-0004", "第四章正文"],
  ]);

  it("只取当前章之前的 N 章，由近及远", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = assembleContextPack(makeSources(bible, { chapters }), {
      budget: budget(),
      generation: GenerationConfigSchema.parse({ recentChapters: 2 }),
    });

    const items = layer(pack, "recent").items;
    expect(items).toHaveLength(2);
    expect(items[0]?.source).toBe("chapters/ch-0003.md");
    expect(items[1]?.source).toBe("chapters/ch-0002.md");
  });

  it("不会把当前章或未来章节放进去", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = assembleContextPack(makeSources(bible, { chapters }), {
      budget: budget(),
      generation: GenerationConfigSchema.parse({ recentChapters: 10 }),
    });

    const sources = layer(pack, "recent").items.map((item) => item.source);
    expect(sources.includes("chapters/ch-0004.md")).toBe(false);
    expect(sources).toHaveLength(3);
  });

  it("越近的章节优先级越高", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = assembleContextPack(makeSources(bible, { chapters }), {
      budget: budget(),
      generation: GenerationConfigSchema.parse({ recentChapters: 3 }),
    });

    const items = layer(pack, "recent").items;
    expect(items[0]?.priority ?? 0).toBeGreaterThan(items[1]?.priority ?? 0);
    expect(items[1]?.priority ?? 0).toBeGreaterThan(items[2]?.priority ?? 0);
  });

  it("recentChapters 为 0 时不注入正文", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = assembleContextPack(makeSources(bible, { chapters }), {
      budget: budget(),
      generation: GenerationConfigSchema.parse({ recentChapters: 0 }),
    });

    expect(layer(pack, "recent").items).toHaveLength(0);
  });
});

/* ── 摘要层 ───────────────────────────────────── */

describe("历史摘要层", () => {
  it("只取已被近期正文窗口覆盖不到的更早章节", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const summaries = new Map([
      ["ch-0001", "第一章摘要"],
      ["ch-0002", "第二章摘要"],
      ["ch-0003", "第三章摘要"],
    ]);

    const pack = assembleContextPack(makeSources(bible, { summaries }), {
      budget: budget(),
      generation: GenerationConfigSchema.parse({ recentChapters: 2 }),
    });

    // 当前是 ch-0004，recent 覆盖 ch-0003 / ch-0002，所以摘要只该剩 ch-0001
    const items = layer(pack, "summaries").items;
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe("summaries/ch-0001");
  });
});

/* ── 预算裁剪 ─────────────────────────────────── */

describe("预算裁剪", () => {
  it("预算不足时保留高优先级、丢弃低优先级", async () => {
    const ws = await workspace();
    const cameoIds = Array.from({ length: 6 }, (_, i) => `char_cameo${i}`);

    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist", personality: ["主".repeat(30)] },
      ...cameoIds.map((id, i) => ({
        id,
        name: `路人${i}`,
        role: "cameo",
        personality: [`凑${i}`.repeat(60)],
      })),
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    // 预算只够装下主角和两三个龙套，剩下的必须被丢掉
    const pack = assembleContextPack(
      makeSources(bible, {
        outline: outline({ cast: ["char_linyuan", ...cameoIds] }),
      }),
      {
        budget: budget({
          contextWindow: 400,
          reserveForOutput: 0,
          layers: { style: 0, global: 0, entities: 1, threads: 0, recent: 0, summaries: 0 },
        }),
        generation: GenerationConfigSchema.parse({}),
      },
    );

    const entities = layer(pack, "entities");
    const sources = entities.items.map((item) => item.source);

    expect(sources.some((s) => s.includes("char_linyuan"))).toBe(true);
    expect(sources.filter((s) => s.includes("char_cameo")).length).toBeLessThan(cameoIds.length);
    expect(entities.droppedItems).toBeGreaterThan(0);
  });

  it("内容超出预算时截断而不是整条丢弃", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      {
        id: "char_linyuan",
        name: "林渊",
        role: "protagonist",
        personality: Array.from({ length: 200 }, (_, i) => `性格要点${i}`),
      },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = assembleContextPack(
      makeSources(bible, { outline: outline({ cast: ["char_linyuan"] }) }),
      {
        budget: budget({
          contextWindow: 500,
          reserveForOutput: 0,
          layers: { style: 0, global: 0, entities: 1, threads: 0, recent: 0, summaries: 0 },
        }),
        generation: GenerationConfigSchema.parse({}),
      },
    );

    const entities = layer(pack, "entities");
    expect(entities.items[0]?.truncated).toBe(true);
    expect(entities.usedTokens).toBeLessThanOrEqual(entities.budgetTokens);
  });

  it("任何一层的用量都不会超过它的预算", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist", personality: ["x".repeat(500)] },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(
      makeSources(bible, {
        outline: outline({ cast: ["char_linyuan"] }),
        styleText: "风".repeat(300),
        masterOutlineText: "纲".repeat(300),
      }),
    );

    for (const entry of pack.layers) {
      expect(entry.usedTokens).toBeLessThanOrEqual(entry.budgetTokens);
    }
    expect(pack.usedTokens).toBeLessThanOrEqual(pack.budgetTokens);
  });

  it("丢弃或截断会写进 warnings，让作者知道预算不够", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      {
        id: "char_linyuan",
        name: "林渊",
        role: "protagonist",
        personality: Array.from({ length: 300 }, (_, i) => `要点${i}`),
      },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = assembleContextPack(
      makeSources(bible, {
        outline: outline({ cast: ["char_linyuan"] }),
        styleText: "文风".repeat(500),
      }),
      {
        budget: budget({
          contextWindow: 600,
          reserveForOutput: 0,
          layers: { style: 0.3, global: 0, entities: 0.3, threads: 0, recent: 0, summaries: 0.4 },
        }),
        generation: GenerationConfigSchema.parse({}),
      },
    );

    expect(pack.warnings.length).toBeGreaterThan(0);
    expect(pack.warnings.some((w) => w.includes("截断"))).toBe(true);
  });
});

/* ── 告警 ─────────────────────────────────────── */

describe("warnings", () => {
  it("style.md 为空时明确告警", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(makeSources(bible, { styleText: "   " }));
    expect(pack.warnings.some((w) => w.includes("style.md"))).toBe(true);
  });

  it("总纲为空时明确告警", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(makeSources(bible, { masterOutlineText: "" }));
    expect(pack.warnings.some((w) => w.includes("总纲"))).toBe(true);
  });

  it("都填好时没有告警", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const pack = packOf(
      makeSources(bible, { styleText: "冷硬克制。", masterOutlineText: "主角复仇。" }),
    );
    expect(pack.warnings).toEqual([]);
  });
});

/* ── 渲染与可复现 ─────────────────────────────── */

describe("renderContextPack", () => {
  it("省略空层，不留空标题", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const text = renderContextPack(
      packOf(makeSources(bible, { styleText: "冷硬克制。", masterOutlineText: "主角复仇。" })),
    );

    expect(text).toMatch("# 文风锚定");
    expect(text).toMatch("# 全局脉络");
    expect(text.includes("# 伏笔线索")).toBe(false);
    expect(text.includes("# 近期正文")).toBe(false);
  });

  it("层内条目按优先级排列", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist" },
      { id: "char_cameo", name: "路人甲", role: "cameo" },
    ]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const text = renderContextPack(
      packOf(
        makeSources(bible, { outline: outline({ cast: ["char_cameo", "char_linyuan"] }) }),
      ),
    );

    // 主角应当排在龙套前面，尽管细纲里龙套写在前面
    expect(text.indexOf("林渊")).toBeLessThan(text.indexOf("路人甲"));
  });
});

describe("可复现性", () => {
  it("同样的输入必然得到同样的 Context Pack", async () => {
    const ws = await workspace();
    await seed(ws, "characters", [
      { id: "char_linyuan", name: "林渊", role: "protagonist" },
      { id: "char_suwan", name: "苏晚", role: "deuteragonist" },
    ]);
    await seed(ws, "threads", [{ id: "thread_001", title: "伏笔", plantedAt: "ch-0001" }]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const sources = makeSources(bible, {
      outline: outline({ cast: ["char_suwan", "char_linyuan"] }),
      styleText: "冷硬。",
      masterOutlineText: "复仇。",
      chapters: new Map([
        ["ch-0002", "正文二"],
        ["ch-0003", "正文三"],
      ]),
    });

    expect(packOf(sources)).toEqual(packOf(sources));
  });

  it("describeContextPack 给出每层用量", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    const lines = describeContextPack(
      packOf(makeSources(bible, { styleText: "冷硬克制。" })),
    );

    expect(lines.length).toBe(6);
    expect(lines.some((line) => line.includes("文风锚定"))).toBe(true);
  });
});
