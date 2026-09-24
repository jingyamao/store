import { describe, it } from "node:test";
import { captureError, expect, expectRejects } from "../testing/expect.js";
import { MockProvider } from "./mock.js";
import { OpenAiCompatibleProvider, parseCompletion } from "./openai.js";
import { LlmError } from "./types.js";

/* ── 测试替身 ─────────────────────────────────── */

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function okBody(content: string, model = "test-model"): unknown {
  return {
    model,
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** 造一个假 fetch，并记录收到的请求。 */
function fakeFetch(
  handler: (call: Captured, index: number) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url: string }).url);

    const captured: Captured = { url, init: init ?? {} };
    calls.push(captured);
    return handler(captured, calls.length - 1);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {},
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test",
    model: "test-model",
    retryDelayMs: 0,
    fetchImpl,
    ...overrides,
  });
}

const USER: readonly { role: "user"; content: string }[] = [
  { role: "user", content: "写一段" },
];

/* ── 请求构造 ─────────────────────────────────── */

describe("请求构造", () => {
  it("打到 /chat/completions，带 Bearer 鉴权", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(okBody("好")));
    await provider(fetchImpl).complete(USER);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/v1/chat/completions");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("baseUrl 末尾的斜杠不会产生双斜杠", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(okBody("好")));
    await provider(fetchImpl, { baseUrl: "https://api.example.com/v1///" }).complete(USER);

    expect(calls[0]?.url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("请求体带上模型、温度、上限，且不是流式", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(okBody("好")));
    await provider(fetchImpl, { temperature: 0.6, maxTokens: 2048 }).complete(USER);

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("test-model");
    expect(body["temperature"]).toBe(0.6);
    expect(body["max_tokens"]).toBe(2048);
    expect(body["stream"]).toBe(false);
    expect((body["messages"] as unknown[]).length).toBe(1);
  });

  it("单次调用可以覆盖模型与温度", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(okBody("好")));
    await provider(fetchImpl).complete(USER, { model: "另一模型", temperature: 0.1 });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("另一模型");
    expect(body["temperature"]).toBe(0.1);
  });
});

/* ── 响应解析 ─────────────────────────────────── */

describe("响应解析", () => {
  it("取出正文、模型名与用量", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(okBody("刀光一闪。", "deepseek-chat")));
    const result = await provider(fetchImpl).complete(USER);

    expect(result.text).toBe("刀光一闪。");
    expect(result.model).toBe("deepseek-chat");
    expect(result.usage?.promptTokens).toBe(100);
    expect(result.usage?.completionTokens).toBe(50);
  });

  it("没有 usage 字段时不报错", () => {
    const result = parseCompletion(
      { choices: [{ message: { content: "内容" } }] },
      "fallback",
    );
    expect(result.text).toBe("内容");
    expect(result.model).toBe("fallback");
    expect(result.usage).toBeUndefined();
  });

  it("缺少 choices 时给出可读的错误", () => {
    const error = captureErrorSync(() => parseCompletion({ error: { message: "坏掉了" } }, "m"));
    expect(error instanceof LlmError).toBe(true);
    expect((error as LlmError).message).toMatch("choices");
  });

  it("正文为空视为异常，而不是静默返回空章", () => {
    const error = captureErrorSync(() =>
      parseCompletion({ choices: [{ message: { content: "" } }] }, "m"),
    );
    expect(error instanceof LlmError).toBe(true);
  });
});

