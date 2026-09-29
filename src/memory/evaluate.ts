/** 可重复运行的章节历史事实评测，不调用模型。 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { projectBibleAsOf } from "../agent/memory.js";
import { chapterNumber } from "../domain/ids.js";
import { ChapterIdSchema, RelationshipSchema } from "../domain/schemas.js";
import { listChapterIds } from "../store/chapters.js";
import { readYamlValidated } from "../store/file-io.js";
import { resolveBook } from "../store/paths.js";
import { fieldSchemas } from "../sync/index.js";
import { getByPath } from "../util/dotted-path.js";
import { loadHistorySnapshot } from "./history.js";

const EvaluationCaseSchema = z.object({
  id: z.string().min(1),
  chapter: ChapterIdSchema,
  collection: z.enum(["characters", "items", "threads"]),
  entity: z.string().min(1),
  field: z.string().min(1),
  expected: z.unknown(),
  source: z.string().min(1).nullable().optional(),
}).strict();

export const EvaluationDatasetSchema = z.object({
  version: z.literal(1),
  cases: z.array(EvaluationCaseSchema).min(1),
}).strict();

export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;

export interface EvaluationResult {
  readonly id: string;
  readonly chapter: string;
  readonly collection: string;
  readonly entity: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly expectedSource: string | null;
  readonly source: string | null;
  readonly valuePass: boolean;
  readonly sourcePass: boolean;
  readonly pass: boolean;
  readonly warnings: readonly string[];
}

export interface EvaluationReport {
  readonly dataset: string;
  readonly bookId: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly accuracy: number;
  readonly byField: readonly { field: string; total: number; passed: number }[];
  readonly results: readonly EvaluationResult[];
}

export async function evaluateMemory(options: {
  booksRoot: string;
  bookId?: string;
  datasetPath: string;
}): Promise<EvaluationReport> {
  const dataset = await readYamlValidated(options.datasetPath, EvaluationDatasetSchema);
  const seen = new Set<string>();
  for (const item of dataset.cases) {
    if (seen.has(item.id)) throw new Error(`评测题目 ID 重复：${item.id}`);
    seen.add(item.id);
    if (!Object.hasOwn(item, "expected")) throw new Error(`评测题目 ${item.id} 缺少 expected`);
    const key = `${item.collection}:${item.field}`;
    const schema = key === "characters:relationships"
      ? z.array(RelationshipSchema)
      : fieldSchemas[key as keyof typeof fieldSchemas];
    if (schema === undefined) {
      throw new Error(`评测题目 ${item.id} 使用了不支持的历史字段：${key}`);
    }
    if (item.expected !== null && !schema.safeParse(item.expected).success) {
      throw new Error(`评测题目 ${item.id} 的 expected 不符合 ${key} 的字段类型`);
    }
  }
  const resolved = await resolveBook(options.booksRoot, options.bookId);
  const [snapshot, chapterIds] = await Promise.all([
    loadHistorySnapshot(options.booksRoot, resolved.id),
    listChapterIds(resolved.paths),
  ]);
  const latest = chapterIds.reduce((max, id) => Math.max(max, chapterNumber(id)), 0);
  const cache = new Map<string, ReturnType<typeof projectBibleAsOf>>();
  const results: EvaluationResult[] = [];
  for (const item of dataset.cases) {
    let projected = cache.get(item.chapter);
    if (projected === undefined) {
      projected = projectBibleAsOf(snapshot.bible, item.chapter, snapshot.proposals, snapshot.manual, snapshot.staleProposals, latest);
      cache.set(item.chapter, projected);
    }
    const entity = projected.bible[item.collection].find((entry) => entry.id === item.entity);
    if (entity === undefined) throw new Error(`评测题目 ${item.id} 引用不存在的实体：${item.collection}/${item.entity}`);
    const actual = getByPath(entity, item.field) ?? null;
    const fact = projected.facts.find((entry) => entry.collection === item.collection && entry.id === item.entity && entry.field === item.field);
    const source = fact?.source ?? null;
    const valuePass = isDeepStrictEqual(actual, item.expected);
    const sourcePass = item.source === undefined || item.source === source;
    results.push({
      id: item.id, chapter: item.chapter, collection: item.collection, entity: item.entity, field: item.field,
      expected: item.expected, actual, expectedSource: item.source ?? null, source, valuePass, sourcePass,
      pass: valuePass && sourcePass, warnings: [...snapshot.warnings, ...projected.warnings],
    });
  }
  const byField = new Map<string, { field: string; total: number; passed: number }>();
  for (const result of results) {
    const field = `${result.collection}:${result.field}`;
    const tally = byField.get(field) ?? { field, total: 0, passed: 0 };
    tally.total += 1;
    if (result.pass) tally.passed += 1;
    byField.set(field, tally);
  }
  const passed = results.filter((result) => result.pass).length;
  return {
    dataset: options.datasetPath, bookId: resolved.id, total: results.length, passed,
    failed: results.length - passed, accuracy: passed / results.length,
    byField: [...byField.values()].sort((a, b) => a.field.localeCompare(b.field)), results,
  };
}
