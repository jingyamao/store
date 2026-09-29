/** 按目标章节构建可审计的多层记忆。只检索已定稿的过去正文。 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import { chapterNumber } from "../domain/ids.js";
import type { ChapterOutline } from "../domain/outline.js";
import { assembleContextPack, type ContextPack } from "../generate/context-pack.js";
import { loadBible, type Bible } from "../store/bible.js";
import { loadChapters, loadSummaries } from "../store/chapters.js";
import { readTextFileOr, readYamlValidated } from "../store/file-io.js";
import { readChapterOutline } from "../store/outlines.js";
import { resolveBook } from "../store/paths.js";
import { recoverAllPending, SyncProposalSchema, type SyncProposal } from "../sync/index.js";
import { withSyncLock } from "../sync/lock.js";
import { deleteByPath, setByPath } from "../util/dotted-path.js";

export interface MemoryEvidence {
  readonly source: string;
  readonly chapter: string;
  readonly score: number;
  readonly text: string;
}

export interface AgentMemory {
  readonly pack: ContextPack;
  readonly evidence: readonly MemoryEvidence[];
  readonly warnings: readonly string[];
}

function future(id: string | undefined, target: number): boolean {
  return id !== undefined && chapterNumber(id) >= target;
}

/** 从已确认的 sync 差量倒推早期状态；无可靠历史时隐藏后期动态状态。 */
export function projectBibleAsOf(bible: Bible, chapterId: string, proposals: readonly SyncProposal[]): { bible: Bible; warnings: string[] } {
  const target = chapterNumber(chapterId);
  const copy = structuredClone(bible);
  const warnings: string[] = [];
  const undoneCharacters = new Set<string>();
  const restoredCharacterFields = new Map<string, Map<string, unknown>>();
  const after = proposals
    .filter((proposal) => chapterNumber(proposal.chapter) >= target)
    .sort((a, b) => chapterNumber(b.chapter) - chapterNumber(a.chapter));

  for (const proposal of after) {
    for (const index of [...proposal.applied].sort((a, b) => b - a)) {
      const change = proposal.changes[index - 1];
      if (change === undefined) continue;
      const entity = copy[change.collection].find((item) => item.id === change.id);
      if (entity === undefined) continue;
      const record = entity as unknown as Record<string, unknown>;
      if (change.before === null || change.before === undefined) deleteByPath(record, change.field);
      else setByPath(record, change.field, change.before);
      if (change.collection === "characters") {
        undoneCharacters.add(change.id);
        const fields = restoredCharacterFields.get(change.id) ?? new Map<string, unknown>();
        fields.set(change.field, change.before);
        restoredCharacterFields.set(change.id, fields);
      }
    }
  }

  for (const character of copy.characters) {
    // 未留下 sync 差量的后期状态不能安全地当作早期状态使用。
    if (future(character.state.asOfChapter, target)) {
      // 保留经差量明确回推的字段，其他后期字段没有可靠的时间来源。
      character.state = {} as typeof character.state;
      for (const [field, value] of restoredCharacterFields.get(character.id) ?? []) {
        if (value !== null && value !== undefined) setByPath(character as unknown as Record<string, unknown>, field, value);
      }
      warnings.push(`${character.name} 的状态晚于 ${chapterId}；仅保留有历史差量可回推的字段`);
    }
    if (undoneCharacters.has(character.id)) {
      const latest = proposals
        .filter((p) => chapterNumber(p.chapter) < target && p.applied.some((i) => p.changes[i - 1]?.collection === "characters" && p.changes[i - 1]?.id === character.id))
        .sort((a, b) => chapterNumber(b.chapter) - chapterNumber(a.chapter))[0];
      if (latest === undefined) delete character.state.asOfChapter;
      else character.state.asOfChapter = latest.chapter;
    }
    character.relationships = character.relationships.filter((relation) => !future(relation.since, target));
  }
  for (const item of copy.items) {
    if (future(item.firstAppearance, target)) delete item.condition;
  }
  for (const thread of copy.threads) {
    if (future(thread.resolvedAt, target) || ((thread.status === "resolved" || thread.status === "abandoned") && thread.resolvedAt === undefined)) {
      thread.status = "open";
      delete thread.resolvedAt;
      delete thread.payoffNotes;
      warnings.push(`伏笔「${thread.title}」缺少可回推的结束章节，按未回收处理`);
    } else if (thread.status !== "resolved") {
      delete thread.payoffNotes;
    }
  }
  copy.timeline.events = copy.timeline.events.filter((event) => chapterNumber(event.chapter) < target);
  copy.settings = copy.settings.filter((setting) => !future(setting.establishedAt, target));
  return { bible: copy, warnings };
}

async function approvedProposals(chaptersDir: string): Promise<SyncProposal[]> {
  if (!existsSync(chaptersDir)) return [];
  const files = (await readdir(chaptersDir)).filter((name) => /^ch-\d+\.meta\.yaml$/.test(name));
  const result: SyncProposal[] = [];
  for (const name of files) {
    const proposal = await readYamlValidated(join(chaptersDir, name), SyncProposalSchema);
    if (proposal.applied.length > 0) result.push(proposal);
  }
  return result;
}

function terms(outline: ChapterOutline, bible: Bible): string[] {
  const names = outline.cast.map((id) => bible.characters.find((c) => c.id === id)?.name ?? id);
  const threads = [...outline.advanceThreads, ...outline.plantThreads]
    .map((id) => bible.threads.find((t) => t.id === id)?.title ?? id);
  const raw = [outline.title, outline.intent, outline.conflict, ...outline.mustInclude, ...names, ...threads].join(" ");
  const words = raw.match(/[\p{Script=Han}]{2,}|[a-zA-Z0-9_]{3,}/gu) ?? [];
  const found = new Set<string>([...names, ...threads].filter((x) => x.length >= 2));
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 3) {
      for (let i = 0; i < word.length - 1; i += 1) found.add(word.slice(i, i + 2));
    } else found.add(word.toLowerCase());
  }
  return [...found].filter((x) => x.length >= 2);
}

