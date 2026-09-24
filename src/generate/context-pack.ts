/**
 * Context Pack 组装。
 *
 * 生成质量的上限由「模型看到了什么」决定，长篇写作尤其如此：模型没有长期
 * 记忆，写到第 200 章时它对第 7 章埋的伏笔一无所知 —— 除非我们主动放进去。
 *
 * 但上下文窗口有限，所以这里做两件事：
 *   1. **分层** —— 不同性质的信息各有独立预算，互不挤占。
 *      文风不会被正文挤掉，伏笔不会被人物卡挤掉。
 *   2. **按优先级裁剪** —— 预算不够时丢掉最不重要的，而不是随机丢。
 *
 * 组装是纯函数：给定同样的输入必然得到同样的 Context Pack，
 * 因此可以精确测试，也让 runs/ 记录具备可复现性。
 */

import type { BudgetConfig, GenerationConfig, LayerBudget } from "../config/index.js";
import { chapterNumber } from "../domain/ids.js";
import type { ChapterOutline } from "../domain/outline.js";
import type { Character, Item, Location, Thread } from "../domain/schemas.js";
import type { Bible } from "../store/bible.js";
import { dumpYaml } from "../store/file-io.js";
import { CONTEXT_LAYER_IDS, CONTEXT_LAYER_LABELS, type ContextLayerId } from "./layers.js";
import {
  DEFAULT_TOKEN_OPTIONS,
  estimateTokens,
  truncateToTokens,
  type TokenEstimatorOptions,
} from "./tokens.js";

/**
 * 截断一条内容至少要有这么多 token 才值得做。
 * 低于这个值，塞进去的碎片还不如留白 —— 半个句子对模型的干扰大于帮助。
 */
const MIN_PARTIAL_TOKENS = 64;

/** 未回收伏笔的默认提醒阈值（章）。 */
const DEFAULT_THREAD_EXPIRY = 60;

/* ── 优先级 ───────────────────────────────────── */

/** 人物的基础优先级，按角色重要性排序。 */
const ROLE_PRIORITY: Record<string, number> = {
  protagonist: 84,
  deuteragonist: 80,
  antagonist: 78,
  supporting: 70,
  cameo: 62,
};

const PRIORITY = {
  styleAnchor: 100,
  styleForbidden: 95,
  masterOutline: 90,
  volumeOutline: 86,
  povCharacter: 88,
  powerSystem: 82,
  recentBase: 85,
  recentStep: 3,
  outlineThread: 78,
  ambientThreadBase: 60,
  item: 62,
  location: 58,
  summary: 55,
} as const;

/* ── 类型 ─────────────────────────────────────── */

/** 单条上下文片段。 */
export interface ContextItem {
  /** 来源标识 —— runs 记录靠它回溯「这段是谁提供的」。 */
  readonly source: string;
  readonly text: string;
  readonly tokens: number;
  /** 越大越优先保留。 */
  readonly priority: number;
  readonly truncated: boolean;
}

export interface ContextLayer {
  readonly id: ContextLayerId;
  readonly label: string;
  readonly budgetTokens: number;
  readonly items: readonly ContextItem[];
  readonly usedTokens: number;
  /** 因预算不足被整条丢弃的条目数。 */
  readonly droppedItems: number;
}

export interface ContextPack {
  readonly bookId: string;
  readonly chapterId: string;
  readonly layers: readonly ContextLayer[];
  readonly usedTokens: number;
  /** 可供上下文使用的 token（已扣掉输出预留）。 */
  readonly budgetTokens: number;
  readonly contextWindow: number;
  readonly reserveForOutput: number;
  /** 需要作者留意的问题，例如某一层被裁得太狠。 */
  readonly warnings: readonly string[];
}

