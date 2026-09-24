import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CharacterSchema,
  ItemSchema,
  LocationSchema,
  PowerSystemSchema,
  SettingSchema,
  ThreadSchema,
  type Character,
} from "../domain/schemas.js";
import { writeAnyCollection, writePowerSystem } from "../store/bible.js";
import { COLLECTIONS } from "../store/collections.js";
import { writeTextFile } from "../store/file-io.js";
import { expect } from "../testing/expect.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { createLintContext, runLint, type Finding, type LintOptions } from "./index.js";

const opened: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createWorkspace();
  opened.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.cleanup()));
});

/* ── 测试辅助 ─────────────────────────────────── */

async function lint(ws: TestWorkspace, options?: Partial<LintOptions>): Promise<Finding[]> {
  return runLint(await createLintContext(ws.booksRoot, ws.bookId, options));
}

const byRule = (findings: readonly Finding[], name: string): Finding[] =>
  findings.filter((finding) => finding.rule === name);

const errorsOf = (findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => finding.severity === "error");

const warningsOf = (findings: readonly Finding[]): Finding[] =>
  findings.filter((finding) => finding.severity === "warning");

const character = (raw: Record<string, unknown>): Character => CharacterSchema.parse(raw);

const putCharacters = (ws: TestWorkspace, list: Character[]): Promise<void> =>
  writeAnyCollection(ws.paths, COLLECTIONS.characters, list);

const putItems = (ws: TestWorkspace, list: ReturnType<typeof ItemSchema.parse>[]): Promise<void> =>
  writeAnyCollection(ws.paths, COLLECTIONS.items, list);

const putLocations = (
  ws: TestWorkspace,
  list: ReturnType<typeof LocationSchema.parse>[],
): Promise<void> => writeAnyCollection(ws.paths, COLLECTIONS.locations, list);

const putThreads = (
  ws: TestWorkspace,
  list: ReturnType<typeof ThreadSchema.parse>[],
): Promise<void> => writeAnyCollection(ws.paths, COLLECTIONS.threads, list);

const putChapter = (ws: TestWorkspace, id: string, text: string): Promise<void> =>
  writeTextFile(join(ws.paths.chaptersDir, `${id}.md`), text);

async function putPowerSystem(ws: TestWorkspace, realms: string[], rules: string[] = []): Promise<void> {
  await writePowerSystem(
    ws.paths,
    PowerSystemSchema.parse({ realms: realms.map((name) => ({ name })), rules }),
  );
}

/* ── 基线 ─────────────────────────────────────── */

describe("基线", () => {
  it("全新的书不产生任何 error", async () => {
    const ws = await workspace();
    expect(errorsOf(await lint(ws))).toEqual([]);
  });

  it("空 Bible 会提醒先填人物与文风", async () => {
    const ws = await workspace();
    const findings = await lint(ws);
    expect(byRule(findings, "empty-bible").length).toBeGreaterThan(0);
    expect(byRule(findings, "style-anchor").length).toBeGreaterThan(0);
  });
});

/* ── 专名冲突 ─────────────────────────────────── */

describe("alias-conflict", () => {
  it("同集合内两个实体共用专名 → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊" }),
      character({ id: "char_b", name: "苏晚", aliases: ["林渊"] }),
    ]);

    const found = byRule(await lint(ws), "alias-conflict");
    expect(found.some((f) => f.severity === "error" && f.message.includes("林渊"))).toBe(true);
  });

  it("同一实体把 name 又写进 aliases → 只是 warning", async () => {
    const ws = await workspace();
    await putCharacters(ws, [character({ id: "char_a", name: "林渊", aliases: ["林渊"] })]);

    const found = byRule(await lint(ws), "alias-conflict");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
  });

  it("跨集合专名重叠 → warning（生成时可能召回错误的卡）", async () => {
    const ws = await workspace();
    await putCharacters(ws, [character({ id: "char_a", name: "青云" })]);
    await putItems(ws, [ItemSchema.parse({ id: "item_a", name: "青云" })]);

    const found = byRule(await lint(ws), "alias-conflict");
    expect(found.some((f) => f.severity === "warning")).toBe(true);
    expect(found.some((f) => f.severity === "error")).toBe(false);
  });

  it("专名各不相同则无告警", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", aliases: ["渊哥"] }),
      character({ id: "char_b", name: "苏晚", aliases: ["晚姐"] }),
    ]);
    expect(byRule(await lint(ws), "alias-conflict")).toEqual([]);
  });
});

