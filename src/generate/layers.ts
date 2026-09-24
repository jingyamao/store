/**
 * Context Pack 的层定义。
 *
 * 这些 id 同时被「配置」（预算占比）与「组装器」（层语义）引用，
 * 因此单独放在这里 —— 避免 config ↔ context-pack 互相依赖。
 */

export const CONTEXT_LAYER_IDS = [
  "style",
  "global",
  "entities",
  "threads",
  "recent",
  "summaries",
] as const;

export type ContextLayerId = (typeof CONTEXT_LAYER_IDS)[number];

export const CONTEXT_LAYER_LABELS: Record<ContextLayerId, string> = {
  style: "文风锚定",
  global: "全局脉络",
  entities: "本章实体",
  threads: "伏笔线索",
  recent: "近期正文",
  summaries: "历史摘要",
};

/** 各层在「可用上下文」里的预算占比。使用时会归一化，不必凑成整数 1。 */
export const DEFAULT_LAYER_SHARES: Record<ContextLayerId, number> = {
  style: 0.08,
  global: 0.1,
  entities: 0.22,
  threads: 0.07,
  recent: 0.3,
  summaries: 0.23,
};

export const LAYER_NOTES: Record<ContextLayerId, string> = {
  style: "每章必带，且刻意不裁剪 —— 它是文风不漂的基准",
  global: "全书总纲 + 当前卷纲，提供方向感",
  entities: "本章出场人物的完整状态，以及相关物品与地点",
  threads: "本章相关伏笔，以及长期未回收的提醒",
  recent: "前 N 章全文 —— 语感连续性的关键",
  summaries: "更早章节的摘要，用于长程记忆",
};