/** 组装 Context Pack 所需的全部素材。 */
export interface ContextSources {
  readonly bookId: string;
  readonly outline: ChapterOutline;
  readonly styleText: string;
  readonly masterOutlineText: string;
  readonly volumeOutlineText?: string | undefined;
  readonly bible: Bible;
  readonly chapters: ReadonlyMap<string, string>;
  /** 章节 id → 摘要。M4 之后才会有内容。 */
  readonly summaries: ReadonlyMap<string, string>;
  /** 未回收伏笔的提醒阈值（章）。 */
  readonly threadExpiryChapters?: number | undefined;
}

export interface AssembleOptions {
  readonly budget: BudgetConfig;
  readonly generation: GenerationConfig;
  readonly tokenOptions?: TokenEstimatorOptions | undefined;
}

/** 内部待打包条目 —— 还没有算 token。 */
interface PendingItem {
  readonly source: string;
  readonly text: string;
  readonly priority: number;
}

/* ── 预算分配 ─────────────────────────────────── */

export interface BudgetAllocation {
  /** 上下文可用的 token 总量。 */
  readonly total: number;
  readonly perLayer: Record<ContextLayerId, number>;
}

/**
 * 把上下文窗口切成各层预算。
 *
 * 占比会先归一化，所以配置里写成 0.08 或 8 都行。
 * 用 floor 而不是 round：宁可少给几 token，也不要因为四舍五入而超出窗口。
 */
export function allocateBudget(budget: BudgetConfig, shares?: LayerBudget): BudgetAllocation {
  const source = shares ?? budget.layers;
  const total = Math.max(0, budget.contextWindow - budget.reserveForOutput);

  const sum = CONTEXT_LAYER_IDS.reduce((acc, id) => acc + Math.max(0, source[id]), 0);

  const perLayer = {} as Record<ContextLayerId, number>;

  if (sum <= 0) {
    // 配置全为 0 时退化为均分 —— 总比一条上下文都不给强
    const each = Math.floor(total / CONTEXT_LAYER_IDS.length);
    for (const id of CONTEXT_LAYER_IDS) perLayer[id] = each;
    return { total, perLayer };
  }

  for (const id of CONTEXT_LAYER_IDS) {
    perLayer[id] = Math.floor((Math.max(0, source[id]) / sum) * total);
  }

  return { total, perLayer };
}

/* ── 各层素材 ─────────────────────────────────── */

function indexById<T extends { id: string }>(entities: readonly T[]): Map<string, T> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

/**
 * 去掉空值再序列化。
 *
 * Bible 里大量字段是空数组（injuries: []、goals: []），
 * 逐个渲染进上下文纯属浪费 token，而且会稀释真正有信息量的部分。
 */
function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.map(stripEmpty).filter((entry) => entry !== undefined);
    return kept.length > 0 ? kept : undefined;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, stripEmpty(entry)] as const)
      .filter(([, entry]) => entry !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  if (value === null || value === undefined || value === "") return undefined;
  // false 与 0 是有意义的取值（alive: false 尤其不能丢），原样保留
  return value;
}

function renderEntity(entity: unknown): string {
  const compact = stripEmpty(entity);
  return dumpYaml(compact ?? {});
}

function characterById(sources: ContextSources): Map<string, Character> {
  return indexById(sources.bible.characters);
}

/** 本章真正需要的实体 —— 细纲显式列出的，加上由人物状态推导出来的。 */
function referencedIds(sources: ContextSources): {
  characters: string[];
  items: string[];
  locations: string[];
} {
  const characters = new Set(sources.outline.cast);
  if (sources.outline.povCharacter !== undefined) {
    characters.add(sources.outline.povCharacter);
  }

  const items = new Set(sources.outline.items);
  const locations = new Set(sources.outline.locations);

  const byId = characterById(sources);
  for (const id of characters) {
    const character = byId.get(id);
    if (character === undefined) continue;

    // 人物此刻在哪里、手里有什么 —— 这两样必须一起进上下文，
    // 否则模型会写出「人在落霞谷却握着留在青云宗的刀」这类矛盾
    const location = character.state.location;
    if (location !== undefined && location !== "") locations.add(location);
    for (const item of character.state.possession) items.add(item);
  }

  return {
    characters: [...characters],
    items: [...items],
    locations: [...locations],
  };
}

