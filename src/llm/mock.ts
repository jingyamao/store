/**
 * 供测试与 --dry-run 使用的假 provider。
 *
 * 有了它，整条生成流水线可以在不联网、不花钱、结果确定的前提下被测试 ——
 * 这正是不把 fetch 调用散落在业务代码里的收益。
 */

import type {
  CompletionOptions,
  CompletionResult,
  LlmMessage,
  LlmProvider,
} from "./types.js";

export interface MockCall {
  readonly messages: readonly LlmMessage[];
  readonly options: CompletionOptions | undefined;
}

export interface MockProviderOptions {
  /** 按顺序返回的响应；用尽后重复最后一个。 */
  readonly responses?: readonly string[] | undefined;
  /** 或者按输入动态生成响应。 */
  readonly handler?:
    | ((messages: readonly LlmMessage[], options: CompletionOptions | undefined) => string | Promise<string>)
    | undefined;
  /** 每次调用前依次抛出的错误；对应位置为空则正常返回。 */
  readonly failures?: readonly (Error | undefined)[] | undefined;
  readonly model?: string | undefined;
  readonly name?: string | undefined;
}

export class MockProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  /** 收到的全部调用，供断言使用。 */
  readonly calls: MockCall[] = [];

  private readonly responses: readonly string[];
  private readonly handler: MockProviderOptions["handler"];
  private readonly failures: readonly (Error | undefined)[];

  constructor(options: MockProviderOptions = {}) {
    this.name = options.name ?? "mock";
    this.model = options.model ?? "mock-model";
    this.responses = options.responses ?? [];
    this.handler = options.handler;
    this.failures = options.failures ?? [];
  }

  async complete(
    messages: readonly LlmMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const index = this.calls.length;
    this.calls.push({ messages, options });

    const failure = this.failures[index];
    if (failure !== undefined) throw failure;

    let text: string;
    if (this.handler !== undefined) {
      text = await this.handler(messages, options);
    } else if (this.responses.length > 0) {
      text = this.responses[Math.min(index, this.responses.length - 1)] ?? "";
    } else {
      text = "";
    }

    return {
      text,
      model: options?.model ?? this.model,
      usage: {
        promptTokens: messages.reduce((sum, message) => sum + message.content.length, 0),
        completionTokens: text.length,
        totalTokens: 0,
      },
      raw: { mock: true },
    };
  }
}
