/**
 * Bible 装载 / 落盘 / 单集合 CRUD。
 *
 * 这里是「文件系统 ↔ 内存对象」的唯一通道。上层（lint、CLI、未来的生成器）
 * 一律通过 loadBible() 拿到经过校验的完整快照，不直接读文件。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BookSchema,
  PowerSystemSchema,
  TimelineSchema,
  type Book,
  type Character,
  type Faction,
  type Item,
  type Location,
  type PowerSystem,
  type Setting,
  type Thread,
  type Timeline,
} from "../domain/schemas.js";
import {
  COLLECTIONS,
  type AnyCollectionDef,
  type AnyEntity,
  type CollectionDef,
} from "./collections.js";
import { readYamlRaw, readYamlValidated, validate, writeYamlFile } from "./file-io.js";
import { resolveBook, type BookPaths } from "./paths.js";

const POWER_SYSTEM_FILE = "bible/power_system.yaml";
const TIMELINE_FILE = "bible/timeline.yaml";

/** 六个实体集合。 */
export interface BibleCollections {
  characters: Character[];
  items: Item[];
  locations: Location[];
  factions: Faction[];
  threads: Thread[];
  settings: Setting[];
}

/** 一次 loadBible 得到的完整快照。 */
export interface Bible extends BibleCollections {
  readonly bookId: string;
  readonly paths: BookPaths;
  readonly book: Book;
  readonly powerSystem: PowerSystem;
  readonly timeline: Timeline;
}

/** 集合文件的包装结构：顶层用集合名做键，让文件自描述。 */
function wrapperSchema<T extends { id: string }>(def: CollectionDef<T>) {
  return z.object({ [def.key]: z.array(def.schema).default([]) });
}

/* ── 单集合读写 ───────────────────────────────── */

export async function readCollection<T extends { id: string }>(
  paths: BookPaths,
  def: CollectionDef<T>,
): Promise<T[]> {
  const filePath = join(paths.root, def.file);
  if (!existsSync(filePath)) return [];

  const raw = await readYamlRaw(filePath);
  if (raw === null || raw === undefined) return [];

  const parsed = validate(wrapperSchema(def), raw, filePath);
  const bag = parsed as Record<string, T[] | undefined>;
  return bag[def.key] ?? [];
}

export async function writeCollection<T extends { id: string }>(
  paths: BookPaths,
  def: CollectionDef<T>,
  entities: readonly T[],
): Promise<void> {
  const checked = validate(z.array(def.schema), [...entities], `${def.label}集合`);
  await writeYamlFile(join(paths.root, def.file), { [def.key]: checked }, def.header);
}

/** 动态分派版本，供 CLI 按名字操作任意集合。 */
export async function readAnyCollection(
  paths: BookPaths,
  def: AnyCollectionDef,
): Promise<AnyEntity[]> {
  const filePath = join(paths.root, def.file);
  if (!existsSync(filePath)) return [];

  const raw = await readYamlRaw(filePath);
  if (raw === null || raw === undefined) return [];

  const parsed = validate(wrapperSchema(def), raw, filePath);
  const bag = parsed as Record<string, AnyEntity[] | undefined>;
  return bag[def.key] ?? [];
}

export async function writeAnyCollection(
  paths: BookPaths,
  def: AnyCollectionDef,
  entities: readonly AnyEntity[],
): Promise<void> {
  const checked = validate(z.array(def.schema), [...entities], `${def.label}集合`);
  await writeYamlFile(join(paths.root, def.file), { [def.key]: checked }, def.header);
}

/* ── 单例（境界体系 / 时间线） ─────────────────── */

export async function readPowerSystem(paths: BookPaths): Promise<PowerSystem> {
  const filePath = join(paths.root, POWER_SYSTEM_FILE);
  if (!existsSync(filePath)) return PowerSystemSchema.parse({});
  return readYamlValidated(filePath, PowerSystemSchema);
}

export async function writePowerSystem(paths: BookPaths, value: PowerSystem): Promise<void> {
  const checked = validate(PowerSystemSchema, value, POWER_SYSTEM_FILE);
  await writeYamlFile(
    join(paths.root, POWER_SYSTEM_FILE),
    checked,
    "境界 / 等级体系。rules 是硬规则，任何章节都不得违反。",
  );
}

