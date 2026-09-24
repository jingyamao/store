import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BookSchema, CharacterSchema, ThreadSchema } from "../domain/schemas.js";
import { captureError, expect, expectRejects } from "../testing/expect.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import {
  buildEntityIndex,
  collectionsOf,
  findEntity,
  loadBible,
  readCollection,
  removeEntity,
  upsertEntity,
  writeCollection,
} from "./bible.js";
import { COLLECTIONS } from "./collections.js";
import { readYamlValidated, SchemaMismatchError, writeTextFile } from "./file-io.js";
import { initBook } from "./scaffold.js";

const opened: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createWorkspace();
  opened.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((item) => item.cleanup()));
});

describe("initBook", () => {
  it("创建完整目录结构", async () => {
    const ws = await workspace();

    for (const relative of [
      "book.yaml",
      "style.md",
      "outline/master.md",
      "bible/characters.yaml",
      "bible/items.yaml",
      "bible/locations.yaml",
      "bible/factions.yaml",
      "bible/power_system.yaml",
      "bible/settings.yaml",
      "bible/threads.yaml",
      "bible/timeline.yaml",
    ]) {
      expect(existsSync(join(ws.paths.root, relative))).toBe(true);
    }

    for (const dir of [
      ws.paths.chaptersDir,
      ws.paths.summariesDir,
      ws.paths.runsDir,
      ws.paths.volumesDir,
      ws.paths.chaptersOutlineDir,
    ]) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("book.yaml 可被 schema 通过校验", async () => {
    const ws = await workspace();
    const book = await readYamlValidated(ws.paths.bookFile, BookSchema);
    expect(book.id).toBe("demo");
    expect(book.title).toBe("测试书");
  });

  it("目录已存在时报错，除非显式 force", async () => {
    const ws = await workspace();

    const failed = await captureError(() => initBook(ws.booksRoot, { bookId: ws.bookId }));
    expect(failed instanceof Error).toBe(true);
    expect((failed as Error).message).toMatch("已存在");

    const paths = await initBook(ws.booksRoot, { bookId: ws.bookId, force: true });
    expect(paths.root).toBe(ws.paths.root);
  });

  it("拒绝非法 book-id", async () => {
    const ws = await workspace();
    await expectRejects(() => initBook(ws.booksRoot, { bookId: "Bad Id" }));
    await expectRejects(() => initBook(ws.booksRoot, { bookId: "-leading" }));
  });
});

describe("集合读写", () => {
  it("文件缺失时读成空数组", async () => {
    const ws = await workspace();
    expect(await readCollection(ws.paths, COLLECTIONS.characters)).toEqual([]);
  });

  it("写入后能原样读回", async () => {
    const ws = await workspace();
    const character = CharacterSchema.parse({
      id: "char_a",
      name: "林渊",
      aliases: ["渊哥"],
      personality: ["散漫"],
    });

    await writeCollection(ws.paths, COLLECTIONS.characters, [character]);
    const readBack = await readCollection(ws.paths, COLLECTIONS.characters);

    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toEqual(character);
  });

  it("写入非法数据会被 schema 拒绝", async () => {
    const ws = await workspace();
    const broken = [{ id: "not_prefixed", name: "甲" }] as never;
    await expectRejects(() => writeCollection(ws.paths, COLLECTIONS.characters, broken));
  });

  it("手写的坏数据在读入时被拒绝，并给出字段定位", async () => {
    const ws = await workspace();
    await writeTextFile(
      join(ws.paths.bibleDir, "characters.yaml"),
      "characters:\n  - id: char_a\n    name: ''\n",
    );

    const error = await captureError(() => readCollection(ws.paths, COLLECTIONS.characters));
    expect(error instanceof SchemaMismatchError).toBe(true);
    expect((error as SchemaMismatchError).message).toMatch("characters.yaml");
    expect((error as SchemaMismatchError).message).toMatch("0.name");
  });

  it("YAML 文件带顶层集合键与说明注释，便于人工阅读", async () => {
    const ws = await workspace();
    await writeCollection(ws.paths, COLLECTIONS.threads, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕" }),
    ]);
    const raw = await readFile(join(ws.paths.bibleDir, "threads.yaml"), "utf8");
    expect(raw).toMatch("threads:");
    expect(raw).toMatch("伏笔追踪");
  });

  it("空文件被当成空集合而不是解析错误", async () => {
    const ws = await workspace();
    await writeTextFile(join(ws.paths.bibleDir, "items.yaml"), "");
    expect(await readCollection(ws.paths, COLLECTIONS.items)).toEqual([]);
  });
});

describe("内存 CRUD 辅助", () => {
  const a = CharacterSchema.parse({ id: "char_a", name: "甲" });
  const b = CharacterSchema.parse({ id: "char_b", name: "乙" });

  it("upsertEntity 区分新建与替换", () => {
    const created = upsertEntity([a], b);
    expect(created.created).toBe(true);
    expect(created.next).toHaveLength(2);

    const replaced = upsertEntity([a, b], CharacterSchema.parse({ id: "char_a", name: "甲改" }));
    expect(replaced.created).toBe(false);
    expect(replaced.next).toHaveLength(2);
    expect(replaced.next[0]?.name).toBe("甲改");
  });

  it("removeEntity 返回被删掉的实体", () => {
    const result = removeEntity([a, b], "char_a");
    expect(result.next).toHaveLength(1);
    expect(result.removed?.id).toBe("char_a");

    const missing = removeEntity([a, b], "char_zzz");
    expect(missing.removed).toBeUndefined();
    expect(missing.next).toHaveLength(2);
  });

  it("findEntity 找不到时返回 undefined", () => {
    expect(findEntity([a, b], "char_b")?.name).toBe("乙");
    expect(findEntity([a, b], "char_zzz")).toBeUndefined();
  });
});

describe("loadBible", () => {
  it("返回包含全部集合与单例的完整快照", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);

    expect(bible.bookId).toBe("demo");
    expect(bible.book.title).toBe("测试书");
    expect(bible.characters).toEqual([]);
    expect(bible.threads).toEqual([]);
    expect(bible.powerSystem.realms).toEqual([]);
    expect(bible.timeline.events).toEqual([]);
  });

  it("只有一本书时可以省略 bookId 自动探测", async () => {
    const ws = await workspace();
    expect((await loadBible(ws.booksRoot)).bookId).toBe("demo");
  });

  it("没有书时给出可操作的错误提示", async () => {
    const ws = await workspace();
    const error = await captureError(() => loadBible(join(ws.root, "empty-books")));
    expect((error as Error).message).toMatch("novel init");
  });

  it("buildEntityIndex 覆盖多个集合", async () => {
    const ws = await workspace();
    await writeCollection(ws.paths, COLLECTIONS.characters, [
      CharacterSchema.parse({ id: "char_a", name: "甲" }),
    ]);
    await writeCollection(ws.paths, COLLECTIONS.threads, [
      ThreadSchema.parse({ id: "thread_001", title: "裂痕" }),
    ]);

    const index = buildEntityIndex(collectionsOf(await loadBible(ws.booksRoot, ws.bookId)));

    expect(index.size).toBe(2);
    expect(index.get("char_a")?.collectionLabel).toBe("人物");
    expect(index.get("thread_001")?.collectionLabel).toBe("伏笔");
  });
});