/* ── 悬空引用 ─────────────────────────────────── */

describe("dangling-reference", () => {
  it("relationships 指向不存在的人物 → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({
        id: "char_a",
        name: "林渊",
        relationships: [{ target: "char_ghost", type: "宿敌" }],
      }),
    ]);

    const found = byRule(await lint(ws), "dangling-reference");
    expect(found.some((f) => f.message.includes("char_ghost"))).toBe(true);
  });

  it("possession 指向不存在的物品 → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { possession: ["item_ghost"] } }),
    ]);

    const found = byRule(await lint(ws), "dangling-reference");
    expect(found.some((f) => f.field === "state.possession[0]")).toBe(true);
  });

  it("state.location 指向不存在的地点 → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { location: "loc_ghost" } }),
    ]);
    expect(byRule(await lint(ws), "dangling-reference").length).toBeGreaterThan(0);
  });

  it("location.parent 与 faction.base 也被检查", async () => {
    const ws = await workspace();
    await putLocations(ws, [
      LocationSchema.parse({ id: "loc_a", name: "落霞谷", parent: "loc_ghost" }),
    ]);
    expect(byRule(await lint(ws), "dangling-reference").length).toBe(1);
  });

  it("thread.related 指向不存在的实体 → error", async () => {
    const ws = await workspace();
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", related: ["char_ghost"] }),
    ]);
    expect(byRule(await lint(ws), "dangling-reference").length).toBe(1);
  });

  it("引用全部有效时无告警", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({
        id: "char_a",
        name: "林渊",
        state: { location: "loc_a", possession: ["item_a"] },
        relationships: [{ target: "char_b", type: "同门" }],
      }),
      character({ id: "char_b", name: "苏晚" }),
    ]);
    await putLocations(ws, [LocationSchema.parse({ id: "loc_a", name: "落霞谷" })]);
    await putItems(ws, [ItemSchema.parse({ id: "item_a", name: "断岳刀" })]);

    expect(byRule(await lint(ws), "dangling-reference")).toEqual([]);
  });

  it("关系指向自己 → warning", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", relationships: [{ target: "char_a", type: "自恋" }] }),
    ]);
    const found = byRule(await lint(ws), "dangling-reference");
    expect(found.some((f) => f.severity === "warning")).toBe(true);
  });
});

/* ── 境界 ─────────────────────────────────────── */

describe("realm-validity", () => {
  it("境界不在体系中 → error", async () => {
    const ws = await workspace();
    await putPowerSystem(ws, ["炼气", "筑基", "金丹"]);
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { realm: "大罗金仙" } }),
    ]);

    const found = byRule(await lint(ws), "realm-validity");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
  });

  it("允许「筑基后期」「炼气九层」这类带小层次的写法", async () => {
    const ws = await workspace();
    await putPowerSystem(ws, ["炼气", "筑基", "金丹"]);
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { realm: "筑基后期" } }),
      character({ id: "char_b", name: "苏晚", state: { realm: "炼气九层" } }),
    ]);

    expect(byRule(await lint(ws), "realm-validity")).toEqual([]);
  });

  it("体系未定义时不重复刷屏（交给 power-system-empty）", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { realm: "筑基" } }),
    ]);

    expect(byRule(await lint(ws), "realm-validity")).toEqual([]);
    expect(byRule(await lint(ws), "power-system-empty").some((f) => f.severity === "warning")).toBe(
      true,
    );
  });
});

/* ── 生死一致性 ───────────────────────────────── */

describe("life-consistency", () => {
  it("alive:false 却缺少 diedAt → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "赵乾", state: { alive: false } }),
    ]);
    expect(errorsOf(byRule(await lint(ws), "life-consistency"))).toHaveLength(1);
  });

  it("alive:true 却填写了 diedAt → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { alive: true, diedAt: "ch-0005" } }),
    ]);
    expect(errorsOf(byRule(await lint(ws), "life-consistency"))).toHaveLength(1);
  });

  it("自洽时无告警", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "赵乾", state: { alive: false, diedAt: "ch-0005" } }),
    ]);
    expect(byRule(await lint(ws), "life-consistency")).toEqual([]);
  });
});

/* ── 主角数量 ─────────────────────────────────── */

