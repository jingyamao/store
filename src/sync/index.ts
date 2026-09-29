/** 从已定稿的正文提出状态变化；只有作者明确接受后才写回 Bible。 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../config/index.js";
import { chapterNumber } from "../domain/ids.js";
import { isSummaryPlaceholder } from "../domain/summary.js";
import {
  CharacterSchema, ChapterIdSchema, ItemSchema, LocationIdSchema, ThreadSchema,
} from "../domain/schemas.js";
import { createProvider } from "../llm/index.js";
import type { LlmMessage, LlmProvider } from "../llm/types.js";
import { loadBible, writeCollection, type Bible } from "../store/bible.js";
import { readChapterText, readSummary, summaryPath, writeSummary } from "../store/chapters.js";
import { COLLECTIONS } from "../store/collections.js";
import { readTextFileOr, readYamlValidated, writeTextFile, writeYamlFile } from "../store/file-io.js";
import { resolveBook, type BookPaths } from "../store/paths.js";
import { deleteByPath, getByPath, setByPath } from "../util/dotted-path.js";
import { withSyncLock } from "./lock.js";

const fieldSchemas = {
  "characters:state.realm": z.string().min(1),
  "characters:state.location": LocationIdSchema,
  "characters:state.injuries": z.array(z.string().min(1)),
  "characters:state.possession": z.array(z.string().regex(/^item_[a-z0-9_]+$/)),
  "characters:state.knownSecrets": z.array(z.string().min(1)),
  "characters:state.goals": z.array(z.string().min(1)),
  "characters:state.alive": z.boolean(),
  "characters:state.diedAt": ChapterIdSchema,
  "items:condition": z.string().min(1),
  "threads:status": z.enum(["open", "hinted", "resolved", "abandoned"]),
  "threads:resolvedAt": ChapterIdSchema,
  "threads:payoffNotes": z.string().min(1),
} as const;

const ChangeSchema = z.object({
  collection: z.enum(["characters", "items", "threads"]),
  id: z.string().min(1),
  field: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  evidence: z.string().min(1),
});

export const SyncProposalSchema = z.object({
  chapter: ChapterIdSchema,
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string(),
  summary: z.string().min(1),
  changes: z.array(ChangeSchema),
  applied: z.array(z.number().int().positive()).default([]),
  summaryApplied: z.boolean().default(false),
});

export type SyncProposal = z.infer<typeof SyncProposalSchema>;
export type SyncChange = SyncProposal["changes"][number];

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function proposalPath(paths: BookPaths, chapter: string): string {
  const id = ChapterIdSchema.parse(chapter);
  return join(paths.chaptersDir, `${id}.meta.yaml`);
}

function journalPath(paths: BookPaths, chapter: string): string { return proposalPath(paths, chapter) + ".pending.json"; }
function transactionFiles(paths: BookPaths, chapter: string): Record<string, string> {
  return {
    characters: join(paths.root, COLLECTIONS.characters.file),
    items: join(paths.root, COLLECTIONS.items.file),
    threads: join(paths.root, COLLECTIONS.threads.file),
    summary: summaryPath(paths, chapter),
    proposal: proposalPath(paths, chapter),
  };
}
const JournalSchema = z.object({ phase: z.enum(["prepared", "committed"]), originals: z.record(z.string(), z.string().nullable()) });

/** 上次进程若在多文件写入途中退出，先把它恢复到操作前。 */
async function recoverPending(paths: BookPaths, chapter: string): Promise<void> {
  const journal = journalPath(paths, chapter);
  if (!existsSync(journal)) return;
  const data = JournalSchema.parse(JSON.parse(await readTextFileOr(journal, "{}")) as unknown);
  if (data.phase === "prepared") {
    const files = transactionFiles(paths, chapter);
    for (const [key, original] of Object.entries(data.originals)) {
      const file = files[key];
      if (file === undefined) throw new Error(`未知回滚目标：${key}`);
      if (original === null) await rm(file, { force: true });
      else await writeTextFile(file, original);
    }
  }
  await rm(journal, { force: true });
}

/** 调用方必须持有 withSyncLock，避免把仍在执行的事务当作崩溃事务回滚。 */
export async function recoverAllPending(paths: BookPaths): Promise<void> {
  for (const name of await readdir(paths.chaptersDir)) {
    const chapter = name.match(/^(ch-\d+)\.meta\.yaml\.pending\.json$/)?.[1];
    if (chapter !== undefined && ChapterIdSchema.safeParse(chapter).success) await recoverPending(paths, chapter);
  }
}

function entityFor(bible: Bible, collection: SyncChange["collection"], id: string): Record<string, unknown> {
  const entity = bible[collection].find((entry) => entry.id === id);
  if (entity === undefined) throw new Error(`状态提案引用了不存在的实体：${id}`);
  return entity as unknown as Record<string, unknown>;
}

