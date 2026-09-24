import { describe, it } from "node:test";
import { expect } from "../testing/expect.js";
import {
  BookSchema,
  CharacterSchema,
  FactionSchema,
  ItemSchema,
  LocationSchema,
  SettingSchema,
  ThreadSchema,
} from "./schemas.js";

describe("CharacterSchema", () => {
  it("只给 id 和 name 时补齐全部默认值", () => {
    const character = CharacterSchema.parse({ id: "char_a", name: "甲" });

    expect(character.role).toBe("supporting");
    expect(character.personality).toEqual([]);
    expect(character.aliases).toEqual([]);
    expect(character.relationships).toEqual([]);
    expect(character.forbidden).toEqual([]);

    // 嵌套对象的默认值必须真的物化 —— 这是 zod v4 的 .default() 短路语义最容易踩的坑
    expect(character.state.alive).toBe(true);
    expect(character.state.possession).toEqual([]);
    expect(character.state.injuries).toEqual([]);
    expect(character.speechStyle).toEqual({ patterns: [], avoid: [] });
  });

  it("拒绝不符合前缀约定的 id", () => {
    expect(() => CharacterSchema.parse({ id: "a", name: "甲" })).toThrow();
    expect(() => CharacterSchema.parse({ id: "item_a", name: "甲" })).toThrow();
    expect(() => CharacterSchema.parse({ id: "char_A", name: "甲" })).toThrow();
  });

  it("name 不可为空", () => {
    expect(() => CharacterSchema.parse({ id: "char_a", name: "" })).toThrow();
  });

  it("允许手写 YAML 省略 state 与 speechStyle", () => {
    const character = CharacterSchema.parse({
      id: "char_b",
      name: "乙",
      personality: ["冷淡"],
    });
    expect(character.personality).toEqual(["冷淡"]);
    expect(character.state.alive).toBe(true);
  });

  it("拒绝非法的 role 取值", () => {
    expect(() =>
      CharacterSchema.parse({ id: "char_c", name: "丙", role: "主角" }),
    ).toThrow();
  });
});

describe("各实体的 id 前缀", () => {
  it("物品 / 地点 / 势力 / 设定 / 伏笔 各自校验前缀", () => {
    expect(ItemSchema.parse({ id: "item_a", name: "刀" }).id).toBe("item_a");
    expect(LocationSchema.parse({ id: "loc_a", name: "谷" }).id).toBe("loc_a");
    expect(FactionSchema.parse({ id: "faction_a", name: "宗" }).id).toBe("faction_a");
    expect(SettingSchema.parse({ id: "setting_a", statement: "规则" }).id).toBe("setting_a");
    expect(ThreadSchema.parse({ id: "thread_001", title: "裂痕" }).id).toBe("thread_001");

    expect(() => ItemSchema.parse({ id: "char_a", name: "刀" })).toThrow();
    expect(() => ThreadSchema.parse({ id: "thread_1", title: "裂痕" })).toThrow();
  });
});

describe("ThreadSchema", () => {
  it("默认状态为 open，related 为空", () => {
    const thread = ThreadSchema.parse({ id: "thread_001", title: "裂痕" });
    expect(thread.status).toBe("open");
    expect(thread.related).toEqual([]);
    expect(thread.detail).toBe("");
  });
});

describe("SettingSchema", () => {
  it("默认不可变", () => {
    const setting = SettingSchema.parse({ id: "setting_a", statement: "无月之夜不恢复灵力" });
    expect(setting.immutable).toBe(true);
  });
});

describe("BookSchema", () => {
  it("要求 id 与 title", () => {
    expect(() => BookSchema.parse({ id: "demo" })).toThrow();
    expect(() => BookSchema.parse({ id: "Demo", title: "书" })).toThrow();
  });

  it("默认视角为第三人称有限", () => {
    const book = BookSchema.parse({
      id: "demo",
      title: "书",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(book.pov).toBe("第三人称有限");
    expect(book.schemaVersion).toBe(1);
  });

  it("缺少时间戳会被拒绝（book.yaml 由工具生成，作者无需手写）", () => {
    expect(() => BookSchema.parse({ id: "demo", title: "书" })).toThrow();
  });
});
