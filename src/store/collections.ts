/**
 * Bible 集合注册表。
 *
 * 每个「集合」（人物 / 物品 / 地点 / 势力 / 伏笔 / 设定）在这里声明一次，
 * CRUD 层与 CLI 都从这张表驱动，避免到处写重复的样板代码。
 */

import { z } from "zod";
import {
  CharacterSchema,
  FactionSchema,
  ItemSchema,
  LocationSchema,
  SettingSchema,
  ThreadSchema,
  type Character,
  type Faction,
  type Item,
  type Location,
  type Setting,
  type Thread,
} from "../domain/schemas.js";

/** Bible 中所有可独立寻址的实体。 */
export type AnyEntity = Character | Item | Location | Faction | Setting | Thread;

export interface CollectionDef<T extends { id: string }> {
  /** YAML 文件内的顶层键，也是文件主名。 */
  readonly key: string;
  /** 相对书籍根目录的路径。 */
  readonly file: string;
  readonly schema: z.ZodType<T>;
  readonly idPrefix: string;
  /** 中文名，用于输出。 */
  readonly label: string;
  /** CLI 上的简写别名。 */
  readonly aliases: readonly string[];
  /** 除 id 外必填的文本字段，CLI `add` 用它构造骨架。 */
  readonly primary: { readonly name: string; readonly label: string };
  /** 写入文件时前置的说明注释。 */
  readonly header: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyCollectionDef = CollectionDef<any>;

const characters: CollectionDef<Character> = {
  key: "characters",
  file: "bible/characters.yaml",
  schema: CharacterSchema,
  idPrefix: "char_",
  label: "人物",
  aliases: ["char", "character", "chars", "renwu"],
  primary: { name: "name", label: "姓名" },
  header: [
    "人物卡。全书最重要的数据结构 ——",
    "state 是「此刻快照」，每章推进后应当更新；",
    "speechStyle / forbidden 用于检测崩人设。",
  ].join("\n"),
};

const items: CollectionDef<Item> = {
  key: "items",
  file: "bible/items.yaml",
  schema: ItemSchema,
  idPrefix: "item_",
  label: "物品",
  aliases: ["item", "wu"],
  primary: { name: "name", label: "名称" },
  header: [
    "物品。持有人不在这里记录 ——",
    "唯一真相源是 character.state.possession。",
  ].join("\n"),
};

const locations: CollectionDef<Location> = {
  key: "locations",
  file: "bible/locations.yaml",
  schema: LocationSchema,
  idPrefix: "loc_",
  label: "地点",
  aliases: ["loc", "location", "place", "didian"],
  primary: { name: "name", label: "名称" },
  header: "地点。parent 字段用于表达隶属关系。",
};

const factions: CollectionDef<Faction> = {
  key: "factions",
  file: "bible/factions.yaml",
  schema: FactionSchema,
  idPrefix: "faction_",
  label: "势力",
  aliases: ["faction", "shili"],
  primary: { name: "name", label: "名称" },
  header: "势力 / 组织。",
};

const threads: CollectionDef<Thread> = {
  key: "threads",
  file: "bible/threads.yaml",
  schema: ThreadSchema,
  idPrefix: "thread_",
  label: "伏笔",
  aliases: ["thread", "fubi"],
  primary: { name: "title", label: "标题" },
  header: [
    "伏笔追踪 —— 挖坑不填是网文读者的头号怨念。",
    "status: open(已埋设) | hinted(有推进) | resolved(已回收) | abandoned(已放弃)",
    "lint 会对长期未回收的 open 伏笔报警。",
  ].join("\n"),
};

const settings: CollectionDef<Setting> = {
  key: "settings",
  file: "bible/settings.yaml",
  schema: SettingSchema,
  idPrefix: "setting_",
  label: "设定",
  aliases: ["setting", "rule", "shezhi"],
  primary: { name: "statement", label: "设定陈述" },
  header: "已立设定（硬规则）。immutable: true 的条目任何情况下都不得违反。",
};

export const COLLECTIONS = {
  characters,
  items,
  locations,
  factions,
  threads,
  settings,
} as const;

export const COLLECTION_LIST: readonly AnyCollectionDef[] = [
  characters,
  items,
  locations,
  factions,
  threads,
  settings,
];

/** 按 key 或 CLI 别名查找集合，大小写不敏感。 */
export function findCollection(nameOrAlias: string): AnyCollectionDef | undefined {
  const needle = nameOrAlias.trim().toLowerCase();
  return COLLECTION_LIST.find(
    (def) => def.key.toLowerCase() === needle || def.aliases.some((a) => a === needle),
  );
}

/** 按 id 前缀反查集合。 */
export function collectionForId(id: string): AnyCollectionDef | undefined {
  return COLLECTION_LIST.find((def) => id.startsWith(def.idPrefix));
}