function validateChange(bible: Bible, change: SyncChange): void {
  const key = `${change.collection}:${change.field}` as keyof typeof fieldSchemas;
  const schema = fieldSchemas[key];
  if (schema === undefined) throw new Error(`不允许修改的状态字段：${key}`);
  if (change.after !== null) schema.parse(change.after);
  if (change.after === null && !["state.realm", "state.location", "state.diedAt", "condition", "resolvedAt", "payoffNotes"].includes(change.field)) {
    throw new Error(`${key} 不允许清空`);
  }
  entityFor(bible, change.collection, change.id);
  if (change.collection === "characters" && change.field === "state.location" && change.after !== null && !bible.locations.some((x) => x.id === change.after)) {
    throw new Error(`地点不存在：${String(change.after)}`);
  }
  if (change.collection === "characters" && change.field === "state.possession") {
    for (const id of change.after as string[]) {
      if (!bible.items.some((x) => x.id === id)) throw new Error(`物品不存在：${id}`);
    }
  }
}

function currentValue(bible: Bible, change: SyncChange): unknown {
  return getByPath(entityFor(bible, change.collection, change.id), change.field) ?? null;
}

function parseModelJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as unknown;
}

export interface ProposeOptions {
  readonly booksRoot: string;
  readonly bookId?: string | undefined;
  readonly chapter: string;
  readonly config: ResolvedConfig;
  readonly provider?: LlmProvider | undefined;
  readonly force?: boolean | undefined;
}

export async function proposeSync(options: ProposeOptions): Promise<SyncProposal> {
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  return withSyncLock(resolved.paths, async () => {
  await recoverAllPending(resolved.paths);
  const text = await readChapterText(resolved.paths, options.chapter);
  if (text === undefined || text.trim() === "") throw new Error("章节没有正文，无法提取状态");
  const target = proposalPath(resolved.paths, options.chapter);
  if (existsSync(target) && options.force !== true) throw new Error("状态提案已存在；如需重新提取请加 --force");
  const bible = await loadBible(options.booksRoot, resolved.id);
  const provider = options.provider ?? createProvider(options.config);
  const facts = {
    characters: bible.characters.map((c) => ({ id: c.id, name: c.name, state: c.state })),
    items: bible.items.map((i) => ({ id: i.id, name: i.name, condition: i.condition })),
    locations: bible.locations.map((l) => ({ id: l.id, name: l.name })),
    threads: bible.threads.map((t) => ({ id: t.id, title: t.title, status: t.status, resolvedAt: t.resolvedAt })),
  };
  const messages: LlmMessage[] = [
    { role: "system", content: "你是小说事实抽取器。只根据正文中明确发生的事提出状态变化，不推测。只输出合法 JSON，不要 Markdown。" },
    { role: "user", content: `章节 ${options.chapter}\n现有资料：${JSON.stringify(facts)}\n允许变更字段：${Object.keys(fieldSchemas).join("、")}。\n请输出 {"summary":"四段简短摘要：情节、状态变化、伏笔、遗留","changes":[{"collection":"characters|items|threads","id":"已有实体id","field":"允许字段","after":"新值或null","evidence":"正文原句或短句"}]}。没有明确变化就返回空数组。不要编造实体。\n正文：\n${text}` },
  ];
  let proposal: SyncProposal | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await provider.complete(messages, { model: options.config.llm.utilityModel ?? options.config.llm.model, temperature: 0, maxTokens: 4096 });
    try {
      const raw = z.object({ summary: z.string().min(1), changes: z.array(ChangeSchema.omit({ before: true })) }).parse(parseModelJson(response.text));
      if (raw.changes.some((change) => !Object.hasOwn(change, "after"))) throw new Error("模型状态提案缺少 after 字段");
      const seen = new Set<string>();
      const changes = raw.changes.map((change) => {
        if (!text.includes(change.evidence)) throw new Error(`状态变化的依据未在正文中找到：${change.evidence}`);
        validateChange(bible, { ...change, before: null });
        const key = `${change.collection}:${change.id}:${change.field}`;
        if (seen.has(key)) throw new Error(`模型重复提出同一字段：${key}`);
        seen.add(key);
        return { ...change, before: currentValue(bible, { ...change, before: null }) };
      }).filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
      proposal = SyncProposalSchema.parse({ chapter: options.chapter, sourceHash: hash(text), generatedAt: new Date().toISOString(), summary: raw.summary, changes });
      break;
    } catch (error) {
      if (attempt === 1) throw error;
      messages.push({ role: "assistant", content: response.text });
      messages.push({ role: "user", content: `上一次输出没有通过校验：${error instanceof Error ? error.message : String(error)}。请修正后只输出合法 JSON，依据必须是正文中的原文短句。` });
    }
  }
  if (proposal === undefined) throw new Error("模型未返回可用状态提案");
  await writeYamlFile(target, proposal, "AI 提取的待确认状态提案。用 novel sync show 查看，用 novel sync apply 逐项确认。");
  return proposal;
  });
}

export async function readProposal(paths: BookPaths, chapter: string): Promise<SyncProposal> {
  return withSyncLock(paths, async () => {
  await recoverAllPending(paths);
  const target = proposalPath(paths, chapter);
  if (!existsSync(target)) throw new Error(`找不到状态提案：${target}`);
  return readYamlValidated(target, SyncProposalSchema);
  });
}

