/**
 * LLM 入口。
 */

import type { ResolvedConfig } from "../config/index.js";
import { OpenAiCompatibleProvider } from "./openai.js";
import { LlmError, type LlmProvider } from "./types.js";

export * from "./types.js";
export { MockProvider, type MockCall, type MockProviderOptions } from "./mock.js";
export {
  OpenAiCompatibleProvider,
  parseCompletion,
  type OpenAiProviderOptions,
} from "./openai.js";

/**
 * 按配置造一个 provider。
 *
 * 没有密钥时抛出可操作的错误 —— 生成功能是唯一需要密钥的地方，
 * 而其余命令（lint / status / plan）必须保持零配置可用。
 */
export function createProvider(config: ResolvedConfig): LlmProvider {
  if (config.apiKey === undefined) {
    throw new LlmError(
      [
        "没有找到模型 API Key，无法生成。",
        "",
        `  当前配置期望从环境变量 ${config.llm.apiKeyEnv} 读取。`,
        "",
        "任选一种方式解决：",
        `  · 设置环境变量：set ${config.llm.apiKeyEnv}=你的密钥`,
        `  · 或在 ${config.configPath} 里改 llm.apiKeyEnv 指向别的变量名`,
        "",
        "（只想看看会发给模型什么内容，可以用 novel write <章> --dry-run，不需要密钥）",
      ].join("\n"),
    );
  }

  return new OpenAiCompatibleProvider({
    baseUrl: config.llm.baseUrl,
    apiKey: config.apiKey,
    model: config.llm.model,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    timeoutMs: config.llm.timeoutMs,
  });
}