function styleItems(sources: ContextSources): PendingItem[] {
  const items: PendingItem[] = [];

  const style = sources.styleText.trim();
  if (style !== "") {
    items.push({ source: "style.md", text: style, priority: PRIORITY.styleAnchor });
  }

  // 把出场人物的硬性禁忌汇总成一条 —— 这些是「写崩人设」的高发区
  const byId = characterById(sources);
  const lines: string[] = [];
  for (const id of sources.outline.cast) {
    const character = byId.get(id);
    if (character === undefined) continue;
    for (const rule of character.forbidden) {
      lines.push(`- ${character.name}：${rule}`);
    }
  }

  if (lines.length > 0) {
    items.push({
      source: "bible/characters.yaml#forbidden",
      text: ["【人物硬性禁忌 —— 违反即为写崩】", ...lines].join("\n"),
      priority: PRIORITY.styleForbidden,
    });
  }

  return items;
}

function globalItems(sources: ContextSources): PendingItem[] {
  const items: PendingItem[] = [];

  const master = sources.masterOutlineText.trim();
  if (master !== "") {
    items.push({ source: "outline/master.md", text: master, priority: PRIORITY.masterOutline });
  }

  const volume = sources.volumeOutlineText?.trim() ?? "";
  if (volume !== "") {
    items.push({ source: "outline/volumes", text: volume, priority: PRIORITY.volumeOutline });
  }

  const powerSystem = renderEntity(sources.bible.powerSystem).trim();
  if (powerSystem !== "" && powerSystem !== "{}") {
    items.push({
      source: "bible/power_system.yaml",
      text: `【境界体系】\n${powerSystem}`,
      priority: PRIORITY.powerSystem,
    });
  }

  return items;
}

function entityItems(sources: ContextSources): PendingItem[] {
  const items: PendingItem[] = [];
  const refs = referencedIds(sources);

  const pov = sources.outline.povCharacter;
  const characters = indexById(sources.bible.characters);

  for (const id of refs.characters) {
    const character = characters.get(id);
    if (character === undefined) continue;

    // 视角人物最重要 —— 整章的语感与信息边界都由他决定
    const priority =
      id === pov
        ? PRIORITY.povCharacter
        : (ROLE_PRIORITY[character.role] ?? PRIORITY.item);

    items.push({
      source: `bible/characters.yaml#${character.id}`,
      text: `【人物】\n${renderEntity(character)}`,
      priority,
    });
  }

  const allItems = indexById(sources.bible.items);
  for (const id of refs.items) {
    const item: Item | undefined = allItems.get(id);
    if (item === undefined) continue;
    items.push({
      source: `bible/items.yaml#${item.id}`,
      text: `【物品】\n${renderEntity(item)}`,
      priority: PRIORITY.item,
    });
  }

  const allLocations = indexById(sources.bible.locations);
  for (const id of refs.locations) {
    const location: Location | undefined = allLocations.get(id);
    if (location === undefined) continue;
    items.push({
      source: `bible/locations.yaml#${location.id}`,
      text: `【地点】\n${renderEntity(location)}`,
      priority: PRIORITY.location,
    });
  }

  return items;
}

