import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../config/index.js";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { MockProvider } from "../llm/mock.js";
import { loadBible, writeCollection } from "../store/bible.js";
import { writeChapterText, writeSummary } from "../store/chapters.js";
import { COLLECTIONS } from "../store/collections.js";
import { writeChapterOutline } from "../store/outlines.js";
import { writeYamlFile } from "../store/file-io.js";
import { applyExistingRun } from "../generate/run.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { proposalPath, SyncProposalSchema } from "../sync/index.js";
import { prepareAgentMemory, projectBibleAsOf, retrievePastEvidence } from "./memory.js";
import { runWritingAgent } from "./run.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

async function fixture(): Promise<TestWorkspace> {
  const ws = await createWorkspace();
  opened.push(ws);
  await writeCollection(ws.paths, COLLECTIONS.characters, [{
    id: "char_lin", name: "林渊", role: "protagonist", firstAppearance: "ch-0001",
    personality: ["谨慎"], speechStyle: { patterns: [], avoid: [] }, relationships: [], forbidden: [], aliases: [],
    state: { asOfChapter: "ch-0005", realm: "筑基", injuries: [], possession: [], knownSecrets: [], goals: [], alive: true },
  }]);
  await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({
    chapter: "ch-0004", title: "青铜钥匙", intent: "林渊追查青铜钥匙的来历", cast: ["char_lin"], mustInclude: ["青铜钥匙"],
  }));
  await writeChapterText(ws.paths, "ch-0001", "林渊把青铜钥匙藏进木匣。\n\n从此无人知道木匣的位置。");
  await writeSummary(ws.paths, "ch-0001", "林渊藏好青铜钥匙。");
  await writeChapterText(ws.paths, "ch-0002", "林渊走进集市。");
  await writeChapterText(ws.paths, "ch-0005", "林渊终于得知青铜钥匙可以打开皇陵，升入筑基。");
  return ws;
}

