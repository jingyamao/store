/**
 * 单章生成闭环。
 *
 * 三个阶段，两个人类决策点：
 *   1. 组装 Context Pack —— 纯本地，可用 --dry-run 检视，不花钱
 *   2. 生成 N 个开篇方案，作者挑一个        ← 决策点
 *   3. 按选定开篇生成全章初稿               ← 决策点：是否落盘
 *
 * 初稿默认只写进 runs/，不碰 chapters/ ——「人把关关键节点」这条原则
 * 必须体现在默认行为里，而不能指望作者每次自觉。
 *
 * 每次生成都在 runs/<runId>/ 下留一份完整记录（上下文、提示词、
 * 开篇、初稿、用量、自检），出问题时能精确复盘「当时到底发了什么」。
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { chapterNumber } from "../domain/ids.js";
import { ChapterOutlineSchema, type ChapterOutline } from "../domain/outline.js";
import { parseAiFlavorBlacklist } from "../lint/index.js";
import { createProvider } from "../llm/index.js";
import type { LlmMessage, LlmProvider } from "../llm/types.js";
import { loadBible, type Bible } from "../store/bible.js";
import { loadChapters, loadSummaries, parseChapterId, writeChapterText } from "../store/chapters.js";
import { readTextFileOr, writeTextFile } from "../store/file-io.js";
import { chapterOutlinePath, readChapterOutline } from "../store/outlines.js";
import { resolveBook, type BookPaths } from "../store/paths.js";
import { withChapterLock } from "../sync/lock.js";
import {
  assembleContextPack,
  renderContextPack,
  type ContextPack,
} from "./context-pack.js";
import {
  buildDraftPrompt,
  buildMessages,
  buildOpeningsPrompt,
  buildSystemPrompt,
  parseOpenings,
} from "./prompt.js";
import { countWords, estimateMessageTokens } from "./tokens.js";

/* ── 记录类型 ─────────────────────────────────── */

export interface RunStage {
  readonly name: string;
  readonly label: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly model: string | undefined;
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
}

export interface ContextSummaryLayer {
  readonly id: string;
  readonly label: string;
  readonly usedTokens: number;
  readonly budgetTokens: number;
  readonly itemCount: number;
  readonly droppedItems: number;
  readonly sources: readonly string[];
}

export interface DraftFinding {
  readonly level: "error" | "warn" | "info";
  readonly message: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly bookId: string;
  readonly chapterId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly dryRun: boolean;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly targetWords: number;
  readonly openings: {
    readonly requested: number;
    readonly parsed: number;
    readonly picked: number | undefined;
  };
  readonly applied: boolean;
  readonly outputFile: string | undefined;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
  };
  readonly context: {
    readonly usedTokens: number;
    readonly budgetTokens: number;
    readonly contextWindow: number;
    readonly reserveForOutput: number;
    readonly layers: readonly ContextSummaryLayer[];
  };
  readonly warnings: readonly string[];
  readonly stages: readonly RunStage[];
  readonly draftCheck: readonly DraftFinding[];
}

export interface GenerateResult {
  readonly runId: string;
  readonly runDir: string;
  readonly record: RunRecord;
  readonly contextPack: ContextPack;
  readonly openings: readonly string[];
  readonly pickedOpening: string | undefined;
  readonly draft: string | undefined;
  /** 落盘位置，仅在 --apply 时有值。 */
  readonly outputFile: string | undefined;
}

export interface GenerateOptions {
  readonly booksRoot: string;
  readonly bookId?: string | undefined;
  readonly chapterId: string;
  readonly config: ResolvedConfig;
  /** 注入 provider；不传则按配置构造（--dry-run 时不需要）。 */
  readonly provider?: LlmProvider | undefined;
  readonly dryRun?: boolean | undefined;
  readonly openings?: number | undefined;
  readonly pick?: number | undefined;
  readonly targetWords?: number | undefined;
  readonly apply?: boolean | undefined;
  readonly force?: boolean | undefined;
  /** 只生成开篇，等待作者选定后再续写。 */
  readonly openingsOnly?: boolean | undefined;
  /** 从已有开篇记录续写，不再调用开篇模型。 */
  readonly fromRun?: string | undefined;
  readonly onProgress?: ((message: string) => void) | undefined;
  /** 注入时钟，让 runs 目录名在测试里可预测。 */
  readonly now?: (() => Date) | undefined;
  /** Agent 已构造的时间点记忆；常规 write 仍使用原有装配方式。 */
  readonly contextPackOverride?: ContextPack | undefined;
  /** Agent 的章节执行计划，随提示词留档。 */
  readonly writingPlan?: string | undefined;
  readonly extraWarnings?: readonly string[] | undefined;
  /** Agent 已预留并写入规划检查点的运行目录名。 */
  readonly runDirName?: string | undefined;
  /** Agent 的阶段检查点：模型返回后立即持久化用量。 */
  readonly onStageComplete?: ((stage: RunStage) => Promise<void>) | undefined;
}

