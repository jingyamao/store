/**
 * 文件读写层。
 *
 * 两条铁律：
 *   1. 所有写入都是原子的（临时文件 + rename），避免半截文件污染 Bible。
 *   2. 所有 YAML 读取都必须过 zod 校验，绝不让未知结构流入内存。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYamlText, stringify as stringifyYamlText } from "yaml";
import { z } from "zod";

/** YAML 输出选项。lineWidth: 0 关闭折行 —— 中文正文被折行会很难读。 */
const YAML_DUMP_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  minContentWidth: 0,
} as const;

/** 文件内容不符合 schema 时抛出，携带字段级定位信息。 */
export class SchemaMismatchError extends Error {
  override readonly name = "SchemaMismatchError";

  constructor(
    readonly filePath: string,
    readonly details: string,
  ) {
    super(`${filePath} 校验失败：\n${details}`);
  }
}

/** YAML 语法本身有问题时抛出。 */
export class YamlSyntaxError extends Error {
  override readonly name = "YamlSyntaxError";

  constructor(
    readonly filePath: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${filePath} 不是合法 YAML：${reason}`);
  }
}

function formatIssues(issues: ReadonlyArray<{ path?: PropertyKey[]; message?: string }>): string {
  return issues
    .map((issue) => {
      const segments = (issue.path ?? []).map(String);
      const where = segments.length > 0 ? segments.join(".") : "(根)";
      return `  · ${where}: ${issue.message ?? "未知错误"}`;
    })
    .join("\n");
}

/** 原子写入：先写临时文件，再 rename 覆盖。 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/* ── 文本文件 ─────────────────────────────────── */

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function readTextFileOr(filePath: string, fallback: string): Promise<string> {
  return existsSync(filePath) ? readFile(filePath, "utf8") : fallback;
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await atomicWrite(filePath, content);
}

/* ── YAML ─────────────────────────────────────── */

/** 只解析 YAML，不做校验。空文件视为空对象。 */
export async function readYamlRaw(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  if (text.trim() === "") return {};
  try {
    return parseYamlText(text);
  } catch (error) {
    throw new YamlSyntaxError(filePath, error);
  }
}

/** 读取并校验。校验失败抛 SchemaMismatchError。 */
export async function readYamlValidated<S extends z.ZodType>(
  filePath: string,
  schema: S,
): Promise<z.infer<S>> {
  const raw = await readYamlRaw(filePath);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new SchemaMismatchError(filePath, formatIssues(result.error.issues));
  }
  return result.data;
}

/** 校验任意内存数据（用于写入前自检）。 */
export function validate<S extends z.ZodType>(
  schema: S,
  data: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SchemaMismatchError(context, formatIssues(result.error.issues));
  }
  return result.data;
}

/** 序列化为 YAML 文本，可选前置注释头。 */
export function dumpYaml(data: unknown, header?: string): string {
  const body = stringifyYamlText(data, YAML_DUMP_OPTIONS);
  if (header === undefined) return body;
  const banner = header
    .split("\n")
    .map((line) => (line.trim() === "" ? "#" : `# ${line}`))
    .join("\n");
  return `${banner}\n${body}`;
}

export async function writeYamlFile(
  filePath: string,
  data: unknown,
  header?: string,
): Promise<void> {
  await atomicWrite(filePath, dumpYaml(data, header));
}
