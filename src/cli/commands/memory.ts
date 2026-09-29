import { readTextFile } from "../../store/file-io.js";
import { booksRootOf, type GlobalOptions } from "../context.js";
import { loadHistorySnapshot, recordManualFact } from "../../memory/history.js";
import { projectBibleAsOf } from "../../agent/memory.js";
import { chapterNumber } from "../../domain/ids.js";
import { listChapterIds } from "../../store/chapters.js";
import { resolveBook } from "../../store/paths.js";
import { parseScalar } from "../../util/dotted-path.js";
import * as ui from "../ui.js";

export async function runMemoryRecord(
  chapter: string,
  collection: string,
  id: string,
  field: string,
  rawValue: string | undefined,
  options: { evidence: string; authorNote?: boolean; force?: boolean; valueFile?: string },
  global: GlobalOptions,
): Promise<number> {
  if (collection !== "characters" && collection !== "items" && collection !== "threads") {
    throw new Error("collection 只支持 characters、items、threads");
  }
  if (rawValue === undefined && options.valueFile === undefined) throw new Error("请提供值，或使用 --value-file 指向 JSON 文件");
  if (rawValue !== undefined && options.valueFile !== undefined) throw new Error("位置参数 value 与 --value-file 只能选一个");
  const value = options.valueFile === undefined
    ? parseScalar(rawValue ?? "")
    : JSON.parse(await readTextFile(options.valueFile)) as unknown;
  const saved = await recordManualFact({
    booksRoot: booksRootOf(global), bookId: global.book, chapter, collection, id, field, value,
    evidence: options.evidence, authorNote: options.authorNote === true, force: options.force === true,
  });
  process.stdout.write(global.json === true
    ? `${JSON.stringify(saved, null, 2)}\n`
    : `${ui.green("✓")} 已记录 ${saved.fact.chapter} ${id}.${field}\n文件：${saved.file}\n`);
  return 0;
}

export async function runMemoryShow(chapter: string, entity: string | undefined, global: GlobalOptions): Promise<number> {
  const snapshot = await loadHistorySnapshot(booksRootOf(global), global.book);
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const chapterIds = await listChapterIds(resolved.paths);
  const latest = chapterIds.reduce((max, id) => Math.max(max, chapterNumber(id)), 0);
  const projected = projectBibleAsOf(snapshot.bible, chapter, snapshot.proposals, snapshot.manual, snapshot.staleProposals, latest);
  const facts = entity === undefined ? projected.facts : projected.facts.filter((fact) => fact.id === entity);
  const warnings = [...snapshot.warnings, ...projected.warnings];
  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ chapter, facts, warnings }, null, 2)}\n`);
    return 0;
  }
  const lines = [`${ui.bold(chapter)} 之前已确认的历史事实`, ""];
  if (facts.length === 0) lines.push("没有匹配的历史事实。");
  for (const fact of facts) lines.push(`${fact.chapter}  ${fact.id}.${fact.field} = ${JSON.stringify(fact.value)}\n  来源：${fact.source}`);
  for (const warning of warnings) lines.push(`${ui.yellow("!")} ${warning}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
