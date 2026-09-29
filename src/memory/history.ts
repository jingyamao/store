/** 作者确认的章节事实，与已应用的 sync 差量共同构成可回溯历史。 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { chapterNumber } from "../domain/ids.js";
import { ChapterIdSchema, RelationshipSchema } from "../domain/schemas.js";
import { loadBible, type Bible } from "../store/bible.js";
import { readChapterText } from "../store/chapters.js";
import { readYamlValidated, writeYamlFile } from "../store/file-io.js";
import { resolveBook, type BookPaths } from "../store/paths.js";
import { fieldSchemas, recoverAllPending, SyncProposalSchema, type SyncProposal } from "../sync/index.js";
import { withSyncLock } from "../sync/lock.js";

const OptionalFields = new Set([
  "characters:state.realm", "characters:state.location", "characters:state.diedAt",
  "items:condition", "threads:resolvedAt", "threads:payoffNotes",
]);
const ManualFieldSchemas: Record<string, z.ZodType> = {
  ...fieldSchemas,
  "characters:relationships": z.array(RelationshipSchema),
};

const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chapter"), text: z.string().min(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ kind: z.literal("author"), text: z.string().min(1) }),
]);

export const ManualFactSchema = z.object({
  chapter: ChapterIdSchema,
  collection: z.enum(["characters", "items", "threads"]),
  id: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
  evidence: EvidenceSchema,
  recordedAt: z.string().min(1),
});
const ManualFileSchema = z.object({ facts: z.array(ManualFactSchema).default([]) });
export type ManualFact = z.infer<typeof ManualFactSchema>;

export interface HistoricalFact {
  readonly chapter: string;
  readonly collection: ManualFact["collection"];
  readonly id: string;
  readonly field: string;
  readonly value: unknown;
  readonly source: string;
  readonly evidence: string;
  readonly origin: "sync" | "manual";
}

function sha256(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function factKey(fact: Pick<HistoricalFact, "collection" | "id" | "field">): string {
  return `${fact.collection}:${fact.id}:${fact.field}`;
}

export function manualFactPath(paths: BookPaths, chapter: string): string {
  return join(paths.memoryDir, `${ChapterIdSchema.parse(chapter)}.yaml`);
}

function normalizedValue(collection: ManualFact["collection"], field: string, value: unknown, chapter: string, bible: Bible): unknown {
  const key = `${collection}:${field}`;
  const schema = ManualFieldSchemas[key];
  if (schema === undefined) throw new Error(`历史记忆不支持字段 ${key}`);
  if (value === null) {
    if (!OptionalFields.has(key)) throw new Error(`${key} 不能设为 null`);
    return null;
  }
  const parsed: unknown = schema.parse(value);
  if ((key === "characters:state.diedAt" || key === "threads:resolvedAt") && chapterNumber(parsed as string) > chapterNumber(chapter)) {
    throw new Error(`${key} 不能晚于事实章节 ${chapter}`);
  }
  if (key === "characters:relationships") {
    const relationships = parsed as z.infer<typeof RelationshipSchema>[];
    const seen = new Set<string>();
    return relationships.map((relation) => {
      if (!bible.characters.some((character) => character.id === relation.target)) throw new Error(`关系目标不存在：${relation.target}`);
      if (seen.has(relation.target)) throw new Error(`同一人物的关系重复：${relation.target}`);
      seen.add(relation.target);
      if (relation.since !== undefined && chapterNumber(relation.since) > chapterNumber(chapter)) throw new Error("关系确立章节不能晚于事实章节");
      return { ...relation, since: relation.since ?? chapter };
    });
  }
  if (key === "characters:state.location" && !bible.locations.some((location) => location.id === parsed)) throw new Error(`地点不存在：${String(parsed)}`);
  if (key === "characters:state.possession") {
    for (const id of parsed as string[]) if (!bible.items.some((item) => item.id === id)) throw new Error(`物品不存在：${id}`);
  }
  return parsed;
}

function validateEntity(bible: Bible, collection: ManualFact["collection"], id: string): void {
  if (!bible[collection].some((entity) => entity.id === id)) throw new Error(`历史记忆中的实体不存在：${collection}/${id}`);
}

export async function recordManualFact(options: {
  booksRoot: string;
  bookId?: string;
  chapter: string;
  collection: ManualFact["collection"];
  id: string;
  field: string;
  value: unknown;
  evidence: string;
  authorNote?: boolean;
  force?: boolean;
  now?: () => Date;
}): Promise<{ file: string; fact: ManualFact }> {
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const paths = resolved.paths;
  const chapter = ChapterIdSchema.parse(options.chapter);
  return withSyncLock(paths, async () => {
    await recoverAllPending(paths);
    const bible = await loadBible(options.booksRoot, resolved.id);
    validateEntity(bible, options.collection, options.id);
    const value = normalizedValue(options.collection, options.field, options.value, chapter, bible);
    const evidenceText = options.evidence.trim();
    if (evidenceText === "") throw new Error("请提供正文原句或作者说明作为事实依据");
    const body = await readChapterText(paths, chapter);
    if (body === undefined || body.trim() === "") throw new Error(`${chapter} 尚无定稿正文，不能记录已发生的章节事实`);
    if (options.authorNote !== true && !body.includes(evidenceText)) {
      throw new Error(`依据未出现在 ${chapter} 的定稿正文中；如为作者补录，请加 --author-note`);
    }
    const fact = ManualFactSchema.parse({
      chapter, collection: options.collection, id: options.id, field: options.field, value,
      evidence: options.authorNote === true
        ? { kind: "author", text: evidenceText }
        : { kind: "chapter", text: evidenceText, sourceHash: sha256(body) },
      recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    const file = manualFactPath(paths, chapter);
    const current = existsSync(file) ? await readYamlValidated(file, ManualFileSchema) : { facts: [] as ManualFact[] };
    const index = current.facts.findIndex((entry) => factKey(entry) === factKey(fact));
    if (index >= 0 && options.force !== true) throw new Error(`这一章已有 ${factKey(fact)}；确认替换请加 --force`);
    const facts = [...current.facts];
    if (index >= 0) facts[index] = fact;
    else facts.push(fact);
    await writeYamlFile(file, { facts }, "作者确认的章节历史事实。正文修改后，基于正文的事实需要重新核对。");
    return { file, fact };
  });
}

/** 调用方如需与 Bible 快照一致，应在同一个 withSyncLock 内调用。 */
export async function loadManualFacts(paths: BookPaths, bible: Bible): Promise<{ facts: ManualFact[]; warnings: string[] }> {
  if (!existsSync(paths.memoryDir)) return { facts: [], warnings: [] };
  const files = (await readdir(paths.memoryDir)).filter((name) => /^ch-\d{4,}\.yaml$/.test(name)).sort();
  const facts: ManualFact[] = [];
  const warnings: string[] = [];
  for (const name of files) {
    const chapter = name.slice(0, -5);
    const saved = await readYamlValidated(join(paths.memoryDir, name), ManualFileSchema);
    const body = await readChapterText(paths, chapter);
    const seen = new Set<string>();
    for (const fact of saved.facts) {
      if (!Object.hasOwn(fact, "value")) throw new Error(`${name} 的 ${factKey(fact)} 缺少 value`);
      if (fact.chapter !== chapter) throw new Error(`${name} 中的章节号与文件名不一致`);
      const key = factKey(fact);
      if (seen.has(key)) throw new Error(`${name} 中重复记录 ${key}`);
      seen.add(key);
      validateEntity(bible, fact.collection, fact.id);
      const value = normalizedValue(fact.collection, fact.field, fact.value, chapter, bible);
      if (body === undefined || body.trim() === "") {
        warnings.push(`${name} 对应的定稿正文不存在，已跳过 ${key}`);
        continue;
      }
      if (fact.evidence.kind === "chapter" && (sha256(body) !== fact.evidence.sourceHash || !body.includes(fact.evidence.text))) {
        warnings.push(`${name} 的 ${key} 依据已过期，已跳过；请核对正文后重新记录`);
        continue;
      }
      facts.push({ ...fact, value });
    }
  }
  return { facts, warnings };
}

