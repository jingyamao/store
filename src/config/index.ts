/**
 * 工作区配置：novel.config.yaml，放在工作区根目录。
 *
 * 密钥刻意不进配置文件 —— 用 apiKeyEnv 指向一个环境变量名，
 * 这样配置文件可以安全地提交进 git。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYamlText } from "yaml";
import { z } from "zod";
import { DEFAULT_LAYER_SHARES } from "../generate/layers.js";
import { readYamlValidated, validate, writeTextFile } from "../store/file-io.js";
import { parsedDefault } from "../util/zod.js";

export const CONFIG_FILENAME = "novel.config.yaml";

/* ── LLM ──────────────────────────────────────── */

export const LlmConfigSchema = z.object({
  /** OpenAI 兼容接口的 base URL。 */
  baseUrl: z.string().default("https://api.deepseek.com/v1"),
  model: z.string().default("deepseek-chat"),
  /** 便宜的快模型，用于摘要 / 抽取等辅助任务；留空则复用 model。 */
  utilityModel: z.string().optional(),
  /** 从哪个环境变量读密钥。 */
  apiKeyEnv: z.string().default("DEEPSEEK_API_KEY"),
  /** 直接内联密钥。不推荐，仅为本机临时使用提供。 */
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.85),
  maxTokens: z.number().int().positive().default(4096),
  timeoutMs: z.number().int().positive().default(180000),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

/* ── 上下文预算 ───────────────────────────────── */

export const LayerBudgetSchema = z.object({
  style: z.number().min(0).default(DEFAULT_LAYER_SHARES.style),
  global: z.number().min(0).default(DEFAULT_LAYER_SHARES.global),
  entities: z.number().min(0).default(DEFAULT_LAYER_SHARES.entities),
  threads: z.number().min(0).default(DEFAULT_LAYER_SHARES.threads),
  recent: z.number().min(0).default(DEFAULT_LAYER_SHARES.recent),
  summaries: z.number().min(0).default(DEFAULT_LAYER_SHARES.summaries),
});

export type LayerBudget = z.infer<typeof LayerBudgetSchema>;

export const BudgetConfigSchema = z.object({
  /** 模型上下文窗口总大小。 */
  contextWindow: z.number().int().positive().default(64000),
  /** 留给输出的 token —— 装配上下文时必须把这部分扣掉。 */
  reserveForOutput: z.number().int().nonnegative().default(8000),
  /** 各层占比，使用时会归一化，不必凑成 1。 */
  layers: LayerBudgetSchema.default(parsedDefault(LayerBudgetSchema)),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

/* ── 生成 ─────────────────────────────────────── */

export const GenerationConfigSchema = z.object({
  /** 注入前几章全文。 */
  recentChapters: z.number().int().min(0).max(10).default(2),
  defaultTargetWords: z.number().int().positive().default(2500),
  /** 开篇方案数量。 */
  openings: z.number().int().min(1).max(5).default(3),
  /** 生成后是否对初稿跑确定性 lint。 */
  lintDraft: z.boolean().default(true),
});

export type GenerationConfig = z.infer<typeof GenerationConfigSchema>;

/* ── 总配置 ───────────────────────────────────── */

export const NovelConfigSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  llm: LlmConfigSchema.default(parsedDefault(LlmConfigSchema)),
  budget: BudgetConfigSchema.default(parsedDefault(BudgetConfigSchema)),
  generation: GenerationConfigSchema.default(parsedDefault(GenerationConfigSchema)),
});

export type NovelConfig = z.infer<typeof NovelConfigSchema>;

export function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, CONFIG_FILENAME);
}

/* ── 解析 ─────────────────────────────────────── */

export interface ResolvedConfig {
  readonly llm: LlmConfig;
  readonly budget: BudgetConfig;
  readonly generation: GenerationConfig;
  /** 实际解析到的密钥。 */
  readonly apiKey: string | undefined;
  /** 密钥来源，用于报错时给出可操作的提示。 */
  readonly apiKeySource: string;
  readonly configPath: string;
  readonly configExists: boolean;
}

