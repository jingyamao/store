/**
 * Story Bible 的全部 zod schema —— 整个项目的地基。
 *
 * 设计原则（重要）：
 *   schema 只负责「结构正确性」，不负责「内容质量」。
 *   因此只要结构合法，缺失的内容一律用空值放行，由 lint 去温和提醒。
 *   这样作者手写 YAML 时不会因为漏了一个字段就被打回，
 *   而 Bible 依然能在类型层面保持可信。
 */

import { z } from "zod";

/* ────────────────────────────────────────────────
 * 基础标量与 id 约束
 * ──────────────────────────────────────────────── */

export const ChapterIdSchema = z
  .string()
  .regex(/^ch-\d{4,}$/, "章节 id 格式应为 ch-0001");

export const CharacterIdSchema = z
  .string()
  .regex(/^char_[a-z0-9_]+$/, "人物 id 格式应为 char_xxx（小写字母、数字、下划线）");

export const ItemIdSchema = z
  .string()
  .regex(/^item_[a-z0-9_]+$/, "物品 id 格式应为 item_xxx");

export const LocationIdSchema = z
  .string()
  .regex(/^loc_[a-z0-9_]+$/, "地点 id 格式应为 loc_xxx");

export const FactionIdSchema = z
  .string()
  .regex(/^faction_[a-z0-9_]+$/, "势力 id 格式应为 faction_xxx");

export const SettingIdSchema = z
  .string()
  .regex(/^setting_[a-z0-9_]+$/, "设定 id 格式应为 setting_xxx");

export const ThreadIdSchema = z
  .string()
  .regex(/^thread_\d{3,}$/, "伏笔 id 格式应为 thread_001");

/** 任何 Bible 实体的 id 联合 —— 用于伏笔 related 这类跨集合引用。 */
export const AnyEntityIdSchema = z.union([
  CharacterIdSchema,
  ItemIdSchema,
  LocationIdSchema,
  FactionIdSchema,
  SettingIdSchema,
  ThreadIdSchema,
]);

/** 去重后的非空字符串列表。 */
const tagList = () => z.array(z.string().min(1)).default([]);

/**
 * 让一个「内部字段自带 default」的 object schema 在整体缺省时
 * 也能得到完整默认值。
 *
 * 注意：zod v4 的 .default() 会短路解析、直接返回字面量，
 * 所以不能写 .default({})，否则内部字段的 default 不会生效。
 */
function parsedDefault<T>(schema: z.ZodType<T>): () => T {
  return () => schema.parse({});
}

/* ────────────────────────────────────────────────
 * 枚举
 * ──────────────────────────────────────────────── */

export const CharacterRoleSchema = z.enum([
  "protagonist", // 主角
  "deuteragonist", // 第二主角 / 重要配角
  "antagonist", // 反派
  "supporting", // 配角
  "cameo", // 龙套
]);

export const SpeechRegisterSchema = z.enum([
  "文雅",
  "市井",
  "粗豪",
  "冷淡",
  "跳脱",
]);

export const ThreadStatusSchema = z.enum([
  "open", // 已埋设，未回收
  "hinted", // 有暗示推进，仍未揭晓
  "resolved", // 已回收
  "abandoned", // 明确放弃（不再提醒）
]);

export const FactionAlignmentSchema = z.enum(["正", "邪", "中立", "未知"]);

export const PovSchema = z.enum(["第一人称", "第三人称有限", "第三人称全知"]);

/* ────────────────────────────────────────────────
 * 人物卡 —— 全书最重要的数据结构
 * ──────────────────────────────────────────────── */

/** 对白一致性：口癖是人物辨识度的核心，也是最容易写崩的地方。 */
export const SpeechStyleSchema = z.object({
  /** 常说 / 有辨识度的措辞。 */
  patterns: tagList(),
  /** 绝不会说的措辞 —— 违反即为崩人设。 */
  avoid: tagList(),
  register: SpeechRegisterSchema.optional(),
});