export async function loadApprovedProposals(paths: BookPaths, bible: Bible): Promise<{ proposals: SyncProposal[]; stale: SyncProposal[]; warnings: string[] }> {
  if (!existsSync(paths.chaptersDir)) return { proposals: [], stale: [], warnings: [] };
  const files = (await readdir(paths.chaptersDir)).filter((name) => /^ch-\d+\.meta\.yaml$/.test(name));
  const proposals: SyncProposal[] = [];
  const stale: SyncProposal[] = [];
  const warnings: string[] = [];
  for (const name of files) {
    const proposal = await readYamlValidated(join(paths.chaptersDir, name), SyncProposalSchema);
    if (`${proposal.chapter}.meta.yaml` !== name) throw new Error(`${name} 中的章节号与文件名不一致`);
    if (new Set(proposal.applied).size !== proposal.applied.length) throw new Error(`${name} 中有重复的已应用变化编号`);
    if (proposal.applied.some((index) => index > proposal.changes.length)) throw new Error(`${name} 中有超出范围的已应用变化编号`);
    if (proposal.applied.length === 0) continue;
    const body = await readChapterText(paths, proposal.chapter);
    if (body === undefined || sha256(body) !== proposal.sourceHash) {
      stale.push(proposal);
      warnings.push(`${name} 的正文已变化，已跳过过期同步事实；请重新提取并确认状态`);
      continue;
    }
    const seen = new Set<string>();
    for (const index of proposal.applied) {
      const change = proposal.changes[index - 1];
      if (change === undefined) throw new Error(`${name} 中有不存在的已应用变化`);
      const key = factKey(change);
      if (seen.has(key)) throw new Error(`${name} 中同一字段被重复应用：${key}`);
      seen.add(key);
      validateEntity(bible, change.collection, change.id);
      if (fieldSchemas[`${change.collection}:${change.field}` as keyof typeof fieldSchemas] === undefined) throw new Error(`${name} 中有不允许的状态字段：${key}`);
      normalizedValue(change.collection, change.field, change.after, proposal.chapter, bible);
      if (change.before !== null) normalizedValue(change.collection, change.field, change.before, proposal.chapter, bible);
      if (!body.includes(change.evidence)) throw new Error(`${name} 的第 ${index} 项依据未出现在正文中`);
    }
    proposals.push(proposal);
  }
  return { proposals, stale, warnings };
}

