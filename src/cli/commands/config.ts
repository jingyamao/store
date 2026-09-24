/**
 * `novel config` —— 工作区配置。
 *
 * show 会把密钥打码，只显示来源 —— 免得截图求助时把密钥一起泄出去。
 */

import { loadConfig, writeDefaultConfig, CONFIG_FILENAME } from "../../config/index.js";
import { CONTEXT_LAYER_IDS, CONTEXT_LAYER_LABELS, LAYER_NOTES } from "../../generate/layers.js";
import { resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(Math.min(12, key.length - 8))}${key.slice(-4)}`;
}

export async function runConfigShow(global: GlobalOptions): Promise<number> {
  const root = resolveWorkspaceRoot(global.dir);
  const config = await loadConfig(root);

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          workspace: root,
          configPath: config.configPath,
          configExists: config.configExists,
          llm: { ...config.llm, apiKey: undefined },
          apiKeyConfigured: config.apiKey !== undefined,
          apiKeySource: config.apiKeySource,
          budget: config.budget,
          generation: config.generation,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(`${ui.bold("工作区配置")}  ${ui.dim(root)}`);
  lines.push("");

  if (!config.configExists) {
    lines.push(
      `${ui.yellow("!")} ${CONFIG_FILENAME} 不存在，当前全部使用默认值。\n` +
        `  运行 ${ui.cyan("novel config init")} 生成一份带注释的配置。\n`,
    );
  }

  lines.push(ui.heading("模型"));
  lines.push(ui.keyValue("接口", config.llm.baseUrl));
  lines.push(ui.keyValue("模型", config.llm.model));
  if (config.llm.utilityModel !== undefined) {
    lines.push(ui.keyValue("辅助模型", config.llm.utilityModel));
  }
  lines.push(ui.keyValue("温度", String(config.llm.temperature)));
  lines.push(ui.keyValue("输出上限", `${config.llm.maxTokens} token`));
  lines.push(ui.keyValue("超时", `${Math.round(config.llm.timeoutMs / 1000)} 秒`));

  const keyLine =
    config.apiKey === undefined
      ? ui.red("未配置")
      : `${ui.green(maskKey(config.apiKey))}  ${ui.dim(`（来自 ${config.apiKeySource}）`)}`;
  lines.push(ui.keyValue("API Key", keyLine));

  lines.push("");
  lines.push(ui.heading("上下文预算"));
  lines.push(
    ui.keyValue(
      "窗口",
      `${config.budget.contextWindow.toLocaleString("en-US")} token` +
        `  ${ui.dim(`（预留输出 ${config.budget.reserveForOutput.toLocaleString("en-US")}）`)}`,
    ),
  );

  const available = Math.max(0, config.budget.contextWindow - config.budget.reserveForOutput);
  const shares = config.budget.layers;
  const sum = CONTEXT_LAYER_IDS.reduce((acc, id) => acc + Math.max(0, shares[id]), 0);

  lines.push("");
  lines.push(
    ui.renderTable(
      ["层", "占比", "可用 token", "说明"],
      CONTEXT_LAYER_IDS.map((id) => [
        CONTEXT_LAYER_LABELS[id],
        sum > 0 ? `${Math.round((shares[id] / sum) * 100)}%` : ui.dim("均分"),
        sum > 0 ? Math.floor((shares[id] / sum) * available).toLocaleString("en-US") : "—",
        ui.dim(LAYER_NOTES[id]),
      ]),
    ),
  );

  lines.push("");
  lines.push(ui.heading("生成"));
  lines.push(ui.keyValue("近期正文", `前 ${config.generation.recentChapters} 章`));
  lines.push(ui.keyValue("目标字数", `${config.generation.defaultTargetWords} 字`));
  lines.push(ui.keyValue("开篇方案", `${config.generation.openings} 个`));
  lines.push(ui.keyValue("初稿自检", config.generation.lintDraft ? "开" : "关"));

  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

export interface ConfigInitOptions {
  readonly force?: boolean | undefined;
}

export async function runConfigInit(
  options: ConfigInitOptions,
  global: GlobalOptions,
): Promise<number> {
  const root = resolveWorkspaceRoot(global.dir);
  const filePath = await writeDefaultConfig(root, {
    ...(options.force !== undefined ? { force: options.force } : {}),
  });

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ configPath: filePath }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已生成 ${ui.bold(filePath)}\n\n` +
      "密钥刻意不写进这个文件。设置好环境变量即可生成：\n" +
      ui.bullet(ui.cyan("set DEEPSEEK_API_KEY=你的密钥")) +
      "\n" +
      `换模型直接改 ${ui.cyan(CONFIG_FILENAME)} 里的 baseUrl 与 model，\n` +
      "任何 OpenAI 兼容接口都可以。\n",
  );
  return 0;
}