function threadItems(sources: ContextSources, expiry: number): PendingItem[] {
  const items: PendingItem[] = [];
  const byId = indexById(sources.bible.threads);
  const seen = new Set<string>();
  const current = chapterNumber(sources.outline.chapter);

  const push = (thread: Thread, priority: number, header: string): void => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    items.push({
      source: `bible/threads.yaml#${thread.id}`,
      text: `${header}\n${renderEntity(thread)}`,
      priority,
    });
  };

  for (const id of sources.outline.advanceThreads) {
    const thread = byId.get(id);
    if (thread !== undefined) push(thread, PRIORITY.outlineThread, "【本章需推进或回收】");
  }

  for (const id of sources.outline.plantThreads) {
    const thread = byId.get(id);
    if (thread !== undefined) push(thread, PRIORITY.outlineThread, "【本章需埋下】");
  }

  // 其余未回收的伏笔也带上 —— 这是「伏笔不被遗忘」的主要保障。
  // 埋得越久优先级越高，因为越久越容易被读者判定为「作者忘了」。
  const ambient = sources.bible.threads
    .filter((thread) => thread.status === "open" || thread.status === "hinted")
    .map((thread) => {
      const plantedAt =
        thread.plantedAt !== undefined ? chapterNumber(thread.plantedAt) : current;
      const age = Math.max(0, current - plantedAt);
      return { thread, age };
    })
    .sort((a, b) => b.age - a.age || a.thread.id.localeCompare(b.thread.id));

  for (const { thread, age } of ambient) {
    const overdue = age >= expiry ? "，已明显超期" : "";
    push(
      thread,
      PRIORITY.ambientThreadBase + Math.min(12, age),
      `【未回收，已埋 ${age} 章${overdue}】`,
    );
  }

  return items;
}

function recentItems(sources: ContextSources, generation: GenerationConfig): PendingItem[] {
  const current = chapterNumber(sources.outline.chapter);

  const recent = [...sources.chapters.keys()]
    .filter((id) => chapterNumber(id) < current)
    .sort((a, b) => chapterNumber(b) - chapterNumber(a))
    .slice(0, generation.recentChapters);

  return recent.map((id, index) => ({
    source: `chapters/${id}.md`,
    text: `【第 ${chapterNumber(id)} 章正文】\n${(sources.chapters.get(id) ?? "").trim()}`,
    // 越近的章节对语感的影响越大
    priority: PRIORITY.recentBase - index * PRIORITY.recentStep,
  }));
}

function summaryItems(sources: ContextSources, generation: GenerationConfig): PendingItem[] {
  const current = chapterNumber(sources.outline.chapter);
  // 已经被 recent 层全文覆盖的章节不必再放摘要
  const cutoff = current - generation.recentChapters;

  return [...sources.summaries.entries()]
    .filter(([id]) => {
      const number = chapterNumber(id);
      return number < current && number < cutoff;
    })
    .sort((a, b) => chapterNumber(b[0]) - chapterNumber(a[0]))
    .map(([id, text]) => ({
      source: `summaries/${id}`,
      text: `【第 ${chapterNumber(id)} 章摘要】\n${text.trim()}`,
      priority: PRIORITY.summary,
    }));
}

/* ── 打包 ─────────────────────────────────────── */

function packLayer(
  id: ContextLayerId,
  pending: readonly PendingItem[],
  budgetTokens: number,
  tokenOptions: TokenEstimatorOptions,
): ContextLayer {
  // 稳定排序：优先级相同时保持插入顺序，保证组装结果可复现
  const sorted = pending
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.priority - a.item.priority || a.index - b.index)
    .map((entry) => entry.item);

  const items: ContextItem[] = [];
  let usedTokens = 0;
  let droppedItems = 0;

  for (const candidate of sorted) {
    const tokens = estimateTokens(candidate.text, tokenOptions);
    const remaining = budgetTokens - usedTokens;

    if (tokens <= remaining) {
      items.push({ ...candidate, tokens, truncated: false });
      usedTokens += tokens;
      continue;
    }

    if (remaining >= MIN_PARTIAL_TOKENS) {
      const sliced = truncateToTokens(candidate.text, remaining, tokenOptions);
      items.push({
        ...candidate,
        text: sliced.text,
        tokens: sliced.tokens,
        truncated: true,
      });
      usedTokens += sliced.tokens;
      continue;
    }

    // 放不下，且剩余空间不值得截断 —— 整条丢弃。
    // 不 break：后面还有更小的条目，它们也许塞得进这点空隙。
    droppedItems += 1;
  }

  return {
    id,
    label: CONTEXT_LAYER_LABELS[id],
    budgetTokens,
    items,
    usedTokens,
    droppedItems,
  };
}