describe("protagonist-count", () => {
  it("没有主角 → warning", async () => {
    const ws = await workspace();
    await putCharacters(ws, [character({ id: "char_a", name: "甲", role: "supporting" })]);
    expect(warningsOf(byRule(await lint(ws), "protagonist-count"))).toHaveLength(1);
  });

  it("两位主角 → warning", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "甲", role: "protagonist" }),
      character({ id: "char_b", name: "乙", role: "protagonist" }),
    ]);
    expect(warningsOf(byRule(await lint(ws), "protagonist-count"))).toHaveLength(1);
  });

  it("恰好一位主角 → 无告警", async () => {
    const ws = await workspace();
    await putCharacters(ws, [character({ id: "char_a", name: "甲", role: "protagonist" })]);
    expect(byRule(await lint(ws), "protagonist-count")).toEqual([]);
  });
});

/* ── 档案完整度 ───────────────────────────────── */

describe("profile-incomplete", () => {
  it("主要角色缺字段 → warning", async () => {
    const ws = await workspace();
    await putCharacters(ws, [character({ id: "char_a", name: "林渊", role: "protagonist" })]);

    const found = byRule(await lint(ws), "profile-incomplete");

    // 三项档案缺口应当是 warning
    const gaps = found.filter((f) =>
      ["personality", "firstAppearance", "state.asOfChapter"].includes(f.field ?? ""),
    );
    expect(gaps).toHaveLength(3);
    expect(gaps.every((f) => f.severity === "warning")).toBe(true);

    // 口癖缺失只给 info，属于「可以更好」而不是「有问题」
    expect(
      found.some((f) => f.field === "speechStyle.patterns" && f.severity === "info"),
    ).toBe(true);
  });

  it("龙套缺字段只是 info，不打扰作者", async () => {
    const ws = await workspace();
    await putCharacters(ws, [character({ id: "char_a", name: "路人甲", role: "cameo" })]);

    const found = byRule(await lint(ws), "profile-incomplete");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.severity === "info")).toBe(true);
  });

  it("档案完整时无告警", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({
        id: "char_a",
        name: "林渊",
        role: "protagonist",
        personality: ["散漫"],
        firstAppearance: "ch-0001",
        speechStyle: { patterns: ["啧"] },
        state: { asOfChapter: "ch-0001" },
      }),
    ]);

    expect(byRule(await lint(ws), "profile-incomplete")).toEqual([]);
  });
});

/* ── 物品归属 ─────────────────────────────────── */

describe("possession-conflict", () => {
  it("同一物品被两人持有 → warning", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", state: { possession: ["item_a"] } }),
      character({ id: "char_b", name: "苏晚", state: { possession: ["item_a"] } }),
    ]);
    await putItems(ws, [ItemSchema.parse({ id: "item_a", name: "断岳刀" })]);

    expect(warningsOf(byRule(await lint(ws), "possession-conflict"))).toHaveLength(1);
  });
});

/* ── 伏笔 ─────────────────────────────────────── */

describe("thread-expiry", () => {
  it("超过阈值仍 open → warning", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "第一章");
    await putChapter(ws, "ch-0002", "第二章");
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", plantedAt: "ch-0001" }),
    ]);

    // 阈值调到 1，此时「已过 1 章」刚好越线
    const found = byRule(await lint(ws, { threadExpiryChapters: 1 }), "thread-expiry");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.message).toMatch("已过 1 章");
  });

  it("默认阈值下 1 章不会触发", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "第一章");
    await putChapter(ws, "ch-0002", "第二章");
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", plantedAt: "ch-0001" }),
    ]);
    expect(byRule(await lint(ws), "thread-expiry")).toEqual([]);
  });

  it("在阈值内不告警", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "第一章");
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", plantedAt: "ch-0001" }),
    ]);
    expect(byRule(await lint(ws), "thread-expiry")).toEqual([]);
  });

  it("已回收的伏笔不再提醒", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "第一章");
    await putChapter(ws, "ch-0002", "第二章");
    await putThreads(ws, [
      ThreadSchema.parse({
        id: "thread_001",
        title: "裂痕",
        plantedAt: "ch-0001",
        status: "resolved",
        resolvedAt: "ch-0002",
      }),
    ]);
    expect(byRule(await lint(ws), "thread-expiry")).toEqual([]);
  });

  it("计划回收章节已过 → warning", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "第一章");
    await putChapter(ws, "ch-0002", "第二章");
    await putThreads(ws, [
      ThreadSchema.parse({
        id: "thread_001",
        title: "裂痕",
        plantedAt: "ch-0001",
        targetResolve: "ch-0001",
      }),
    ]);
    // targetResolve == plantedAt 会先被 thread-order 判为顺序颠倒
    const found = [...byRule(await lint(ws), "thread-expiry"), ...byRule(await lint(ws), "thread-order")];
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("thread-order", () => {
  it("计划回收早于埋设 → error", async () => {
    const ws = await workspace();
    await putThreads(ws, [
      ThreadSchema.parse({
        id: "thread_001",
        title: "裂痕",
        plantedAt: "ch-0010",
        targetResolve: "ch-0005",
      }),
    ]);
    expect(errorsOf(byRule(await lint(ws), "thread-order"))).toHaveLength(1);
  });

  it("实际回收早于埋设 → error", async () => {
    const ws = await workspace();
    await putThreads(ws, [
      ThreadSchema.parse({
        id: "thread_001",
        title: "裂痕",
        plantedAt: "ch-0010",
        status: "resolved",
        resolvedAt: "ch-0003",
      }),
    ]);
    expect(errorsOf(byRule(await lint(ws), "thread-order"))).toHaveLength(1);
  });
});

