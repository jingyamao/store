/** 仅监听 localhost 的单人写作台 API。文件仍是唯一数据源。 */
import { createHash } from "node:crypto";
import { runWritingAgent } from "../agent/run.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { loadConfig } from "../config/index.js";
import { ChapterOutlineSchema, scaffoldChapterOutline } from "../domain/outline.js";
import { generateChapter, applyExistingRun, listRuns, readRunDetails } from "../generate/run.js";
import { createLintContext, runLint } from "../lint/index.js";
import { reviewChapter } from "../review/index.js";
import { rebuildSearchIndex, searchBook } from "../search/index.js";
import { loadBible } from "../store/bible.js";
import { parseChapterId, readChapterText, writeChapterText } from "../store/chapters.js";
import { compareRevision, HistoryConflictError, listRevisions, restoreRevision, type HistoryKind } from "../store/history.js";
import { readChapterOutline, writeChapterOutline } from "../store/outlines.js";
import { resolveBook } from "../store/paths.js";
import { loadProgress } from "../store/progress.js";
import { applySync, proposeSync, readProposal } from "../sync/index.js";
import { withChapterLock } from "../sync/lock.js";
import { PAGE } from "./page.js";
import { STYLES } from "./styles.js";
import { CLIENT } from "./client.js";

export interface WorkbenchOptions {
  readonly booksRoot: string;
  readonly workspaceRoot: string;
  readonly bookId?: string | undefined;
  readonly port?: number | undefined;
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("请求必须使用 application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += data.length;
    if (size > 2_000_000) throw new Error("请求正文过大");
    chunks.push(data);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("请求正文必须是 JSON 对象");
  return value as Record<string, unknown>;
}
function chapterFrom(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const id = path.slice(prefix.length);
  return id.includes("/") ? undefined : parseChapterId(id);
}
function historyKind(value: string | null): HistoryKind {
  if (value === "text" || value === "outline") return value;
  throw new Error("kind 只能是 text 或 outline");
}
const OutlinePatch = z.object({
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(120),
  intent: z.string().max(4000),
  conflict: z.string().max(4000),
  cast: z.array(z.string()).max(30),
  targetWords: z.number().int().positive().nullable(),
}).strict();

export async function startWorkbench(options: WorkbenchOptions): Promise<{ server: Server; url: string }> {
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const paths = resolved.paths;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = url.pathname;
      if (req.method === "GET" && route === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(PAGE);
      } else if (req.method === "GET" && route === "/app.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(STYLES);
      } else if (req.method === "GET" && route === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(CLIENT);
      } else if (req.method === "GET" && route === "/api/state") {
        const [progress, bible] = await Promise.all([loadProgress(paths), loadBible(options.booksRoot, resolved.id)]);
        json(res, 200, { book: bible.book, chapters: progress.chapters, characters: bible.characters.map((c) => ({ id: c.id, name: c.name, state: c.state })), threads: bible.threads });
      } else if (req.method === "GET" && route === "/api/runs") {
        json(res, 200, await listRuns(paths));
      } else if (req.method === "GET" && route.startsWith("/api/run/")) {
        json(res, 200, await readRunDetails(paths, route.slice("/api/run/".length)));
      } else if (req.method === "GET" && route === "/api/search") {
        await rebuildSearchIndex(options.booksRoot, resolved.id);
        json(res, 200, await searchBook(options.booksRoot, resolved.id, url.searchParams.get("q") ?? ""));
      } else if (req.method === "POST" && route === "/api/index") {
        json(res, 200, { indexed: await rebuildSearchIndex(options.booksRoot, resolved.id) });
      } else if (req.method === "POST" && route === "/api/generate") {
        const input = await body(req);
        const chapter = parseChapterId(String(input["chapter"] ?? ""));
        const config = await loadConfig(options.workspaceRoot);
        const result = await generateChapter({ booksRoot: options.booksRoot, bookId: resolved.id, chapterId: chapter, config,
          openingsOnly: input["openingsOnly"] === true, fromRun: typeof input["fromRun"] === "string" ? input["fromRun"] : undefined,
          pick: typeof input["pick"] === "number" ? input["pick"] : undefined });
        json(res, 200, { run: result.runDir.split(/[\\/]/).at(-1), openings: result.openings, draft: result.draft ?? null, findings: result.record.draftCheck });
      } else if (req.method === "POST" && route === "/api/agent/write") {
        const input = await body(req);
        const chapter = parseChapterId(String(input["chapter"] ?? ""));
        const config = await loadConfig(options.workspaceRoot);
        const result = await runWritingAgent({ booksRoot: options.booksRoot, bookId: resolved.id, chapterId: chapter, config,
          dryRun: input["dryRun"] === true });
        const run = result.runDir.split(/[\\/]/).at(-1) ?? "";
        const detail = await readRunDetails(paths, run);
        json(res, 200, { run, draft: result.draft ?? null, findings: result.record.draftCheck,
          warnings: result.record.warnings, usage: result.record.usage, agentPlan: detail.agentPlan, memorySources: detail.memorySources });
      } else if (req.method === "POST" && route === "/api/adopt") {
        const input = await body(req);
        json(res, 200, { outputFile: await applyExistingRun(paths, String(input["run"] ?? ""), false,
          typeof input["baseHash"] === "string" ? input["baseHash"] : undefined) });
      } else if (req.method === "GET" && chapterFrom(route, "/api/chapter/") !== undefined) {
        const chapter = chapterFrom(route, "/api/chapter/") ?? "";
        const text = await readChapterText(paths, chapter) ?? "";
        const outline = await readChapterOutline(paths, chapter) ?? null;
        json(res, 200, { chapter, text, hash: hash(text), outline, outlineHash: hash(JSON.stringify(outline ?? scaffoldChapterOutline(chapter))) });
      } else if (req.method === "GET" && /^\/api\/history\/ch-\d{4,}$/.test(route)) {
        const chapter = parseChapterId(route.slice("/api/history/".length));
        const kind = historyKind(url.searchParams.get("kind"));
        json(res, 200, { chapter, kind, versions: await listRevisions(paths, chapter, kind) });
      } else if (req.method === "GET" && /^\/api\/history\/ch-\d{4,}\/[^/]+$/.test(route)) {
        const [, chapter = "", revision = ""] = /^\/api\/history\/(ch-\d{4,})\/([^/]+)$/.exec(route) ?? [];
        const kind = historyKind(url.searchParams.get("kind"));
        json(res, 200, await compareRevision(paths, parseChapterId(chapter), kind, revision));
      } else if (req.method === "POST" && /^\/api\/history\/ch-\d{4,}\/[^/]+\/restore$/.test(route)) {
        const [, chapter = "", revision = ""] = /^\/api\/history\/(ch-\d{4,})\/([^/]+)\/restore$/.exec(route) ?? [];
        const input = await body(req);
        const kind = historyKind(typeof input["kind"] === "string" ? input["kind"] : null);
        if (typeof input["baseHash"] !== "string" || !/^[a-f0-9]{64}$/.test(input["baseHash"])) throw new Error("baseHash 必须是当前文件的 SHA-256");
        const result = await withChapterLock(paths, () => restoreRevision(paths, parseChapterId(chapter), kind, revision, input["baseHash"] as string));
        json(res, 200, result);
      } else if (req.method === "PATCH" && chapterFrom(route, "/api/outline/") !== undefined) {
        const chapter = chapterFrom(route, "/api/outline/") ?? "";
        const patch = OutlinePatch.parse(await body(req));
        await withChapterLock(paths, async () => {
          const existing = await readChapterOutline(paths, chapter) ?? scaffoldChapterOutline(chapter);
          if (patch.baseHash !== hash(JSON.stringify(existing))) { json(res, 409, { error: "细纲已被其他操作修改，请重新打开章节后再保存" }); return; }
          const outline = ChapterOutlineSchema.parse({ ...existing, ...patch, targetWords: patch.targetWords ?? undefined });
          await writeChapterOutline(paths, outline);
          json(res, 200, { outline, hash: hash(JSON.stringify(outline)) });
        });
      } else if (req.method === "PUT" && chapterFrom(route, "/api/chapter/") !== undefined) {
        const chapter = chapterFrom(route, "/api/chapter/") ?? "";
        const input = await body(req);
        await withChapterLock(paths, async () => {
          const current = await readChapterText(paths, chapter) ?? "";
          if (input["baseHash"] !== hash(current)) json(res, 409, { error: "文件已被其他操作修改，请重新打开章节" });
          else if (typeof input["text"] !== "string") json(res, 400, { error: "text 必须是字符串" });
          else { await writeChapterText(paths, chapter, input["text"]); json(res, 200, { hash: hash(input["text"]) }); }
        });
      } else if (req.method === "GET" && chapterFrom(route, "/api/review/") !== undefined) {
        json(res, 200, await reviewChapter({ booksRoot: options.booksRoot, bookId: resolved.id, chapter: chapterFrom(route, "/api/review/") ?? "" }));
      } else if (req.method === "GET" && chapterFrom(route, "/api/proposal/") !== undefined) {
        try {
          json(res, 200, await readProposal(paths, chapterFrom(route, "/api/proposal/") ?? ""));
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("找不到状态提案")) json(res, 404, { error: error.message });
          else throw error;
        }
      } else if (req.method === "POST" && chapterFrom(route, "/api/proposal/") !== undefined) {
        const config = await loadConfig(options.workspaceRoot);
        const input = req.headers["content-type"]?.startsWith("application/json") ? await body(req) : {};
        json(res, 200, await proposeSync({ booksRoot: options.booksRoot, bookId: resolved.id, chapter: chapterFrom(route, "/api/proposal/") ?? "", config, force: input["force"] === true }));
      } else if (req.method === "POST" && chapterFrom(route, "/api/apply/") !== undefined) {
        const chapter = chapterFrom(route, "/api/apply/") ?? "";
        const input = await body(req);
        const accept = Array.isArray(input["accept"]) ? input["accept"].map(Number) : [];
        await applySync(paths, await readProposal(paths, chapter), { accept, acceptSummary: input["summary"] === true });
        json(res, 200, { applied: accept, lint: runLint(await createLintContext(options.booksRoot, resolved.id)).length });
      } else json(res, 404, { error: "找不到页面或接口" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, error instanceof HistoryConflictError ? 409 : 400, { error: message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4173, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port ?? 4173;
  return { server, url: `http://127.0.0.1:${port}` };
}