export interface ApplyOptions {
  readonly accept: readonly number[];
  readonly acceptSummary?: boolean | undefined;
}

/** 先完成所有校验，再写入被选中的集合；摘要必须单独确认。 */
export async function applySync(paths: BookPaths, proposal: SyncProposal, options: ApplyOptions): Promise<void> {
  return withSyncLock(paths, async () => {
  await recoverAllPending(paths);
  const currentProposal = await readYamlValidated(proposalPath(paths, proposal.chapter), SyncProposalSchema);
  if (JSON.stringify(currentProposal) !== JSON.stringify(proposal)) throw new Error("状态提案已被其他操作更新，请重新读取后再应用");
  const text = await readChapterText(paths, proposal.chapter);
  if (text === undefined || hash(text) !== proposal.sourceHash) throw new Error("正文在提案生成后已改动，请重新提取状态");
  if (options.accept.length === 0 && options.acceptSummary !== true) throw new Error("请指定 --accept 序号或 --summary");
  const bible = await loadBible(dirname(paths.root), paths.root.split(/[\\/]/).at(-1));
  const accepted = new Set(options.accept);
  for (const index of accepted) {
    if (!Number.isInteger(index) || index < 1 || index > proposal.changes.length) throw new Error(`无效变更序号：${index}`);
    if (proposal.applied.includes(index)) throw new Error(`变更 ${index} 已应用`);
  }
  if (options.acceptSummary === true) {
    if (proposal.summaryApplied) throw new Error("摘要已应用");
    const existing = await readSummary(paths, proposal.chapter);
    if (existing !== undefined && existing.trim() !== "" && !isSummaryPlaceholder(existing)) throw new Error("已有章节摘要，请先手工处理，避免覆盖");
  }
  const characters = structuredClone(bible.characters);
  const items = structuredClone(bible.items);
  const threads = structuredClone(bible.threads);
  const next = { ...bible, characters, items, threads };
  for (const index of accepted) {
    const change = proposal.changes[index - 1];
    if (change === undefined) continue;
    validateChange(next, change);
    const actual = currentValue(next, change);
    if (JSON.stringify(actual) !== JSON.stringify(change.before)) {
      throw new Error(`变更 ${index} 的旧值已变化，请重新提取状态`);
    }
    const entity = entityFor(next, change.collection, change.id);
    if (change.collection === "characters") {
      const asOf = getByPath(entity, "state.asOfChapter");
      if (typeof asOf === "string" && chapterNumber(asOf) > chapterNumber(proposal.chapter)) {
        throw new Error(`变更 ${index} 属于较早章节，人物状态已推进到 ${asOf}；请人工更新 Bible`);
      }
    }
    if (change.after === null) deleteByPath(entity, change.field);
    else setByPath(entity, change.field, change.after);
    if (change.collection === "characters") setByPath(entity, "state.asOfChapter", proposal.chapter);
  }
  z.array(CharacterSchema).parse(characters);
  z.array(ItemSchema).parse(items);
  z.array(ThreadSchema).parse(threads);
  const touches = {
    characters: [...accepted].some((i) => proposal.changes[i - 1]?.collection === "characters"),
    items: [...accepted].some((i) => proposal.changes[i - 1]?.collection === "items"),
    threads: [...accepted].some((i) => proposal.changes[i - 1]?.collection === "threads"),
  };
  const files = transactionFiles(paths, proposal.chapter);
  const originals: Record<string, string | null> = {};
  for (const key of ["proposal", ...(touches.characters ? ["characters"] : []), ...(touches.items ? ["items"] : []), ...(touches.threads ? ["threads"] : []), ...(options.acceptSummary === true ? ["summary"] : [])]) {
    const file = files[key];
    if (file === undefined) continue;
    originals[key] = existsSync(file) ? await readTextFileOr(file, "") : null;
  }
  const journal = journalPath(paths, proposal.chapter);
  await writeTextFile(journal, JSON.stringify({ phase: "prepared", originals }) + "\n");
  let committed = false;
  try {
    if (touches.characters) await writeCollection(paths, COLLECTIONS.characters, characters);
    if (touches.items) await writeCollection(paths, COLLECTIONS.items, items);
    if (touches.threads) await writeCollection(paths, COLLECTIONS.threads, threads);
    if (options.acceptSummary === true) await writeSummary(paths, proposal.chapter, proposal.summary.trim() + "\n");
    await writeYamlFile(proposalPath(paths, proposal.chapter), {
      ...proposal,
      applied: [...new Set([...proposal.applied, ...accepted])].sort((a, b) => a - b),
      summaryApplied: proposal.summaryApplied || options.acceptSummary === true,
    });
    await writeTextFile(journal, JSON.stringify({ phase: "committed", originals }) + "\n");
    committed = true;
  } catch (error) {
    if (!committed) await recoverPending(paths, proposal.chapter);
    throw error;
  }
  await rm(journal, { force: true }).catch(() => undefined);
  });
}