function score(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((total, word) => total + (lower.includes(word.toLowerCase()) ? Math.min(4, word.length) : 0), 0);
}

/** 从旧章节原文段落检索，保留出处；绝不读取目标章节及后续章节。 */
export function retrievePastEvidence(
  outline: ChapterOutline,
  bible: Bible,
  chapters: ReadonlyMap<string, string>,
  summaries: ReadonlyMap<string, string>,
  recentChapters: number,
  limit = 8,
): MemoryEvidence[] {
  const target = chapterNumber(outline.chapter);
  const keywords = terms(outline, bible);
  if (keywords.length === 0) return [];
  const candidates: MemoryEvidence[] = [];
  for (const [id, body] of chapters) {
    const number = chapterNumber(id);
    if (number >= target || number >= target - recentChapters) continue;
    const passages = body.split(/\n\s*\n/)
      .flatMap((part) => part.trim().match(/[\s\S]{1,800}/g) ?? [])
      .filter(Boolean);
    for (const passage of passages) {
      const points = score(passage, keywords);
      if (points === 0) continue;
      candidates.push({ source: `chapters/${id}.md`, chapter: id, score: points, text: passage.slice(0, 1100) });
    }
  }
  for (const [id, summary] of summaries) {
    const number = chapterNumber(id);
    if (number >= target || number >= target - recentChapters) continue;
    const points = score(summary, keywords);
    if (points > 0) candidates.push({ source: `summaries/${id}.md`, chapter: id, score: points, text: summary.slice(0, 1100) });
  }
  candidates.sort((a, b) => b.score - a.score || chapterNumber(b.chapter) - chapterNumber(a.chapter) || a.source.localeCompare(b.source));
  const selected: MemoryEvidence[] = [];
  const perChapter = new Map<string, number>();
  for (const candidate of candidates) {
    if ((perChapter.get(candidate.chapter) ?? 0) >= 2) continue;
    selected.push(candidate);
    perChapter.set(candidate.chapter, (perChapter.get(candidate.chapter) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

export async function prepareAgentMemory(options: {
  booksRoot: string;
  bookId?: string;
  chapterId: string;
  config: ResolvedConfig;
}): Promise<AgentMemory> {
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const paths = resolved.paths;
  const outline = await readChapterOutline(paths, options.chapterId);
  if (outline === undefined) throw new Error(`${options.chapterId} 尚无细纲，请先运行 novel plan new ${options.chapterId}`);
  const [snapshot, chapters, summaries, styleText, masterOutlineText] = await Promise.all([
    withSyncLock(paths, async () => {
      await recoverAllPending(paths);
      return {
        bible: await loadBible(options.booksRoot, resolved.id),
        proposals: await approvedProposals(paths.chaptersDir),
      };
    }),
    loadChapters(paths), loadSummaries(paths),
    readTextFileOr(paths.styleFile, ""), readTextFileOr(paths.masterOutlineFile, ""),
  ]);
  const originalBible = snapshot.bible;
  const proposals = snapshot.proposals;
  const projected = projectBibleAsOf(originalBible, outline.chapter, proposals);
  const evidence = retrievePastEvidence(outline, projected.bible, chapters, summaries, options.config.generation.recentChapters);
  const volumeOutlineText = outline.volume === undefined ? "" : await readTextFileOr(join(paths.volumesDir, `${outline.volume}.md`), "");
  const volumeNumber = outline.volume === undefined ? 0 : Number(outline.volume.slice(4));
  const previousVolumeSummaries = volumeNumber === 0 || !existsSync(paths.summariesDir) ? [] : await Promise.all(
    (await readdir(paths.summariesDir))
      .filter((name) => /^vol-\d{2,}\.md$/.test(name) && Number(name.slice(4, -3)) < volumeNumber)
      .sort((a, b) => Number(b.slice(4, -3)) - Number(a.slice(4, -3)))
      .map(async (name) => ({ id: name.slice(0, -3), text: await readTextFileOr(join(paths.summariesDir, name), "") })),
  );
  // 留出固定空间给细纲、规划、指令和消息包装；配置的输出预留仍然生效。
  const pack = assembleContextPack({
    bookId: resolved.id, outline, styleText, masterOutlineText, volumeOutlineText,
    previousVolumeSummaries, bible: projected.bible, chapters, summaries,
    retrievedMemories: evidence.map((entry, index) => ({
      source: `${entry.source}#memory-${index + 1}`, text: `【历史证据 ${entry.chapter}，来源 ${entry.source}】\n${entry.text}`, score: entry.score,
    })),
  }, {
    budget: { ...options.config.budget, contextWindow: Math.max(1, options.config.budget.contextWindow - 3000) },
    generation: options.config.generation,
  });
  const included = new Map(pack.layers.flatMap((layer) => layer.items.map((item) => [item.source, item.text] as const)));
  const usedEvidence = evidence
    .map((entry, index) => ({ entry, packed: included.get(`${entry.source}#memory-${index + 1}`) }))
    .filter((row): row is { entry: MemoryEvidence; packed: string } => row.packed !== undefined)
    .map(({ entry, packed }) => ({ ...entry, text: packed }));
  return { pack, evidence: usedEvidence, warnings: projected.warnings };
}