function collectWarnings(layers: readonly ContextLayer[], sources: ContextSources): string[] {
  const warnings: string[] = [];

  for (const layer of layers) {
    if (layer.droppedItems > 0) {
      warnings.push(`「${layer.label}」有 ${layer.droppedItems} 条因预算不足被整条丢弃`);
    }
    const truncated = layer.items.filter((item) => item.truncated);
    if (truncated.length > 0) {
      const sourcesList = truncated.map((item) => item.source).join("、");
      warnings.push(`「${layer.label}」有 ${truncated.length} 条被截断：${sourcesList}`);
    }
  }

  const styleLayer = layers.find((layer) => layer.id === "style");
  if (sources.styleText.trim() === "") {
    warnings.push("style.md 是空的 —— 没有文风锚定，文风极易漂移");
  } else if (styleLayer?.items.some((item) => item.truncated) === true) {
    warnings.push("文风锚定被截断了 —— 建议调大 style 层预算，或精简 style.md");
  }

  if (sources.masterOutlineText.trim() === "") {
    warnings.push("全书总纲是空的 —— 模型不知道这一章在整体中处于什么位置");
  }

  return warnings;
}

/* ── 入口 ─────────────────────────────────────── */

export function assembleContextPack(
  sources: ContextSources,
  options: AssembleOptions,
): ContextPack {
  const tokenOptions = options.tokenOptions ?? DEFAULT_TOKEN_OPTIONS;
  const { total, perLayer } = allocateBudget(options.budget);
  const expiry = sources.threadExpiryChapters ?? DEFAULT_THREAD_EXPIRY;

  const builders: Record<ContextLayerId, () => PendingItem[]> = {
    style: () => styleItems(sources),
    global: () => globalItems(sources),
    entities: () => entityItems(sources),
    threads: () => threadItems(sources, expiry),
    recent: () => recentItems(sources, options.generation),
    summaries: () => summaryItems(sources, options.generation),
  };

  const layers = CONTEXT_LAYER_IDS.map((id) =>
    packLayer(id, builders[id](), perLayer[id], tokenOptions),
  );

  return {
    bookId: sources.bookId,
    chapterId: sources.outline.chapter,
    layers,
    usedTokens: layers.reduce((sum, layer) => sum + layer.usedTokens, 0),
    budgetTokens: total,
    contextWindow: options.budget.contextWindow,
    reserveForOutput: options.budget.reserveForOutput,
    warnings: collectWarnings(layers, sources),
  };
}

/* ── 渲染 ─────────────────────────────────────── */

/** 把 Context Pack 渲染成喂给模型的文本。空层直接省略，不留空标题。 */
export function renderContextPack(pack: ContextPack): string {
  const sections: string[] = [];

  for (const layer of pack.layers) {
    if (layer.items.length === 0) continue;
    const body = layer.items.map((item) => item.text.trim()).join("\n\n");
    sections.push(`# ${layer.label}\n\n${body}`);
  }

  return sections.join("\n\n");
}

/** 供 runs 记录使用：每层用了多少、丢了什么。 */
export function describeContextPack(pack: ContextPack): string[] {
  return pack.layers.map((layer) => {
    const pct =
      layer.budgetTokens > 0
        ? Math.round((layer.usedTokens / layer.budgetTokens) * 100)
        : 0;
    const dropped = layer.droppedItems > 0 ? `，丢弃 ${layer.droppedItems} 条` : "";
    return `${layer.label}：${layer.usedTokens}/${layer.budgetTokens} token（${pct}%）· ${layer.items.length} 条${dropped}`;
  });
}
