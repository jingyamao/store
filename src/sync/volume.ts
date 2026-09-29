/** 卷摘要先生成提案，作者确认后才进入长期上下文。 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ResolvedConfig } from "../config/index.js";
import { isSummaryPlaceholder } from "../domain/summary.js";
import { createProvider } from "../llm/index.js";
import type { LlmProvider } from "../llm/types.js";
import { readSummary } from "../store/chapters.js";
import { readTextFileOr, readYamlValidated, writeTextFile, writeYamlFile } from "../store/file-io.js";
import { listOutlinedChapters, readChapterOutline } from "../store/outlines.js";
import { resolveBook, type BookPaths } from "../store/paths.js";

const VolumeId = z.string().regex(/^vol-\d{2,}$/);
const VolumeProposal = z.object({ volume: VolumeId, chapters: z.array(z.string()), sourceHash: z.string(), summary: z.string().min(1), applied: z.boolean().default(false) });
export type VolumeSummaryProposal = z.infer<typeof VolumeProposal>;

function proposalFile(paths: BookPaths, volume: string): string { return join(paths.summariesDir, `${VolumeId.parse(volume)}.proposal.yaml`); }
function summaryFile(paths: BookPaths, volume: string): string { return join(paths.summariesDir, `${VolumeId.parse(volume)}.md`); }
type ChapterEntry = { chapter: string; summary: string };
async function materials(paths: BookPaths, volume: string): Promise<{ chapters: string[]; entries: ChapterEntry[]; sourceHash: string }> {
  const entries: Array<{ chapter: string; summary: string }> = [];
  for (const id of await listOutlinedChapters(paths)) {
    const outline = await readChapterOutline(paths, id);
    if (outline?.volume !== volume) continue;
    const summary = await readSummary(paths, id);
    if (summary === undefined || summary.trim() === "" || isSummaryPlaceholder(summary)) throw new Error(`${id} 属于 ${volume}，但尚无有效章节摘要`);
    entries.push({ chapter: id, summary: summary.trim() });
  }
  if (entries.length === 0) throw new Error(`${volume} 没有已归属的章节；先用 novel plan set <章节> volume ${volume}`);
  const source = JSON.stringify(entries);
  return { chapters: entries.map((e) => e.chapter), entries, sourceHash: createHash("sha256").update(source).digest("hex") };
}

const MAX_MATERIAL_CHARS = 18000;
function batches(entries: ChapterEntry[]): ChapterEntry[][] {
  const result: ChapterEntry[][] = [];
  let current: ChapterEntry[] = [];
  for (const entry of entries) {
    if (JSON.stringify([entry]).length > MAX_MATERIAL_CHARS) {
      throw new Error(`${entry.chapter} 的摘要过长，请先压缩该章节摘要后重试`);
    }
    if (current.length > 0 && JSON.stringify([...current, entry]).length > MAX_MATERIAL_CHARS) {
      result.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 0) result.push(current);
  return result;
}

export async function proposeVolumeSummary(options: { booksRoot: string; bookId?: string; volume: string; config: ResolvedConfig; provider?: LlmProvider; force?: boolean }): Promise<VolumeSummaryProposal> {
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const target = proposalFile(resolved.paths, options.volume);
  if (existsSync(target) && options.force !== true) throw new Error("卷摘要提案已存在；重提请加 --force");
  const input = await materials(resolved.paths, options.volume);
  const outline = await readTextFileOr(join(resolved.paths.volumesDir, `${options.volume}.md`), "");
  if (outline.length > 4000) throw new Error("卷纲超过 4000 字符，请先压缩卷纲后重试");
  const provider = options.provider ?? createProvider(options.config);
  let entries = input.entries;
  let summary = "";
  for (let round = 0; round < 8; round++) {
    const groups = batches(entries);
    const partials: ChapterEntry[] = [];
    for (const group of groups) {
      const result = await provider.complete([
        { role: "system", content: "你是长篇小说编辑。根据已确认的章节摘要压缩成准确的卷摘要，不增加未发生的情节。只输出摘要正文。" },
        { role: "user", content: `卷：${options.volume}\n卷纲：${outline}\n章节范围：${group[0]?.chapter} 至 ${group.at(-1)?.chapter}\n章节摘要：${JSON.stringify(group)}\n请用约 600 字写摘要，突出阶段目标、人物状态、未回收伏笔和后续衔接。` },
      ], { model: options.config.llm.utilityModel ?? options.config.llm.model, temperature: 0, maxTokens: 1200 });
      const part = result.text.trim();
      if (part === "") throw new Error("模型返回了空卷摘要");
      partials.push({ chapter: `${group[0]?.chapter}..${group.at(-1)?.chapter}`, summary: part });
    }
    if (groups.length === 1) {
      summary = partials[0]?.summary ?? "";
      break;
    }
    if (JSON.stringify(partials).length >= JSON.stringify(entries).length) throw new Error("分批卷摘要未能压缩输入，请缩短章节摘要后重试");
    entries = partials;
  }
  if (summary === "") throw new Error("卷摘要分批压缩次数过多，请缩短章节摘要后重试");
  const proposal = VolumeProposal.parse({ volume: options.volume, chapters: input.chapters, sourceHash: input.sourceHash, summary });
  await writeYamlFile(target, proposal, "卷摘要待确认提案；使用 novel volume adopt 明确采用。");
  return proposal;
}

export async function readVolumeProposal(paths: BookPaths, volume: string): Promise<VolumeSummaryProposal> {
  const file = proposalFile(paths, volume);
  if (!existsSync(file)) throw new Error(`找不到卷摘要提案：${file}`);
  return readYamlValidated(file, VolumeProposal);
}

export async function adoptVolumeSummary(paths: BookPaths, volume: string, force = false): Promise<string> {
  const proposal = await readVolumeProposal(paths, volume);
  const input = await materials(paths, volume);
  if (input.sourceHash !== proposal.sourceHash) throw new Error("章节摘要在卷提案生成后已改动，请重新生成卷摘要");
  const target = summaryFile(paths, volume);
  if (existsSync(target) && !force && (await readTextFileOr(target, "")).trim() !== "") throw new Error("已有卷摘要；确认覆盖请加 --force");
  await writeTextFile(target, proposal.summary.trim() + "\n");
  await writeYamlFile(proposalFile(paths, volume), { ...proposal, applied: true });
  return target;
}
