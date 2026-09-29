/** 单 Agent：检索时间点记忆 → 规划章节 → 生成初稿 → 确定性自检。 */
import { join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { renderContextPack } from "../generate/context-pack.js";
import { allocateRunDirectory, generateChapter, type GenerateResult, type RunRecord, type RunStage } from "../generate/run.js";
import { estimateMessageTokens, truncateToTokens } from "../generate/tokens.js";
import { createProvider } from "../llm/index.js";
import type { LlmProvider } from "../llm/types.js";
import { writeTextFile } from "../store/file-io.js";
import { readChapterOutline } from "../store/outlines.js";
import { resolveBook } from "../store/paths.js";
import { prepareAgentMemory } from "./memory.js";

export interface AgentWriteOptions {
  readonly booksRoot: string;
  readonly bookId?: string;
  readonly chapterId: string;
  readonly config: ResolvedConfig;
  readonly provider?: LlmProvider;
  readonly dryRun?: boolean;
  readonly targetWords?: number;
  readonly onProgress?: (message: string) => void;
  readonly now?: () => Date;
}

export async function runWritingAgent(options: AgentWriteOptions): Promise<GenerateResult> {
  const clock = options.now ?? (() => new Date());
  const agentStartedAt = clock();
  const memory = await prepareAgentMemory(options);
  options.onProgress?.(`记忆已装配：${memory.pack.usedTokens}/${memory.pack.budgetTokens} token，检索到 ${memory.evidence.length} 条历史证据`);
  if (options.dryRun === true) {
    return generateChapter({ ...options, dryRun: true, contextPackOverride: memory.pack, extraWarnings: memory.warnings });
  }

  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const outline = await readChapterOutline(resolved.paths, options.chapterId);
  if (outline === undefined) throw new Error(`${options.chapterId} 尚无细纲`);
  const provider = options.provider ?? createProvider(options.config);
  const planPrompt = [
    `请为《${resolved.id}》${outline.chapter} 做一份简短的写作执行计划。`,
    "先依据下面的作者细纲和历史证据，列出 3 至 5 个连续场景：每个场景写目标、冲突、必须发生的变化。",
    "最后列出本章不能破坏的 2 至 5 项连续性约束，并注明其资料来源。",
    "只规划本章，不提前实现未来剧情。历史资料若与细纲冲突，应标出冲突，不得擅自改写作者细纲。",
    "总计不超过 900 中文字；不写正文。",
    "\n【本章细纲】\n" + JSON.stringify(outline, null, 2),
    "\n【多层记忆】\n" + renderContextPack(memory.pack),
  ].join("\n");
  const planMessages = [
    { role: "system" as const, content: "你是长篇小说的写作规划 Agent。把来源可靠的既有事实与作者计划区分清楚，输出可执行的本章场景计划。" },
    { role: "user" as const, content: planPrompt },
  ];
  if (estimateMessageTokens(planMessages) + 1400 > options.config.budget.contextWindow) {
    throw new Error("Agent 规划提示词超过配置的上下文窗口；请缩短细纲或调大 contextWindow");
  }
  const allocated = await allocateRunDirectory(resolved.paths, outline.chapter, clock());
  const { runDir } = allocated;
  let checkpoint: RunRecord = {
    runId: allocated.runId, bookId: resolved.id, chapterId: outline.chapter,
    startedAt: agentStartedAt.toISOString(), finishedAt: agentStartedAt.toISOString(), durationMs: 0,
    dryRun: false, provider: provider.name, model: provider.model,
    targetWords: options.targetWords ?? outline.targetWords ?? options.config.generation.defaultTargetWords,
    openings: { requested: options.config.generation.openings, parsed: 0, picked: undefined },
    applied: false, outputFile: undefined, usage: { promptTokens: 0, completionTokens: 0 },
    context: {
      usedTokens: memory.pack.usedTokens, budgetTokens: memory.pack.budgetTokens,
      contextWindow: memory.pack.contextWindow, reserveForOutput: memory.pack.reserveForOutput,
      layers: memory.pack.layers.map((layer) => ({
        id: layer.id, label: layer.label, usedTokens: layer.usedTokens, budgetTokens: layer.budgetTokens,
        itemCount: layer.items.length, droppedItems: layer.droppedItems, sources: layer.items.map((item) => item.source),
      })),
    },
    warnings: [...memory.pack.warnings, ...memory.warnings], stages: [], draftCheck: [],
  };
  const saveCheckpoint = async (): Promise<void> => {
    await writeTextFile(join(runDir, "run.json"), JSON.stringify(checkpoint, null, 2) + "\n");
  };
  await writeTextFile(join(runDir, "context.json"), JSON.stringify(memory.pack, null, 2) + "\n");
  await writeTextFile(join(runDir, "outline.json"), JSON.stringify(outline, null, 2) + "\n");
  await writeTextFile(join(runDir, "prompt-plan.txt"), planMessages.map((m) => `【${m.role}】\n${m.content}`).join("\n\n"));
  await writeTextFile(join(runDir, "agent-memory.json"), JSON.stringify({
    chapterId: options.chapterId,
    evidence: memory.evidence,
    facts: memory.facts,
    warnings: memory.warnings,
  }, null, 2) + "\n");
  await saveCheckpoint();

  try {
    const started = clock();
    options.onProgress?.("正在规划本章场景与连续性约束…");
    const planned = await provider.complete(planMessages, {
      ...(options.config.llm.utilityModel === undefined ? {} : { model: options.config.llm.utilityModel }),
      maxTokens: 1400,
      temperature: 0.3,
    });
    const finished = clock();
    const planStage: RunStage = {
      name: "plan", label: "场景规划", startedAt: started.toISOString(), finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(), model: planned.model,
      promptTokens: planned.usage?.promptTokens, completionTokens: planned.usage?.completionTokens,
    };
    checkpoint = {
      ...checkpoint, finishedAt: finished.toISOString(), durationMs: finished.getTime() - agentStartedAt.getTime(),
      usage: { promptTokens: planned.usage?.promptTokens ?? 0, completionTokens: planned.usage?.completionTokens ?? 0 },
      stages: [planStage],
    };
    const plan = truncateToTokens(planned.text.trim(), 1200).text;
    await writeTextFile(join(runDir, "agent-plan.md"), plan + "\n");
    await saveCheckpoint();
    if (plan === "") throw new Error("Agent 未生成可用的章节计划");

    const result = await generateChapter({
      ...options, provider, contextPackOverride: memory.pack, writingPlan: plan,
      extraWarnings: memory.warnings, runDirName: allocated.name,
      onStageComplete: async (stage) => {
        checkpoint = {
          ...checkpoint,
          finishedAt: stage.finishedAt,
          durationMs: new Date(stage.finishedAt).getTime() - agentStartedAt.getTime(),
          usage: {
            promptTokens: checkpoint.usage.promptTokens + (stage.promptTokens ?? 0),
            completionTokens: checkpoint.usage.completionTokens + (stage.completionTokens ?? 0),
          },
          stages: [...checkpoint.stages, stage],
        };
        await saveCheckpoint();
      },
    });
    const record: RunRecord = {
      ...result.record,
      startedAt: agentStartedAt.toISOString(),
      durationMs: new Date(result.record.finishedAt).getTime() - agentStartedAt.getTime(),
      usage: {
        promptTokens: result.record.usage.promptTokens + (planned.usage?.promptTokens ?? 0),
        completionTokens: result.record.usage.completionTokens + (planned.usage?.completionTokens ?? 0),
      },
      stages: [planStage, ...result.record.stages],
    };
    checkpoint = record;
    await saveCheckpoint();
    return { ...result, record };
  } catch (error) {
    const finished = clock();
    checkpoint = {
      ...checkpoint, finishedAt: finished.toISOString(), durationMs: finished.getTime() - agentStartedAt.getTime(),
      warnings: [...checkpoint.warnings, `Agent 中断：${error instanceof Error ? error.message : String(error)}`],
    };
    await saveCheckpoint();
    throw error;
  }
}