export const RelationshipSchema = z.object({
  target: CharacterIdSchema,
  /** 同门 / 宿敌 / 师徒 / 暧昧 ... */
  type: z.string().min(1),
  /** 关系的当前状态：相互试探 / 已决裂 ... */
  status: z.string().default(""),
  /** 关系确立或改变的章节。 */
  since: ChapterIdSchema.optional(),
  notes: z.string().optional(),
});

/**
 * 动态状态：随章节推进而变化的「此刻快照」。
 *
 * 这是防止「写到第 200 章人物崩了」的关键字段 ——
 * 生成新章节时，这些内容会被注入上下文。
 */
export const CharacterStateSchema = z.object({
  /** 本状态对应的章节。缺失时 lint 会提醒补。 */
  asOfChapter: ChapterIdSchema.optional(),
  /** 境界 / 等级。必须能在 power_system 中找到（lint 校验）。 */
  realm: z.string().optional(),
  location: LocationIdSchema.optional(),
  injuries: tagList(),
  /** 持有的关键物品 id 列表 —— 物品归属的唯一真相源。 */
  possession: z.array(ItemIdSchema).default([]),
  /** 已知的秘密 / 情报。 */
  knownSecrets: tagList(),
  goals: tagList(),
  alive: z.boolean().default(true),
  /** 死亡章节。alive 与 diedAt 的一致性由 lint 校验。 */
  diedAt: ChapterIdSchema.optional(),
});

export const CharacterSchema = z.object({
  id: CharacterIdSchema,
  name: z.string().min(1),
  /** 别名 / 昵称 / 尊称 —— 专名漂移检测的基准。 */
  aliases: tagList(),
  role: CharacterRoleSchema.default("supporting"),
  /** 首次出场章节。缺失时 lint 提醒。 */
  firstAppearance: ChapterIdSchema.optional(),
  appearance: z.string().optional(),
  /** 性格要点。空数组会被 lint 提醒。 */
  personality: tagList(),
  speechStyle: SpeechStyleSchema.default(parsedDefault(SpeechStyleSchema)),
  relationships: z.array(RelationshipSchema).default([]),
  state: CharacterStateSchema.default(parsedDefault(CharacterStateSchema)),
  /** 硬约束：写崩人设时 lint 报警。 */
  forbidden: tagList(),
  notes: z.string().optional(),
});

/* ────────────────────────────────────────────────
 * 物品
 * ──────────────────────────────────────────────── */

export const ItemSchema = z.object({
  id: ItemIdSchema,
  name: z.string().min(1),
  aliases: tagList(),
  /** 武器 / 丹药 / 信物 / 功法 ... */
  kind: z.string().optional(),
  description: z.string().default(""),
  firstAppearance: ChapterIdSchema.optional(),
  /**
   * 当前状态：完好 / 已损毁 / 封印中 ...
   * 注意：持有人不在物品上记录，唯一真相源是 character.state.possession。
   */
  condition: z.string().optional(),
  /** 剧情意义 —— 用于判断该物品在生成时是否需要重点注入。 */
  significance: z.string().optional(),
  notes: z.string().optional(),
});

/* ────────────────────────────────────────────────
 * 地点
 * ──────────────────────────────────────────────── */

export const LocationSchema = z.object({
  id: LocationIdSchema,
  name: z.string().min(1),
  aliases: tagList(),
  /** 上级地点：落霞谷 的 parent 是 青云宗。 */
  parent: LocationIdSchema.optional(),
  description: z.string().default(""),
  firstAppearance: ChapterIdSchema.optional(),
  notes: z.string().optional(),
});

/* ────────────────────────────────────────────────
 * 势力
 * ──────────────────────────────────────────────── */

export const FactionSchema = z.object({
  id: FactionIdSchema,
  name: z.string().min(1),
  aliases: tagList(),
  alignment: FactionAlignmentSchema.default("未知"),
  /** 根据地。 */
  base: LocationIdSchema.optional(),
  description: z.string().default(""),
  firstAppearance: ChapterIdSchema.optional(),
  notes: z.string().optional(),
});