function captureErrorSync(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/* ── 错误与重试 ───────────────────────────────── */

describe("错误处理", () => {
  it("4xx 不重试，直接抛出并带上状态码", async () => {
    let attempts = 0;
    const { fetchImpl } = fakeFetch(() => {
      attempts += 1;
      return jsonResponse({ error: { message: "参数不对" } }, 400);
    });

    const error = await captureError(() => provider(fetchImpl).complete(USER));
    expect(attempts).toBe(1);
    expect(error instanceof LlmError).toBe(true);
    expect((error as LlmError).status).toBe(400);
    expect((error as LlmError).retryable).toBe(false);
  });

  it("429 会重试，成功后正常返回", async () => {
    let attempts = 0;
    const { fetchImpl } = fakeFetch((_call, index) => {
      attempts += 1;
      return index === 0
        ? jsonResponse({ error: "限流" }, 429)
        : jsonResponse(okBody("重试成功"));
    });

    const result = await provider(fetchImpl).complete(USER);
    expect(attempts).toBe(2);
    expect(result.text).toBe("重试成功");
  });

  it("重试次数用尽后抛出最后一次错误", async () => {
    let attempts = 0;
    const { fetchImpl } = fakeFetch(() => {
      attempts += 1;
      return jsonResponse({ error: "服务不可用" }, 503);
    });

    await expectRejects(() => provider(fetchImpl, { retries: 2 }).complete(USER));
    // 首次 + 2 次重试
    expect(attempts).toBe(3);
  });

  it("重试次数可配为 0", async () => {
    let attempts = 0;
    const { fetchImpl } = fakeFetch(() => {
      attempts += 1;
      return jsonResponse({ error: "服务不可用" }, 503);
    });

    await expectRejects(() => provider(fetchImpl, { retries: 0 }).complete(USER));
    expect(attempts).toBe(1);
  });

  it("超时给出可操作的提示", async () => {
    const { fetchImpl } = fakeFetch(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });

    const error = await captureError(() =>
      provider(fetchImpl, { retries: 0, timeoutMs: 5000 }).complete(USER),
    );
    expect(error instanceof LlmError).toBe(true);
    expect((error as LlmError).message).toMatch("5 秒");
  });

  it("网络故障可重试", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = await captureError(() =>
      provider(fetchImpl, { retries: 0 }).complete(USER),
    );
    expect((error as LlmError).retryable).toBe(true);
  });

  it("用户主动取消不重试", async () => {
    const controller = new AbortController();
    controller.abort();

    let attempts = 0;
    const { fetchImpl } = fakeFetch(() => {
      attempts += 1;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    await captureError(() =>
      provider(fetchImpl, { retries: 3 }).complete(USER, { signal: controller.signal }),
    );
    expect(attempts).toBe(1);
  });

  it("返回非 JSON 时报错并回显片段", async () => {
    const { fetchImpl } = fakeFetch(
      () => textResponse("<html>502 Bad Gateway</html>", 200),
    );

    const error = await captureError(() => provider(fetchImpl, { retries: 0 }).complete(USER));
    expect((error as LlmError).message).toMatch("不是合法 JSON");
    expect((error as LlmError).message).toMatch("Bad Gateway");
  });
});

/* ── MockProvider ─────────────────────────────── */

describe("MockProvider", () => {
  it("记录全部调用，便于断言", async () => {
    const mock = new MockProvider({ responses: ["一", "二"] });
    await mock.complete([{ role: "user", content: "第一次" }]);
    await mock.complete([{ role: "user", content: "第二次" }]);

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.messages[0]?.content).toBe("第一次");
  });

  it("响应列表用尽后重复最后一条", async () => {
    const mock = new MockProvider({ responses: ["只有这一条"] });
    await mock.complete([{ role: "user", content: "a" }]);
    const second = await mock.complete([{ role: "user", content: "b" }]);

    expect(second.text).toBe("只有这一条");
  });

  it("可以按调用次序注入失败", async () => {
    const mock = new MockProvider({
      responses: ["好了"],
      failures: [new LlmError("第一次失败")],
    });

    await expectRejects(() => mock.complete([{ role: "user", content: "a" }]));
    expect((await mock.complete([{ role: "user", content: "b" }])).text).toBe("好了");
  });

  it("支持按输入动态生成", async () => {
    const mock = new MockProvider({
      handler: (messages) => `收到 ${messages.length} 条`,
    });
    expect((await mock.complete([{ role: "user", content: "x" }])).text).toBe("收到 1 条");
  });
});
