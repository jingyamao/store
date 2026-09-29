/** SQLite FTS5 是可重建索引；YAML/Markdown 始终是真相源。 */
import { existsSync } from "node:fs";
import type { ResolvedConfig } from "../config/index.js";
import { createProvider } from "../llm/index.js";
import type { LlmProvider } from "../llm/types.js";
import { loadBible } from "../store/bible.js";
import { loadChapters, loadSummaries } from "../store/chapters.js";
import { readTextFileOr } from "../store/file-io.js";
import { listOutlinedChapters, readChapterOutline } from "../store/outlines.js";
import { resolveBook, type BookPaths } from "../store/paths.js";

interface Document { readonly source: string; readonly chapter: string; readonly body: string }
export interface SearchHit { readonly source: string; readonly chapter: string; readonly snippet: string; readonly score: number }

async function sourceDocuments(booksRoot: string, bookId?: string): Promise<{ paths: BookPaths; documents: Document[] }> {
  const bible = await loadBible(booksRoot, bookId);
  const paths = bible.paths;
  const documents: Document[] = [];
  const [chapters, summaries, master] = await Promise.all([
    loadChapters(paths), loadSummaries(paths), readTextFileOr(paths.masterOutlineFile, ""),
  ]);
  if (master.trim()) documents.push({ source: "outline/master.md", chapter: "", body: master });
  for (const [id, body] of chapters) if (body.trim()) documents.push({ source: `chapters/${id}.md`, chapter: id, body });
  for (const [id, body] of summaries) if (body.trim()) documents.push({ source: `summaries/${id}.md`, chapter: id, body });
  for (const id of await listOutlinedChapters(paths)) {
    const outline = await readChapterOutline(paths, id);
    if (outline !== undefined) documents.push({ source: `outline/chapters/${id}.yaml`, chapter: id, body: JSON.stringify(outline) });
  }
  for (const [key, entities] of Object.entries({ characters: bible.characters, items: bible.items, locations: bible.locations, factions: bible.factions, threads: bible.threads, settings: bible.settings })) {
    for (const entity of entities) documents.push({ source: `bible/${key}.yaml#${entity.id}`, chapter: "", body: JSON.stringify(entity) });
  }
  return { paths, documents };
}

/** 显式重建。写入一个独立索引，不修改任何作者数据。 */
export async function rebuildSearchIndex(booksRoot: string, bookId?: string): Promise<number> {
  const { paths, documents } = await sourceDocuments(booksRoot, bookId);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(paths.indexPath);
  try {
    db.exec("DROP TABLE IF EXISTS docs; CREATE VIRTUAL TABLE docs USING fts5(source UNINDEXED, chapter UNINDEXED, body, tokenize='trigram')");
    const insert = db.prepare("INSERT INTO docs(source, chapter, body) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    try {
      for (const doc of documents) insert.run(doc.source, doc.chapter, doc.body);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  return documents.length;
}

function queryTokens(query: string): string[] {
  const clean = query.replace(/[\s\p{P}\p{S}]+/gu, "");
  const grams = new Set<string>();
  for (let i = 0; i <= clean.length - 3; i++) grams.add(clean.slice(i, i + 3));
  return [...grams].slice(0, 16);
}

function snippet(body: string, query: string): string {
  const terms = queryTokens(query);
  const at = terms.map((term) => body.indexOf(term)).filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? body.indexOf(query);
  const start = Math.max(0, (at < 0 ? 0 : at) - 45);
  return `${start > 0 ? "…" : ""}${body.slice(start, start + 140).replace(/\s+/g, " ")}${start + 140 < body.length ? "…" : ""}`;
}

export async function searchBook(booksRoot: string, bookId: string | undefined, query: string, limit = 10): Promise<SearchHit[]> {
  if (query.trim() === "") return [];
  const resolved = await resolveBook(booksRoot, bookId);
  if (!existsSync(resolved.paths.indexPath)) await rebuildSearchIndex(booksRoot, resolved.id);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(resolved.paths.indexPath, { readOnly: true });
  try {
    const tokens = queryTokens(query.trim());
    let rows: Array<{ source: string; chapter: string; body: string; score: number }>;
    if (tokens.length > 0) {
      const expression = tokens.map((part) => `"${part.replaceAll('"', '""')}"`).join(" OR ");
      rows = db.prepare("SELECT source, chapter, body, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?")
        .all(expression, Math.max(1, Math.min(50, limit))) as typeof rows;
    } else {
      rows = db.prepare("SELECT source, chapter, body, 0 AS score FROM docs WHERE instr(body, ?) > 0 LIMIT ?")
        .all(query.trim(), Math.max(1, Math.min(50, limit))) as typeof rows;
    }
    return rows.map((row) => ({ source: row.source, chapter: row.chapter, snippet: snippet(row.body, query), score: row.score }));
  } finally {
    db.close();
  }
}

export async function askBook(options: { booksRoot: string; bookId?: string; question: string; config: ResolvedConfig; provider?: LlmProvider }): Promise<{ answer: string; hits: SearchHit[] }> {
  const hits = await searchBook(options.booksRoot, options.bookId, options.question, 8);
  if (hits.length === 0) return { answer: "没有检索到相关资料。可以先运行 novel index rebuild 更新索引。", hits };
  const provider = options.provider ?? createProvider(options.config);
  const evidence = hits.map((hit, i) => `[${i + 1}] ${hit.source}\n${hit.snippet}`).join("\n\n");
  const result = await provider.complete([
    { role: "system", content: "你是作者的小说资料助手。只依据提供的资料回答，无法确定就直说。每个事实后标注 [来源序号]。" },
    { role: "user", content: `问题：${options.question}\n\n资料：\n${evidence}` },
  ], { model: options.config.llm.utilityModel ?? options.config.llm.model, temperature: 0, maxTokens: 1000 });
  return { answer: result.text.trim(), hits };
}