export async function readTimeline(paths: BookPaths): Promise<Timeline> {
  const filePath = join(paths.root, TIMELINE_FILE);
  if (!existsSync(filePath)) return TimelineSchema.parse({});
  return readYamlValidated(filePath, TimelineSchema);
}

export async function writeTimeline(paths: BookPaths, value: Timeline): Promise<void> {
  const checked = validate(TimelineSchema, value, TIMELINE_FILE);
  await writeYamlFile(join(paths.root, TIMELINE_FILE), checked, "故事内时间线。");
}

/* ── 全量装载 ─────────────────────────────────── */

export async function loadCollections(paths: BookPaths): Promise<BibleCollections> {
  const [characters, items, locations, factions, threads, settings] = await Promise.all([
    readCollection(paths, COLLECTIONS.characters),
    readCollection(paths, COLLECTIONS.items),
    readCollection(paths, COLLECTIONS.locations),
    readCollection(paths, COLLECTIONS.factions),
    readCollection(paths, COLLECTIONS.threads),
    readCollection(paths, COLLECTIONS.settings),
  ] as const);

  return { characters, items, locations, factions, threads, settings };
}

/**
 * 装载完整 Bible。
 *
 * @param booksRoot books/ 目录
 * @param bookId 省略时自动探测（只有一本书时）
 */
export async function loadBible(booksRoot: string, bookId?: string): Promise<Bible> {
  const { id, paths } = await resolveBook(booksRoot, bookId);

  const [book, collections, powerSystem, timeline] = await Promise.all([
    readYamlValidated(paths.bookFile, BookSchema),
    loadCollections(paths),
    readPowerSystem(paths),
    readTimeline(paths),
  ] as const);

  return {
    bookId: id,
    paths,
    book,
    powerSystem,
    timeline,
    ...collections,
  };
}

/** 更新 book.yaml 的 updatedAt 并落盘。 */
export async function saveBook(paths: BookPaths, book: Book): Promise<Book> {
  const next: Book = { ...book, updatedAt: new Date().toISOString() };
  const checked = validate(BookSchema, next, "book.yaml");
  await writeYamlFile(paths.bookFile, checked);
  return checked;
}

/** 从完整 Bible 中取出六个实体集合。 */
export function collectionsOf(bible: Bible): BibleCollections {
  return {
    characters: bible.characters,
    items: bible.items,
    locations: bible.locations,
    factions: bible.factions,
    threads: bible.threads,
    settings: bible.settings,
  };
}

/* ── 内存内 CRUD ──────────────────────────────── */

export function findEntity<T extends { id: string }>(
  entities: readonly T[],
  id: string,
): T | undefined {
  return entities.find((entity) => entity.id === id);
}

/** 不存在则追加，存在则整体替换。返回新数组，不改动入参。 */
export function upsertEntity<T extends { id: string }>(
  entities: readonly T[],
  entity: T,
): { next: T[]; created: boolean } {
  const index = entities.findIndex((candidate) => candidate.id === entity.id);
  if (index === -1) return { next: [...entities, entity], created: true };
  const next = [...entities];
  next[index] = entity;
  return { next, created: false };
}

export function removeEntity<T extends { id: string }>(
  entities: readonly T[],
  id: string,
): { next: T[]; removed: T | undefined } {
  const removed = entities.find((entity) => entity.id === id);
  return { next: entities.filter((entity) => entity.id !== id), removed };
}

/* ── 交叉索引 ─────────────────────────────────── */

export interface IndexedEntity {
  readonly id: string;
  readonly collectionKey: string;
  readonly collectionLabel: string;
  readonly entity: AnyEntity;
}

/**
 * 建立全 Bible 的 id → 实体索引。重复 id 会被 lint 规则捕获，
 * 这里先到先得，保证索引本身不会因为脏数据而崩。
 */
export function buildEntityIndex(collections: BibleCollections): Map<string, IndexedEntity> {
  const index = new Map<string, IndexedEntity>();
  const push = (key: string, label: string, entities: readonly AnyEntity[]) => {
    for (const entity of entities) {
      if (!index.has(entity.id)) {
        index.set(entity.id, { id: entity.id, collectionKey: key, collectionLabel: label, entity });
      }
    }
  };

  push("characters", "人物", collections.characters);
  push("items", "物品", collections.items);
  push("locations", "地点", collections.locations);
  push("factions", "势力", collections.factions);
  push("threads", "伏笔", collections.threads);
  push("settings", "设定", collections.settings);

  return index;
}
