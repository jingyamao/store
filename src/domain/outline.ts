/**
 * 章节细纲。
 *
 * 细纲是人机协作的第一个人为决策点：作者定「本章要发生什么」，
 * AI 负责「怎么写」。所以这里的字段刻意都是「意图」而非「文笔」。
 */

import { z } from "zod";
import {
  ChapterIdSchema,
  CharacterIdSchema,
  ItemIdSchema,
  LocationIdSchema,
  ThreadIdSchema,
} from "./schemas.js";

export const ChapterOutlineSchema = z.object({
  chapter: ChapterIdSchema,

  /** 本章标题。可留空，生成时由模型拟。 */
  title: z.string().default(""),

  /** 本章要达成什么（情节层面的一句话）。 */
  intent: z.string().default(""),

  /** 核心冲突：谁想要什么，什么在阻挡。 */
  conflict: z.string().default(""),

  /* ── 出场实体：决定装配上下文时注入哪些卡 ── */

  cast: z.array(CharacterIdSchema).default([]),
  locations: z.array(LocationIdSchema).default([]),
  items: z.array(ItemIdSchema).default([]),

  /* ── 伏笔 ── */

  /** 本章要埋下的新伏笔。 */
  plantThreads: z.array(ThreadIdSchema).default([]),
  /** 本章要推进或回收的旧伏笔。 */
  advanceThreads: z.array(ThreadIdSchema).default([]),

  /* ── 硬性要求 ── */

  /** 必须写到的要点。 */
  mustInclude: z.array(z.string().min(1)).default([]),
  /** 本章禁止出现的内容（防止提前泄底）。 */
  forbidden: z.array(z.string().min(1)).default([]),

  /* ── 覆盖项 ── */

  /** 目标字数，覆盖全局配置。 */
  targetWords: z.number().int().positive().optional(),
  /** 视角人物，覆盖默认视角。 */
  povCharacter: CharacterIdSchema.optional(),

  notes: z.string().optional(),
});

export type ChapterOutline = z.infer<typeof ChapterOutlineSchema>;

/** 从零构造一份骨架细纲。 */
export function scaffoldChapterOutline(chapterId: string, title = ""): ChapterOutline {
  return ChapterOutlineSchema.parse({ chapter: chapterId, title });
}
