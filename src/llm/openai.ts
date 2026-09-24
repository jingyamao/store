/**
 * OpenAI 兼容的 HTTP provider。
 *
 * 只依赖内置 fetch，不引任何 SDK。带有限重试 —— 长文生成动辄几十秒，
 * 偶发 429 / 5xx 就整章重来代价太大。
 */

import {
  LlmError,
  type CompletionOptions,
  type CompletionResult,
  type LlmMessage,
  type LlmProvider,
  type TokenUsage,
} from "./types.js";

export interface OpenAiProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** 可重试错误的最大重试次数。 */
  readonly retries?: number | undefined;
  /** 指数退避的基准毫秒数。 */
  readonly retryDelayMs?: number | undefined;
  /** 注入 fetch，便于测试。 */
  readonly fetchImpl?: typeof fetch | undefined;
}

/** 这些状态码重试有意义：限流、超时、服务端偶发故障。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** 错误信息里回显响应体的长度上限。 */
const BODY_PREVIEW_LIMIT = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function preview(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > BODY_PREVIEW_LIMIT
    ? `${trimmed.slice(0, BODY_PREVIEW_LIMIT)}…`
    : trimmed;
}

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 把 OpenAI 格式的响应解析成 CompletionResult。 */
export function parseCompletion(payload: unknown, fallbackModel: string): CompletionResult {
  const root = payload as {
    model?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  } | null;

  const content = root?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content === "") {
    throw new LlmError(
      "模型响应里没有 choices[0].message.content —— 可能这个接口不是 OpenAI 兼容格式",
      { retryable: false },
    );
  }

  const usage = root?.usage;
  const parsedUsage: TokenUsage | undefined =
    usage === undefined || usage === null
      ? undefined
      : {
          promptTokens: toInt(usage.prompt_tokens),
          completionTokens: toInt(usage.completion_tokens),
          totalTokens: toInt(usage.total_tokens),
        };

  return {
    text: content,
    model: typeof root?.model === "string" ? root.model : fallbackModel,
    usage: parsedUsage,
    raw: payload,
  };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiProviderOptions) {
    this.model = options.model;
    this.name = `OpenAI 兼容接口（${options.model}）`;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = options.apiKey;
    this.defaultTemperature = options.temperature ?? 0.85;
    this.defaultMaxTokens = options.maxTokens ?? 4096;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1000);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async complete(
    messages: readonly LlmMessage[],
    options: CompletionOptions = {},
  ): Promise<CompletionResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        await delay(this.retryDelayMs * 2 ** (attempt - 1));
      }

      try {
        return await this.once(messages, options);
      } catch (error) {
        lastError = error;
        if (!(error instanceof LlmError) || !error.retryable) throw error;
      }
    }

    throw lastError;
  }

  private async once(
    messages: readonly LlmMessage[],
    options: CompletionOptions,
  ): Promise<CompletionResult> {
    const body = {
      model: options.model ?? this.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: options.temperature ?? this.defaultTemperature,
      max_tokens: options.maxTokens ?? this.defaultMaxTokens,
      stream: false,
    };

    const signal = options.signal ?? AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // 用户主动取消不该重试；超时与网络故障值得重试
      const aborted = options.signal?.aborted === true;
      throw new LlmError(`请求模型接口失败：${describeNetworkError(error, this.timeoutMs)}`, {
        retryable: !aborted,
        cause: error,
      });
    }

    const text = await response.text();

    if (!response.ok) {
      throw new LlmError(
        `模型接口返回 HTTP ${response.status}：${preview(text)}`,
        { status: response.status, retryable: RETRYABLE_STATUS.has(response.status) },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LlmError(`模型接口返回的不是合法 JSON：${preview(text)}`, {
        status: response.status,
      });
    }

    return parseCompletion(payload, options.model ?? this.model);
  }
}

function describeNetworkError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回（可用 llm.timeoutMs 调整）`;
    }
    if (error.name === "AbortError") return "已取消";
    return error.message;
  }
  return String(error);
}