describe("Agent 记忆", () => {
  it("检索远期旧正文并严格排除目标章和未来章", async () => {
    const ws = await fixture();
    const bible = await loadBible(ws.booksRoot, ws.bookId);
    const outline = ChapterOutlineSchema.parse({ chapter: "ch-0004", intent: "追查青铜钥匙", cast: ["char_lin"] });
    const evidence = retrievePastEvidence(outline, bible, new Map([
      ["ch-0001", "林渊把青铜钥匙藏进木匣。"],
      ["ch-0004", "青铜钥匙当场消失。"],
      ["ch-0005", "青铜钥匙可以打开皇陵。"],
    ]), new Map(), 2);
    if (evidence.length === 0) throw new Error("应检索到旧章证据");
    if (!evidence.every((item) => item.chapter === "ch-0001")) throw new Error("检索到当前或未来章节");
    const config = await loadConfig(ws.root);
    const memory = await prepareAgentMemory({ booksRoot: ws.booksRoot, chapterId: "ch-0004", config });
    const sources = memory.pack.layers.flatMap((layer) => layer.items.map((item) => item.source));
    if (!sources.some((source) => source.includes("ch-0001.md#memory"))) throw new Error("远期证据未进入上下文");
    if (sources.some((source) => source.includes("ch-0005"))) throw new Error("未来章节进入上下文");
    if (memory.pack.usedTokens > memory.pack.budgetTokens) throw new Error("超出记忆预算");
  });

  it("回推已确认状态，并隐藏没有历史差量的后期状态", async () => {
    const ws = await fixture();
    await writeCollection(ws.paths, COLLECTIONS.threads, [{
      id: "thread_001", title: "旧伏笔", plantedAt: "ch-0001", detail: "木匣线索", status: "abandoned", related: [],
    }]);
    const bible = await loadBible(ws.booksRoot, ws.bookId);
    const proposal = SyncProposalSchema.parse({
      chapter: "ch-0005", sourceHash: createHash("sha256").update("林渊终于得知青铜钥匙可以打开皇陵，升入筑基。").digest("hex"), generatedAt: "2026-01-01", summary: "升境界",
      changes: [{ collection: "characters", id: "char_lin", field: "state.realm", before: "炼气", after: "筑基", evidence: "升入筑基" }],
      applied: [1], summaryApplied: false,
    });
    const reverted = projectBibleAsOf(bible, "ch-0004", [proposal]);
    if (reverted.bible.characters[0]?.state.realm !== "炼气") throw new Error("未回推状态");
    await writeYamlFile(proposalPath(ws.paths, "ch-0005"), proposal);
    const config = await loadConfig(ws.root);
    const packed = await prepareAgentMemory({ booksRoot: ws.booksRoot, chapterId: "ch-0004", config });
    const entityText = packed.pack.layers.find((layer) => layer.id === "entities")?.items.map((item) => item.text).join("\n") ?? "";
    if (!entityText.includes("炼气") || entityText.includes("筑基")) throw new Error("已确认的历史差量未进入实际上下文");
    const hidden = projectBibleAsOf(bible, "ch-0004", []);
    if (hidden.bible.characters[0]?.state.realm !== undefined) throw new Error("无历史差量时泄露后期状态");
    if (hidden.warnings.length === 0) throw new Error("缺少历史状态告警");
    if (hidden.bible.threads[0]?.status !== "open") throw new Error("后期废弃的伏笔未按早期未回收处理");
  });

  it("Agent 规划、写作、记账并保持作者审阅关口", async () => {
    const ws = await fixture();
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: [
      "场景一：林渊寻找木匣。连续性：旧章藏过青铜钥匙。",
      "===方案1===\n林渊摸到木匣。",
      "林渊摸到木匣，青铜钥匙还在里面。他决定追查来历。",
    ] });
    const dry = await runWritingAgent({ booksRoot: ws.booksRoot, chapterId: "ch-0004", config, provider, dryRun: true });
    if (provider.calls.length !== 0 || !dry.record.dryRun) throw new Error("dry-run 调用了模型");
    const result = await runWritingAgent({ booksRoot: ws.booksRoot, chapterId: "ch-0004", config, provider });
    if (Number(provider.calls.length) !== 3) throw new Error("Agent 应规划、开篇、写作各调用一次");
    if (result.record.stages[0]?.name !== "plan") throw new Error("缺少规划阶段");
    if (!existsSync(join(result.runDir, "agent-memory.json"))) throw new Error("缺少记忆审计文件");
    if (!readFileSync(join(result.runDir, "prompt.txt"), "utf8").includes("场景一")) throw new Error("章节计划未进入写作提示词");
    if (existsSync(join(ws.paths.chaptersDir, "ch-0004.md"))) throw new Error("初稿被自动采用");
    if (result.record.usage.promptTokens <= 0 || result.record.usage.completionTokens <= 0) throw new Error("用量未记账");
    await applyExistingRun(ws.paths, result.runDir.split(/[\\/]/).at(-1) ?? "");
    if (!existsSync(join(ws.paths.chaptersDir, "ch-0004.md"))) throw new Error("作者无法采用初稿");
  });

  it("规划和开篇已计费而初稿失败时保留各阶段用量", async () => {
    const ws = await fixture();
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: ["场景一：寻找木匣", "===方案1===\n林渊摸到木匣。"], failures: [undefined, undefined, new Error("模拟初稿失败")] });
    let failed = false;
    try { await runWritingAgent({ booksRoot: ws.booksRoot, chapterId: "ch-0004", config, provider }); }
    catch { failed = true; }
    if (!failed) throw new Error("应模拟生成失败");
    const names = await readdir(ws.paths.runsDir);
    const name = names.find((entry) => entry.includes("ch-0004"));
    if (name === undefined) throw new Error("中断后未保留运行目录");
    const record = JSON.parse(readFileSync(join(ws.paths.runsDir, name, "run.json"), "utf8")) as { usage: { promptTokens: number }; stages: Array<{ name: string }>; warnings: string[] };
    if (record.usage.promptTokens <= 0 || record.stages[0]?.name !== "plan" || record.stages[1]?.name !== "openings") throw new Error("已完成阶段用量未写入检查点");
    if (!record.warnings.some((warning) => warning.includes("模拟初稿失败"))) throw new Error("没有中断原因");
    if (!existsSync(join(ws.paths.runsDir, name, "agent-memory.json"))) throw new Error("没有保留记忆来源");
  });
});