/* ── 工具 ─────────────────────────────────────── */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatRunId(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export async function allocateRunDirectory(paths: BookPaths, chapterId: string, date: Date): Promise<{ runId: string; runDir: string; name: string }> {
  const runId = formatRunId(date);
  await mkdir(paths.runsDir, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = `${runId}-${chapterId}${attempt === 0 ? "" : `-${attempt + 1}`}`;
    const runDir = join(paths.runsDir, name);
    try {
      await mkdir(runDir);
      return { runId, runDir, name };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`无法为本次生成分配目录：${runId}-${chapterId}-* 全部被占用`);
}

function renderMessages(messages: readonly LlmMessage[]): string {
  return messages
    .map((message) => `${"═".repeat(20)} ${message.role} ${"═".repeat(20)}\n\n${message.content}`)
    .join("\n\n");
}

function summarizeLayers(pack: ContextPack): ContextSummaryLayer[] {
  return pack.layers.map((layer) => ({
    id: layer.id,
    label: layer.label,
    usedTokens: layer.usedTokens,
    budgetTokens: layer.budgetTokens,
    itemCount: layer.items.length,
    droppedItems: layer.droppedItems,
    sources: layer.items.map((item) => item.source),
  }));
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

/* ── 初稿自检 ─────────────────────────────────── */

/**
 * 初稿体检。
 *
 * 只做确定性、零成本的检查。真正完整的自检四件套（AI 味检测、
 * 文风比对、爽点体检）在 M3 —— 这里只覆盖「一眼就能看出来不对」的情况，
 * 让作者在拿到初稿的同一屏里就知道它值不值得读。
 */
export function checkDraft(
  draft: string,
  options: {
    readonly targetWords: number;
    readonly blacklist: readonly string[];
    readonly castNames: readonly string[];
  },
): DraftFinding[] {
  const findings: DraftFinding[] = [];
  const words = countWords(draft);

  if (words < options.targetWords * 0.7) {
    findings.push({
      level: "warn",
      message: `初稿只有 ${words} 字，明显短于目标 ${options.targetWords} 字 —— 可能被截断了`,
    });
  } else if (words > options.targetWords * 1.4) {
    findings.push({
      level: "info",
      message: `初稿 ${words} 字，超出目标 ${options.targetWords} 字较多`,
    });
  }

  for (const term of options.blacklist) {
    const count = countOccurrences(draft, term);
    if (count > 0) {
      findings.push({
        level: "error",
        message: `命中 AI 味黑名单词「${term}」${count} 次`,
      });
    }
  }

  const missing = options.castNames.filter((name) => !draft.includes(name));
  if (missing.length > 0) {
    findings.push({
      level: "warn",
      message: `细纲里列了但正文中没出现的人物：${missing.join("、")}`,
    });
  }

  if (/^#{1,6}\s/m.test(draft) || /^\s*[-*]\s/m.test(draft)) {
    findings.push({
      level: "info",
      message: "正文里出现了 Markdown 标记",
    });
  }

  return findings;
}

function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/* ── 素材装载 ─────────────────────────────────── */

interface LoadedSources {
  readonly paths: BookPaths;
  readonly outline: ChapterOutline;
  readonly bible: Bible;
  readonly contextPack: ContextPack;
  readonly castNames: readonly string[];
  readonly styleText: string;
  readonly blacklist: readonly string[];
}

async function loadSources(
  booksRoot: string,
  bookId: string | undefined,
  chapterId: string,
  config: ResolvedConfig,
  targetWords: number,
): Promise<LoadedSources> {
  const resolved = await resolveBook(booksRoot, bookId);
  const paths = resolved.paths;

  const outline = await readChapterOutline(paths, chapterId);
  if (outline === undefined) {
    throw new Error(
      [
        `第 ${chapterNumber(chapterId)} 章还没有细纲。`,
        "",
        `  期望文件：${chapterOutlinePath(paths, chapterId)}`,
        "",
        "先运行下面这条命令生成骨架，填好之后再回来：",
        `  novel plan new ${chapterId}`,
      ].join("\n"),
    );
  }

  const bible = await loadBible(booksRoot, resolved.id);
  const chapters = await loadChapters(paths);
  const summaries = await loadSummaries(paths);
  const styleText = await readTextFileOr(paths.styleFile, "");
  const masterOutlineText = await readTextFileOr(paths.masterOutlineFile, "");
  const volumeOutlineText = outline.volume === undefined ? "" : await readTextFileOr(join(paths.volumesDir, `${outline.volume}.md`), "");
  const volumeNumber = outline.volume === undefined ? 0 : Number(outline.volume.slice(4));
  const previousVolumeSummaries = volumeNumber === 0 || !existsSync(paths.summariesDir) ? [] : await Promise.all(
    (await readdir(paths.summariesDir))
      .filter((name) => /^vol-\d{2,}\.md$/.test(name) && Number(name.slice(4, -3)) < volumeNumber)
      .sort((a, b) => Number(b.slice(4, -3)) - Number(a.slice(4, -3)))
      .map(async (name) => ({ id: name.slice(0, -3), text: await readTextFileOr(join(paths.summariesDir, name), "") })),
  );

  const contextPack = assembleContextPack(
    {
      bookId: resolved.id,
      outline,
      styleText,
      masterOutlineText,
      volumeOutlineText,
      previousVolumeSummaries,
      bible,
      chapters,
      summaries,
    },
    { budget: config.budget, generation: config.generation },
  );

  const byId = new Map(bible.characters.map((character) => [character.id, character]));
  const castNames = outline.cast
    .map((id) => byId.get(id)?.name)
    .filter((name): name is string => name !== undefined);

  return {
    paths,
    outline,
    bible,
    contextPack,
    castNames,
    styleText,
    blacklist: parseAiFlavorBlacklist(styleText),
  };
}

/* ── 主流程 ───────────────────────────────────── */

export async function generateChapter(options: GenerateOptions): Promise<GenerateResult> {
  if (options.fromRun !== undefined) {
    return continueFromOpenings(options);
  }
  if (options.openingsOnly === true && options.apply === true) {
    throw new Error("--openings-only 不能与 --apply 同时使用");
  }
  const clock = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  const planned = options.targetWords === undefined
    ? await resolveBook(options.booksRoot, options.bookId).then((book) => readChapterOutline(book.paths, options.chapterId))
    : undefined;
  const targetWords = options.targetWords ?? planned?.targetWords ?? options.config.generation.defaultTargetWords;
  const openingsCount = options.openings ?? options.config.generation.openings;
  const pick = options.pick ?? 1;

  const progress = options.onProgress ?? ((): void => {});

  const startedAt = nowIso(clock);
  const startedMs = clock().getTime();

  const sources = await loadSources(
    options.booksRoot,
    options.bookId,
    options.chapterId,
    options.config,
    targetWords,
  );
  const { paths, outline } = sources;
  const contextPack = options.contextPackOverride ?? sources.contextPack;
  if (contextPack.bookId !== sources.bible.bookId || contextPack.chapterId !== outline.chapter) {
    throw new Error("Agent 记忆与当前书籍或章节不符");
  }
  const contextText = renderContextPack(contextPack) +
    (options.writingPlan === undefined ? "" : `\n\n【本章执行计划】\n${options.writingPlan}`);

  progress(
    `上下文已组装：${contextPack.usedTokens}/${contextPack.budgetTokens} token，` +
      `共 ${contextPack.layers.reduce((sum, layer) => sum + layer.items.length, 0)} 条`,
  );

  const allocated = options.runDirName === undefined
    ? await allocateRunDirectory(paths, outline.chapter, clock())
    : (() => {
        const match = /^[0-9]{8}-[0-9]{6}-(ch-[0-9]{4,})(?:-[0-9]+)?$/.exec(options.runDirName);
        if (match?.[1] !== outline.chapter) throw new Error("非法 Agent 运行目录名");
        return { runId: options.runDirName.slice(0, 15), runDir: join(paths.runsDir, options.runDirName), name: options.runDirName };
      })();
  const { runId, runDir } = allocated;

  const stages: RunStage[] = [];
  const warnings = [...contextPack.warnings, ...(options.extraWarnings ?? [])];
  let promptTokens = 0;
  let completionTokens = 0;

  const povLabel =
    outline.povCharacter !== undefined
      ? (sources.bible.characters.find((c) => c.id === outline.povCharacter)?.name ??
        outline.povCharacter)
      : undefined;

  const systemPrompt = buildSystemPrompt({
    blacklist: sources.blacklist,
    pov: sources.bible.book.pov,
  });

  // dry-run 不该要求密钥，因此只有在真要调用时才构造 provider
  const provider: LlmProvider | undefined =
    dryRun ? undefined : (options.provider ?? createProvider(options.config));

  /* 阶段一：上下文落盘 —— 无论是否 dry-run 都写，方便复盘 */
  await mkdir(runDir, { recursive: true });
  await writeTextFile(
    join(runDir, "context.json"),
    JSON.stringify(contextPack, null, 2) + "\n",
  );
  await writeTextFile(join(runDir, "outline.json"), JSON.stringify(outline, null, 2) + "\n");

  let openings: string[] = [];
  let pickedOpening: string | undefined;
  let draft: string | undefined;

  /* 阶段二：开篇方案 */
  if (!dryRun && provider !== undefined) {
    const openingsPrompt = buildOpeningsPrompt({
      outline,
      contextText,
      targetWords,
      povLabel,
      count: openingsCount,
    });
    const messages = buildMessages(systemPrompt, openingsPrompt);
    if (options.contextPackOverride !== undefined && estimateMessageTokens(messages) + contextPack.reserveForOutput > options.config.budget.contextWindow) {
      throw new Error("Agent 开篇提示词超过配置的上下文窗口；请缩短细纲或调大 contextWindow");
    }

    await writeTextFile(join(runDir, "prompt-openings.txt"), renderMessages(messages) + "\n");

    const stageStart = nowIso(clock);
    const stageStartMs = clock().getTime();

    progress(`正在生成 ${openingsCount} 个开篇方案…`);
    const result = await provider.complete(messages);

    const openingsStage: RunStage = {
      name: "openings",
      label: "开篇方案",
      startedAt: stageStart,
      finishedAt: nowIso(clock),
      durationMs: clock().getTime() - stageStartMs,
      model: result.model,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    };
    stages.push(openingsStage);

    promptTokens += result.usage?.promptTokens ?? 0;
    completionTokens += result.usage?.completionTokens ?? 0;
    await options.onStageComplete?.(openingsStage);

    openings = parseOpenings(result.text, openingsCount);
    if (openings.length === 0) {
      warnings.push("开篇方案解析为空 —— 模型没有按格式输出，也没能按空行兜底切分");
    } else if (openings.length < openingsCount) {
      warnings.push(`只解析出 ${openings.length} 个开篇方案（期望 ${openingsCount} 个）`);
    }

    await writeTextFile(
      join(runDir, "openings.md"),
      openings.map((entry, index) => `## 方案 ${index + 1}\n\n${entry}`).join("\n\n") + "\n",
    );

    const chosen = openings[pick - 1] ?? openings[0];
    pickedOpening = options.openingsOnly === true ? undefined : chosen;
    if (chosen === undefined) {
      warnings.push("没有可用的开篇方案，改为直接生成全章");
    }
  }

  /* 阶段三：全章初稿 */
  if (!dryRun && provider !== undefined && options.openingsOnly !== true) {
    const draftPrompt = buildDraftPrompt({
      outline,
      contextText,
      targetWords,
      povLabel,
      chosenOpening: pickedOpening,
    });
    const messages = buildMessages(systemPrompt, draftPrompt);
    if (options.contextPackOverride !== undefined && estimateMessageTokens(messages) + contextPack.reserveForOutput > options.config.budget.contextWindow) {
      throw new Error("Agent 初稿提示词超过配置的上下文窗口；请缩短细纲或调大 contextWindow");
    }

    await writeTextFile(join(runDir, "prompt.txt"), renderMessages(messages) + "\n");

    const stageStart = nowIso(clock);
    const stageStartMs = clock().getTime();

    progress(`正在生成初稿（目标 ${targetWords} 字）…`);
    const result = await provider.complete(messages);

    const draftStage: RunStage = {
      name: "draft",
      label: "全章初稿",
      startedAt: stageStart,
      finishedAt: nowIso(clock),
      durationMs: clock().getTime() - stageStartMs,
      model: result.model,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    };
    stages.push(draftStage);

    promptTokens += result.usage?.promptTokens ?? 0;
    completionTokens += result.usage?.completionTokens ?? 0;
    await options.onStageComplete?.(draftStage);

    draft = result.text.trim();
    await writeTextFile(join(runDir, "draft.md"), draft + "\n");
  }

  /* 可选：落盘到 chapters/ */
  let outputFile: string | undefined;
  if (options.apply === true) {
    if (draft === undefined) {
      throw new Error("--apply 需要先生成初稿，不能与 --dry-run 同时使用");
    }

    const target = join(paths.chaptersDir, `${outline.chapter}.md`);
    await withChapterLock(paths, async () => {
      if (existsSync(target) && options.force !== true) {
        const existing = (await readTextFileOr(target, "")).trim();
        if (existing !== "") {
          throw new Error(
            [
              `${outline.chapter}.md 已经有内容了，拒绝覆盖。`,
              "",
              `  目标文件：${target}`,
              "",
              "确认要覆盖请加 --force；只想看看生成结果的话，",
              `它已经保存在 ${join(runDir, "draft.md")}。`,
            ].join("\n"),
          );
        }
      }
      await writeChapterText(paths, outline.chapter, draft, "adopt");
    });
    outputFile = target;
    progress(`已写入 ${target}`);
  }

  /* 记录 */
  const finishedAt = nowIso(clock);
  const draftCheck =
    draft !== undefined && options.config.generation.lintDraft
      ? checkDraft(draft, {
          targetWords,
          blacklist: sources.blacklist,
          castNames: sources.castNames,
        })
      : [];

  const record: RunRecord = {
    runId,
    bookId: sources.bible.bookId,
    chapterId: outline.chapter,
    startedAt,
    finishedAt,
    durationMs: clock().getTime() - startedMs,
    dryRun,
    provider: provider?.name,
    model: provider?.model,
    targetWords,
    openings: {
      requested: dryRun ? 0 : openingsCount,
      parsed: openings.length,
      picked: options.openingsOnly === true || dryRun ? undefined : pick,
    },
    applied: outputFile !== undefined,
    outputFile,
    usage: { promptTokens, completionTokens },
    context: {
      usedTokens: contextPack.usedTokens,
      budgetTokens: contextPack.budgetTokens,
      contextWindow: contextPack.contextWindow,
      reserveForOutput: contextPack.reserveForOutput,
      layers: summarizeLayers(contextPack),
    },
    warnings,
    stages,
    draftCheck,
  };

  await writeTextFile(join(runDir, "run.json"), JSON.stringify(record, null, 2) + "\n");

  return {
    runId,
    runDir,
    record,
    contextPack,
    openings,
    pickedOpening,
    draft,
    outputFile,
  };
}

function runDirectory(paths: BookPaths, name: string): string {
  if (!/^[0-9]{8}-[0-9]{6}-ch-[0-9]{4,}(?:-[0-9]+)?$/.test(name)) {
    throw new Error(`非法生成记录 id：${name}`);
  }
  return join(paths.runsDir, name);
}

/** 将作者已审阅的 draft.md 原样采用；不会再次调用模型。 */
export async function applyExistingRun(
  paths: BookPaths,
  name: string,
  force = false,
  expectedHash?: string,
): Promise<string> {
  const dir = runDirectory(paths, name);
  const recordFile = join(dir, "run.json");
  if (!existsSync(recordFile)) throw new Error(`找不到生成记录：${name}`);
  const record = JSON.parse(await readTextFileOr(recordFile, "{}")) as RunRecord;
  if (record.bookId !== paths.root.split(/[\\/]/).at(-1)) {
    throw new Error(`生成记录 ${name} 不属于当前书籍`);
  }
  const draftFile = join(dir, "draft.md");
  if (!existsSync(draftFile)) throw new Error(`生成记录 ${name} 还没有初稿`);
  const draft = await readTextFileOr(draftFile, "");
  if (draft.trim() === "") throw new Error(`生成记录 ${name} 的初稿为空`);
  const target = join(paths.chaptersDir, `${parseChapterId(record.chapterId)}.md`);
  await withChapterLock(paths, async () => {
    const current = await readTextFileOr(target, "");
    if (expectedHash !== undefined && createHash("sha256").update(current).digest("hex") !== expectedHash) {
      throw new Error(`${record.chapterId} 的正文已被其他操作修改，请重新打开章节后再采用`);
    }
    if (!force && current.trim() !== "") {
      throw new Error(`${record.chapterId} 已有正文；确认覆盖请加 --force`);
    }
    await writeChapterText(paths, record.chapterId, draft, "adopt");
  });
  await writeTextFile(recordFile, JSON.stringify({ ...record, applied: true, outputFile: target }, null, 2) + "\n");
  return target;
}

/** 读取已保存的开篇和初稿，供写作台在刷新后继续审阅。 */
export async function readRunDetails(paths: BookPaths, name: string): Promise<{ record: RunRecord; openings: string[]; draft: string | null; agentPlan: string | null; memorySources: string[] }> {
  const dir = runDirectory(paths, name);
  const recordFile = join(dir, "run.json");
  if (!existsSync(recordFile)) throw new Error(`找不到生成记录：${name}`);
  const record = JSON.parse(await readTextFileOr(recordFile, "{}")) as RunRecord;
  if (record.bookId !== paths.root.split(/[\\/]/).at(-1)) throw new Error(`生成记录 ${name} 不属于当前书籍`);
  const openingsText = await readTextFileOr(join(dir, "openings.md"), "");
  const openings = openingsText.split(/^## 方案 \d+\s*$/m).map((part) => part.trim()).filter(Boolean);
  const draftText = await readTextFileOr(join(dir, "draft.md"), "");
  const agentPlan = await readTextFileOr(join(dir, "agent-plan.md"), "");
  const memoryText = await readTextFileOr(join(dir, "agent-memory.json"), "");
  const memory = memoryText === "" ? null : JSON.parse(memoryText) as { evidence?: Array<{ source: string }>; facts?: Array<{ source: string }> };
  return { record, openings, draft: draftText.trim() === "" ? null : draftText,
    agentPlan: agentPlan.trim() === "" ? null : agentPlan,
    memorySources: [...(memory?.evidence?.map((item) => item.source) ?? []), ...(memory?.facts?.map((item) => item.source) ?? [])] };
}

/** 继续一条仅生成开篇的记录，使用其原始上下文和细纲快照。 */
async function continueFromOpenings(options: GenerateOptions): Promise<GenerateResult> {
  if (options.apply === true || options.dryRun === true || options.openingsOnly === true) {
    throw new Error("--from-run 只能用于续写初稿；采用已有稿请运行 novel adopt");
  }
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const paths = resolved.paths;
  const dir = runDirectory(paths, options.fromRun ?? "");
  const recordFile = join(dir, "run.json");
  if (!existsSync(recordFile)) throw new Error(`找不到生成记录：${options.fromRun}`);
  const old = JSON.parse(await readTextFileOr(recordFile, "{}")) as RunRecord;
  if (old.bookId !== resolved.id || old.chapterId !== options.chapterId) {
    throw new Error("生成记录与当前书籍或章节不符");
  }
  if (old.stages.some((stage) => stage.name === "draft")) {
    throw new Error("这条记录已有初稿；请使用 novel adopt 采用它");
  }
  const pack = JSON.parse(await readTextFileOr(join(dir, "context.json"), "{}")) as ContextPack;
  const outline = ChapterOutlineSchema.parse(JSON.parse(await readTextFileOr(join(dir, "outline.json"), "{}")) as unknown);
  const openingsText = await readTextFileOr(join(dir, "openings.md"), "");
  const openings = openingsText.split(/^## 方案 \d+\s*$/m).map((part) => part.trim()).filter(Boolean);
  const pick = options.pick ?? 1;
  if (!Number.isInteger(pick) || pick < 1 || pick > openings.length) {
    throw new Error(`请选择 1 到 ${openings.length} 之间的开篇方案`);
  }
  const bible = await loadBible(options.booksRoot, resolved.id);
  const styleText = await readTextFileOr(paths.styleFile, "");
  const systemPrompt = buildSystemPrompt({ blacklist: parseAiFlavorBlacklist(styleText), pov: bible.book.pov });
  const povLabel = outline.povCharacter === undefined
    ? undefined
    : (bible.characters.find((c) => c.id === outline.povCharacter)?.name ?? outline.povCharacter);
  const chosenOpening = openings[pick - 1] ?? "";
  const prompt = buildDraftPrompt({ outline, contextText: renderContextPack(pack), targetWords: old.targetWords, povLabel, chosenOpening });
  const messages = buildMessages(systemPrompt, prompt);
  if (estimateMessageTokens(messages) + pack.reserveForOutput > options.config.budget.contextWindow) {
    throw new Error("续写提示词超过配置的上下文窗口；请缩短开篇或调大 contextWindow");
  }
  await writeTextFile(join(dir, "prompt.txt"), renderMessages(messages) + "\n");
  const provider = options.provider ?? createProvider(options.config);
  const startedAt = new Date().toISOString();
  const result = await provider.complete(messages);
  const draft = result.text.trim();
  await writeTextFile(join(dir, "draft.md"), draft + "\n");
  const finishedAt = new Date().toISOString();
  const updated: RunRecord = {
    ...old,
    finishedAt,
    openings: { ...old.openings, picked: pick },
    model: result.model,
    usage: { promptTokens: old.usage.promptTokens + (result.usage?.promptTokens ?? 0), completionTokens: old.usage.completionTokens + (result.usage?.completionTokens ?? 0) },
    stages: [...old.stages, { name: "draft", label: "全章初稿", startedAt, finishedAt, durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(), model: result.model, promptTokens: result.usage?.promptTokens, completionTokens: result.usage?.completionTokens }],
    draftCheck: options.config.generation.lintDraft
      ? checkDraft(draft, { targetWords: old.targetWords, blacklist: parseAiFlavorBlacklist(styleText), castNames: outline.cast.map((id) => bible.characters.find((c) => c.id === id)?.name).filter((name): name is string => name !== undefined) })
      : [],
  };
  await writeTextFile(recordFile, JSON.stringify(updated, null, 2) + "\n");
  return { runId: old.runId, runDir: dir, record: updated, contextPack: pack, openings, pickedOpening: chosenOpening, draft, outputFile: undefined };
}

/* ── 列出历史记录 ─────────────────────────────── */

export interface RunSummary {
  readonly runId: string;
  readonly chapterId: string;
  readonly startedAt: string;
  readonly dryRun: boolean;
  readonly applied: boolean;
  readonly hasDraft: boolean;
  readonly usedTokens: number;
  /** 初稿体检里 error + warn 的数量，用于一眼看出哪次生成有问题。 */
  readonly problems: number;
}

export async function listRuns(paths: BookPaths): Promise<RunSummary[]> {
  if (!existsSync(paths.runsDir)) return [];

  const entries = await readdir(paths.runsDir, { withFileTypes: true });
  const summaries: RunSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const recordFile = join(paths.runsDir, entry.name, "run.json");
    if (!existsSync(recordFile)) continue;

    try {
      const record = JSON.parse(await readTextFileOr(recordFile, "{}")) as Partial<RunRecord>;
      summaries.push({
        runId: entry.name,
        chapterId: record.chapterId ?? "",
        startedAt: record.startedAt ?? "",
        dryRun: record.dryRun === true,
        applied: record.applied === true,
        hasDraft: record.stages?.some((stage) => stage.name === "draft") === true,
        usedTokens: record.context?.usedTokens ?? 0,
        problems: (record.draftCheck ?? []).filter((finding) => finding.level !== "info").length,
      });
    } catch {
      // 记录损坏不该让整个列表失败 —— 跳过它，其余的照常展示
    }
  }

  return summaries.sort((a, b) => b.runId.localeCompare(a.runId));
}