/* ────────────────────────────────────────────────
 * 境界 / 等级体系
 * ──────────────────────────────────────────────── */

export const RealmSchema = z.object({
  name: z.string().min(1),
  /** 该境界内的小层次数量，如炼气九层 → 9。 */
  levels: z.number().int().positive().default(1),
  description: z.string().optional(),
});

export const PowerSystemSchema = z.object({
  realms: z.array(RealmSchema).default([]),
  /** 硬规则：越级战斗上限一个大境界 ... */
  rules: tagList(),
});

/* ────────────────────────────────────────────────
 * 已立设定（硬规则）
 * ──────────────────────────────────────────────── */

export const SettingSchema = z.object({
  id: SettingIdSchema,
  /** 一句话陈述，如「灵力无法在无月之夜恢复」。 */
  statement: z.string().min(1),
  establishedAt: ChapterIdSchema.optional(),
  /** 不可变设定：AI 与作者都不得违反。 */
  immutable: z.boolean().default(true),
  notes: z.string().optional(),
});

/* ────────────────────────────────────────────────
 * 伏笔追踪 —— 本项目最具差异化的模块
 * ──────────────────────────────────────────────── */

export const ThreadSchema = z.object({
  id: ThreadIdSchema,
  title: z.string().min(1),
  /** 埋设章节。 */
  plantedAt: ChapterIdSchema.optional(),
  detail: z.string().default(""),
  status: ThreadStatusSchema.default("open"),
  /** 计划回收章节 —— 仅作提醒，不强制。 */
  targetResolve: ChapterIdSchema.optional(),
  /** 实际回收章节。status 为 resolved 时应填写。 */
  resolvedAt: ChapterIdSchema.optional(),
  /** 回收方式 / 思路备忘。 */
  payoffNotes: z.string().optional(),
  /** 相关实体 id（人物 / 物品 / 地点 / 势力 / 设定）。 */
  related: z.array(AnyEntityIdSchema).default([]),
});

/* ────────────────────────────────────────────────
 * 时间线
 * ──────────────────────────────────────────────── */

export const TimelineEventSchema = z.object({
  id: z.string().min(1),
  chapter: ChapterIdSchema,
  summary: z.string().min(1),
  /** 故事内时间，如「入宗第三年·春」。 */
  inWorldTime: z.string().optional(),
});

export const TimelineSchema = z.object({
  events: z.array(TimelineEventSchema).default([]),
});

/* ────────────────────────────────────────────────
 * 书籍元信息（book.yaml）
 * ──────────────────────────────────────────────── */

export const BOOK_SCHEMA_VERSION = 1;

export const BookSchema = z.object({
  schemaVersion: z.number().int().positive().default(BOOK_SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "书籍 id 只允许小写字母、数字与连字符"),
  title: z.string().min(1),
  author: z.string().default(""),
  genres: tagList(),
  targetPlatform: z.string().optional(),
  pov: PovSchema.default("第三人称有限"),
  /** 一句话简介。 */
  logline: z.string().default(""),
  /** 每次 lint / status 关心的「当前进度章节」，可手动维护。 */
  currentChapter: ChapterIdSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/* ────────────────────────────────────────────────
 * 类型导出
 * ──────────────────────────────────────────────── */

export type ChapterId = z.infer<typeof ChapterIdSchema>;
export type CharacterRole = z.infer<typeof CharacterRoleSchema>;
export type SpeechRegister = z.infer<typeof SpeechRegisterSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type FactionAlignment = z.infer<typeof FactionAlignmentSchema>;
export type Pov = z.infer<typeof PovSchema>;

export type SpeechStyle = z.infer<typeof SpeechStyleSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type CharacterState = z.infer<typeof CharacterStateSchema>;
export type Character = z.infer<typeof CharacterSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Faction = z.infer<typeof FactionSchema>;
export type Realm = z.infer<typeof RealmSchema>;
export type PowerSystem = z.infer<typeof PowerSystemSchema>;
export type Setting = z.infer<typeof SettingSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type Book = z.infer<typeof BookSchema>;
