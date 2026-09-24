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
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { chapterNumber } from "../domain/ids.js";
import type { ChapterOutline } from "../domain/outline.js";
import { parseAiFlavorBlacklist } from "../lint/index.js";
import { createProvider } from "../llm/index.js";
import type { LlmMessage, LlmProvider } from "../llm/types.js";
import { loadBible, type Bible } from "../store/bible.js";
import { loadChapters, loadSummaries, writeChapterText } from "../store/chapters.js";
import { readTextFileOr, writeTextFile } from "../store/file-io.js";
import { chapterOutlinePath, readChapterOutline } from "../store/outlines.js";
import { resolveBook, type BookPaths } from "../store/paths.js";
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
import { countWords } from "./tokens.js";

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
    readonly picked: number;
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
  readonly onProgress?: ((message: string) => void) | undefined;
  /** 注入时钟，让 runs 目录名在测试里可预测。 */
  readonly now?: (() => Date) | undefined;
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

async function uniqueRunDir(runsDir: string, base: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const candidate = join(runsDir, name);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`无法为本次生成分配目录：${base}-* 全部被占用`);
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

  const contextPack = assembleContextPack(
    {
      bookId: resolved.id,
      outline,
      styleText,
      masterOutlineText,
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
  const clock = options.now ?? (() => new Date());
  const dryRun = options.dryRun === true;
  const targetWords = options.targetWords ?? options.config.generation.defaultTargetWords;
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
  const { paths, outline, contextPack } = sources;

  progress(
    `上下文已组装：${contextPack.usedTokens}/${contextPack.budgetTokens} token，` +
      `共 ${contextPack.layers.reduce((sum, layer) => sum + layer.items.length, 0)} 条`,
  );

  const runId = formatRunId(clock());
  await mkdir(paths.runsDir, { recursive: true });
  const runDir = await uniqueRunDir(paths.runsDir, `${runId}-${outline.chapter}`);

  const stages: RunStage[] = [];
  const warnings = [...contextPack.warnings];
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

  let openings: string[] = [];
  let pickedOpening: string | undefined;
  let draft: string | undefined;

  /* 阶段二：开篇方案 */
  if (!dryRun && provider !== undefined) {
    const openingsPrompt = buildOpeningsPrompt({
      outline,
      contextText: renderContextPack(contextPack),
      targetWords,
      povLabel,
      count: openingsCount,
    });
    const messages = buildMessages(systemPrompt, openingsPrompt);

    await writeTextFile(join(runDir, "prompt-openings.txt"), renderMessages(messages) + "\n");

    const stageStart = nowIso(clock);
    const stageStartMs = clock().getTime();

    progress(`正在生成 ${openingsCount} 个开篇方案…`);
    const result = await provider.complete(messages);

    stages.push({
      name: "openings",
      label: "开篇方案",
      startedAt: stageStart,
      finishedAt: nowIso(clock),
      durationMs: clock().getTime() - stageStartMs,
      model: result.model,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    });

    promptTokens += result.usage?.promptTokens ?? 0;
    completionTokens += result.usage?.completionTokens ?? 0;

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
    pickedOpening = chosen;
    if (chosen === undefined) {
      warnings.push("没有可用的开篇方案，改为直接生成全章");
    }
  }

  /* 阶段三：全章初稿 */
  if (!dryRun && provider !== undefined) {
    const draftPrompt = buildDraftPrompt({
      outline,
      contextText: renderContextPack(contextPack),
      targetWords,
      povLabel,
      chosenOpening: pickedOpening,
    });
    const messages = buildMessages(systemPrompt, draftPrompt);

    await writeTextFile(join(runDir, "prompt.txt"), renderMessages(messages) + "\n");

    const stageStart = nowIso(clock);
    const stageStartMs = clock().getTime();

    progress(`正在生成初稿（目标 ${targetWords} 字）…`);
    const result = await provider.complete(messages);

    stages.push({
      name: "draft",
      label: "全章初稿",
      startedAt: stageStart,
      finishedAt: nowIso(clock),
      durationMs: clock().getTime() - stageStartMs,
      model: result.model,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    });

    promptTokens += result.usage?.promptTokens ?? 0;
    completionTokens += result.usage?.completionTokens ?? 0;

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

    await writeChapterText(paths, outline.chapter, draft);
    outputFile = target;
    progress(`已写入 ${target}`);
  }

  /* 记录 */
  const finishedAt = nowIso(clock);
  const draftCheck =
    draft !== undefined
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
      picked: pick,
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

/* ── 列出历史记录 ─────────────────────────────── */

export interface RunSummary {
  readonly runId: string;
  readonly chapterId: string;
  readonly startedAt: string;
  readonly dryRun: boolean;
  readonly applied: boolean;
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
      });
    } catch {
      // 记录损坏不该让整个列表失败 —— 跳过它，其余的照常展示
    }
  }

  return summaries.sort((a, b) => b.runId.localeCompare(a.runId));
}