function resolveApiKey(llm: LlmConfig): { apiKey: string | undefined; apiKeySource: string } {
  const direct = process.env["NOVEL_LLM_API_KEY"];
  if (direct !== undefined && direct.trim() !== "") {
    return { apiKey: direct.trim(), apiKeySource: "环境变量 NOVEL_LLM_API_KEY" };
  }

  const fromNamed = process.env[llm.apiKeyEnv];
  if (fromNamed !== undefined && fromNamed.trim() !== "") {
    return { apiKey: fromNamed.trim(), apiKeySource: `环境变量 ${llm.apiKeyEnv}` };
  }

  if (llm.apiKey !== undefined && llm.apiKey.trim() !== "") {
    return { apiKey: llm.apiKey.trim(), apiKeySource: `${CONFIG_FILENAME} 内联` };
  }

  return { apiKey: undefined, apiKeySource: "未配置" };
}

/**
 * 装载配置。文件不存在时全部走默认值，因此「零配置可用」。
 *
 * 环境变量 NOVEL_LLM_BASE_URL / NOVEL_LLM_MODEL 会覆盖文件里的值，
 * 便于在不同机器上共用同一份配置文件。
 */
export async function loadConfig(workspaceRoot: string): Promise<ResolvedConfig> {
  const filePath = configPath(workspaceRoot);
  const configExists = existsSync(filePath);

  const raw = configExists
    ? await readYamlValidated(filePath, NovelConfigSchema)
    : NovelConfigSchema.parse({});

  const llm: LlmConfig = {
    ...raw.llm,
    baseUrl: process.env["NOVEL_LLM_BASE_URL"] ?? raw.llm.baseUrl,
    model: process.env["NOVEL_LLM_MODEL"] ?? raw.llm.model,
  };

  const { apiKey, apiKeySource } = resolveApiKey(llm);

  return {
    llm,
    budget: raw.budget,
    generation: raw.generation,
    apiKey,
    apiKeySource,
    configPath: filePath,
    configExists,
  };
}

/* ── 生成默认配置文件 ─────────────────────────── */

const DEFAULT_CONFIG_TEMPLATE = `# novel 工作区配置
#
# 密钥刻意不进这个文件 —— 用 apiKeyEnv 指向一个环境变量名，
# 这样本文件可以安全地提交进 git。

llm:
  # 任何 OpenAI 兼容接口都可以。常见选择：
  #   DeepSeek   https://api.deepseek.com/v1
  #   Kimi       https://api.moonshot.cn/v1
  #   OpenAI     https://api.openai.com/v1
  baseUrl: https://api.deepseek.com/v1
  model: deepseek-chat
  # 便宜的快模型，用于摘要 / 抽取等辅助任务；留空则复用 model
  # utilityModel: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
  temperature: 0.85
  maxTokens: 4096
  timeoutMs: 180000

budget:
  # 模型上下文窗口总大小，换模型时请自行调整
  contextWindow: 64000
  # 留给输出的 token —— 装配上下文时会自动扣掉
  reserveForOutput: 8000
  # 各层占比，使用时会归一化
  layers:
    style: 0.08        # 文风锚定（刻意不裁剪）
    global: 0.10       # 全书总纲 + 卷纲
    entities: 0.22     # 本章出场人物卡
    threads: 0.07      # 伏笔线索
    recent: 0.30       # 前 N 章全文
    summaries: 0.23    # 更早章节摘要

generation:
  # 注入前几章全文
  recentChapters: 2
  defaultTargetWords: 2500
  # 开篇方案数量
  openings: 3
  # 生成后对初稿跑确定性 lint
  lintDraft: true
`;

export async function writeDefaultConfig(
  workspaceRoot: string,
  options?: { force?: boolean },
): Promise<string> {
  const filePath = configPath(workspaceRoot);
  if (existsSync(filePath) && options?.force !== true) {
    throw new Error(`${filePath} 已存在。如需覆盖请加 --force。`);
  }

  // 模板本身必须能过 schema —— 否则用户照着它改出来的配置就是坏的
  validate(NovelConfigSchema, parseYamlText(DEFAULT_CONFIG_TEMPLATE), "默认配置模板");

  await writeTextFile(filePath, DEFAULT_CONFIG_TEMPLATE);
  return filePath;
}