export async function loadHistorySnapshot(booksRoot: string, bookId?: string): Promise<{
  bible: Bible;
  proposals: SyncProposal[];
  staleProposals: SyncProposal[];
  manual: ManualFact[];
  warnings: string[];
}> {
  const resolved = await resolveBook(booksRoot, bookId);
  return withSyncLock(resolved.paths, async () => {
    await recoverAllPending(resolved.paths);
    const bible = await loadBible(booksRoot, resolved.id);
    const approved = await loadApprovedProposals(resolved.paths, bible);
    const manual = await loadManualFacts(resolved.paths, bible);
    return { bible, proposals: approved.proposals, staleProposals: approved.stale, manual: manual.facts, warnings: [...approved.warnings, ...manual.warnings] };
  });
}

export function selectHistoricalFacts(
  targetChapter: string,
  proposals: readonly SyncProposal[],
  manual: readonly ManualFact[],
): { facts: HistoricalFact[]; warnings: string[] } {
  const target = chapterNumber(targetChapter);
  const candidates: HistoricalFact[] = [];
  for (const proposal of proposals) {
    if (chapterNumber(proposal.chapter) >= target) continue;
    for (const index of proposal.applied) {
      const change = proposal.changes[index - 1];
      if (change === undefined) continue;
      candidates.push({
        chapter: proposal.chapter, collection: change.collection, id: change.id, field: change.field,
        value: change.after, source: `chapters/${proposal.chapter}.meta.yaml#${index}`,
        evidence: change.evidence, origin: "sync",
      });
    }
  }
  for (const fact of manual) {
    if (chapterNumber(fact.chapter) >= target) continue;
    candidates.push({
      chapter: fact.chapter, collection: fact.collection, id: fact.id, field: fact.field,
      value: fact.value, source: `memory/${fact.chapter}.yaml#${factKey(fact)}`,
      evidence: fact.evidence.text, origin: "manual",
    });
  }
  candidates.sort((a, b) =>
    chapterNumber(a.chapter) - chapterNumber(b.chapter) ||
    (a.origin === b.origin ? 0 : a.origin === "sync" ? -1 : 1),
  );
  const latest = new Map<string, HistoricalFact>();
  const warnings: string[] = [];
  for (const fact of candidates) {
    const key = factKey(fact);
    const previous = latest.get(key);
    if (previous?.chapter === fact.chapter && JSON.stringify(previous.value) !== JSON.stringify(fact.value)) {
      warnings.push(`${fact.chapter} 的 ${key} 有两种已确认值，采用 ${fact.origin === "manual" ? "作者补录" : "后应用的同步变化"}`);
    }
    latest.set(key, fact);
  }
  return { facts: [...latest.values()].sort((a, b) => factKey(a).localeCompare(factKey(b))), warnings };
}
