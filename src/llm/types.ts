/**
 * 模型调用的最小抽象。
 *
 * 刻意只保留「一次补全」所需的东西，不引入任何厂商 SDK ——
 * DeepSeek / Kimi / OpenAI / 本地 Ollama 都提供 OpenAI 兼容接口，
 * 一个 fetch 就够了。少一层依赖，也少一层版本兼容问题。
 */

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface CompletionOptions {
  readonly model?: string | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly usage: TokenUsage | undefined;
  /** 服务端返回的原始 JSON，写进 runs 记录便于排查。 */
  readonly raw: unknown;
}

export interface LlmProvider {
  /** 供应商标识，用于展示与 runs 记录。 */
  readonly name: string;
  /** 默认模型名。 */
  readonly model: string;
  complete(
    messages: readonly LlmMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult>;
}

export interface LlmErrorOptions {
  readonly status?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly cause?: unknown;
}

/** 模型调用相关错误的统一类型。 */
export class LlmError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: LlmErrorOptions = {}) {
    super(message);
    this.name = "LlmError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}