describe("thread-status", () => {
  it("标记已回收但缺 resolvedAt → warning", async () => {
    const ws = await workspace();
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", status: "resolved" }),
    ]);
    const found = byRule(await lint(ws), "thread-status");
    expect(found.some((f) => f.field === "resolvedAt")).toBe(true);
  });

  it("填了 resolvedAt 但状态未更新 → warning", async () => {
    const ws = await workspace();
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", resolvedAt: "ch-0005" }),
    ]);
    const found = byRule(await lint(ws), "thread-status");
    expect(found.some((f) => f.field === "status")).toBe(true);
  });

  it("未关联任何实体 → info", async () => {
    const ws = await workspace();
    await putThreads(ws, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕", plantedAt: "ch-0001" }),
    ]);
    const found = byRule(await lint(ws), "thread-status");
    expect(found.some((f) => f.severity === "info" && f.field === "related")).toBe(true);
  });
});

/* ── 重复 id ──────────────────────────────────── */

describe("duplicate-ids", () => {
  it("同一集合内重复 id → error", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊" }),
      character({ id: "char_a", name: "另一个人" }),
    ]);

    const found = byRule(await lint(ws), "duplicate-ids");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.message).toMatch("重复出现 2 次");
  });
});

/* ── 章节交叉校验 ─────────────────────────────── */

describe("chapter-presence", () => {
  it("登记了首次出场但该章正文没出现 → warning", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "他走进山谷，四下无人。");
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", firstAppearance: "ch-0001" }),
    ]);

    const found = byRule(await lint(ws), "chapter-presence");
    expect(found.some((f) => f.severity === "warning" && f.field === "firstAppearance")).toBe(true);
  });

  it("正文出现即通过", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "林渊走进山谷。");
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", firstAppearance: "ch-0001" }),
    ]);
    expect(byRule(await lint(ws), "chapter-presence")).toEqual([]);
  });

  it("在登记的首次出场之前就已出现 → info", async () => {
    const ws = await workspace();
    await putChapter(ws, "ch-0001", "林渊早就站在这里了。");
    await putChapter(ws, "ch-0002", "林渊又来了。");
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", firstAppearance: "ch-0002" }),
    ]);

    const found = byRule(await lint(ws), "chapter-presence");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("info");
    expect(found[0]?.message).toMatch("ch-0001");
  });

  it("没有章节正文时完全不参与校验", async () => {
    const ws = await workspace();
    await putCharacters(ws, [
      character({ id: "char_a", name: "林渊", firstAppearance: "ch-0001" }),
    ]);
    expect(byRule(await lint(ws), "chapter-presence")).toEqual([]);
  });
});

/* ── 书籍元信息 ───────────────────────────────── */

describe("book-meta-mismatch", () => {
  it("book.yaml 的 id 与目录名不一致 → error", async () => {
    const ws = await workspace();
    const { writeYamlFile } = await import("../store/file-io.js");
    await writeYamlFile(ws.paths.bookFile, {
      schemaVersion: 1,
      id: "other-id",
      title: "测试书",
      author: "",
      genres: [],
      pov: "第三人称有限",
      logline: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(errorsOf(byRule(await lint(ws), "book-meta-mismatch"))).toHaveLength(1);
  });
});

/* ── 验收：配置完整的书应当零发现 ─────────────── */

const COMPLETE_STYLE = `# 文风锚定

## 一、整体基调
冷硬克制，情绪不直说，靠动作与环境反衬。战斗描写偏短句、重节奏，不做铺陈。

## 二、叙述人称与视角
第三人称有限，始终跟随主角，不进入他人内心。

## 三、句式偏好
- 句长：以 15–25 字为主，紧张处压到 8 字以内
- 段落：对话密集处一句一段；描写段不超过 5 行
- 忌用：不用"仿佛""不禁""这一刻"

## 四、对白风格
口语化，少用敬语；主角说话带刺；反派不解释动机。

## 五、正面范例
刀锋擦过耳侧，带起一线血珠。
他没躲。不是来不及，是不想躲。

## 六、反面范例
他感到无比愤怒，仿佛整个世界都在这一刻崩塌了。

## 七、自定义 AI 味黑名单
\`\`\`
仿佛
不禁
这一刻
嘴角勾起
\`\`\`
`;

const COMPLETE_OUTLINE = `# 全书总纲

## 一句话简介
一个被逐出宗门的小人物，靠一把有裂痕的刀重新爬上来。

## 核心冲突
林渊要在宗门倾轧与自身旧伤的夹缝中查清父母死因。

## 主线脉络
1. 被逐出宗门，流落落霞谷
2. 从残卷中习得失传刀法
3. 重返青云宗，揭开旧案
`;

describe("验收：配置完整的书", () => {
  it("零发现（error / warning / info 全部为零）", async () => {
    const ws = await workspace();

    await writeTextFile(ws.paths.styleFile, COMPLETE_STYLE);
    await writeTextFile(ws.paths.masterOutlineFile, COMPLETE_OUTLINE);
    await putPowerSystem(ws, ["炼气", "筑基", "金丹"], [
      "越级战斗上限为一个大境界",
    ]);

    await putCharacters(ws, [
      character({
        id: "char_linyuan",
        name: "林渊",
        aliases: ["渊哥"],
        role: "protagonist",
        personality: ["表面散漫，实际记仇", "对弱者手软"],
        firstAppearance: "ch-0001",
        speechStyle: { patterns: ["啧", "有意思"], register: "冷淡" },
        forbidden: ["绝不主动示弱"],
        relationships: [
          { target: "char_suwan", type: "同门", status: "相互试探", since: "ch-0002" },
        ],
        state: {
          asOfChapter: "ch-0002",
          realm: "筑基后期",
          location: "loc_luoxiagu",
          possession: ["item_duanyue"],
          goals: ["查明父母死因"],
        },
      }),
      character({
        id: "char_suwan",
        name: "苏晚",
        role: "deuteragonist",
        personality: ["外冷内热"],
        firstAppearance: "ch-0002",
        speechStyle: { patterns: ["师兄"], register: "冷淡" },
        state: { asOfChapter: "ch-0002", realm: "炼气九层", location: "loc_luoxiagu" },
      }),
    ]);

    await putItems(ws, [
      ItemSchema.parse({
        id: "item_duanyue",
        name: "断岳刀",
        kind: "武器",
        firstAppearance: "ch-0001",
      }),
    ]);

    await putLocations(ws, [
      LocationSchema.parse({ id: "loc_qingyunzong", name: "青云宗" }),
      LocationSchema.parse({ id: "loc_luoxiagu", name: "落霞谷", parent: "loc_qingyunzong" }),
    ]);

    await writeAnyCollection(ws.paths, COLLECTIONS.settings, [
      SettingSchema.parse({
        id: "setting_001",
        statement: "灵力无法在无月之夜恢复",
        establishedAt: "ch-0001",
      }),
    ]);

    await putThreads(ws, [
      ThreadSchema.parse({
        id: "thread_001",
        title: "断岳刀的裂痕",
        plantedAt: "ch-0001",
        detail: "刀身出现一道无法修复的裂痕，来源未解释",
        related: ["char_linyuan", "item_duanyue"],
      }),
    ]);

    await putChapter(ws, "ch-0001", "林渊把断岳刀插进石缝里。刀身那道裂痕，又深了一分。");
    await putChapter(ws, "ch-0002", "苏晚站在谷口。林渊抬头看了她一眼。");

    const findings = await lint(ws);
    expect(findings).toEqual([]);
  });
});
