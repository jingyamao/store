/**
 * 极小的 expect 垫片 —— 让测试代码可以用 Vitest/Jest 风格的断言，
 * 但跑在 Node 内置的测试运行器上（零原生依赖，零额外依赖树）。
 *
 * 只实现本项目实际用到的断言。失败信息由 node:assert 提供，已经足够清晰。
 */

import assert from "node:assert/strict";

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toThrow(): void;
  toMatch(expected: string | RegExp): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
}

export function expect(actual: unknown): Matchers {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),

    toThrow: () => {
      assert.strictEqual(
        typeof actual,
        "function",
        "toThrow 需要一个函数，例如 expect(() => parse(...)).toThrow()",
      );
      assert.throws(actual as () => unknown);
    },

    toMatch: (expected) => {
      if (expected instanceof RegExp) {
        assert.match(String(actual), expected);
      } else {
        assert.ok(
          String(actual).includes(expected),
          `期望包含 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(String(actual))}`,
        );
      }
    },

    toContain: (expected) => {
      assert.ok(
        Array.isArray(actual) || typeof actual === "string",
        "toContain 需要数组或字符串",
      );
      assert.ok(
        (actual as readonly unknown[]).includes(expected as never),
        `期望包含 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(actual)}`,
      );
    },

    toHaveLength: (expected) => {
      assert.strictEqual((actual as { length: number }).length, expected);
    },

    toBeTruthy: () => assert.ok(actual),
    toBeFalsy: () => assert.ok(!actual),
    toBeDefined: () =>
      assert.ok(actual !== undefined, `期望有值，实际为 undefined`),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeGreaterThan: (expected) => assert.ok((actual as number) > expected),
    toBeGreaterThanOrEqual: (expected) => assert.ok((actual as number) >= expected),
    toBeLessThan: (expected) => assert.ok((actual as number) < expected),
    toBeLessThanOrEqual: (expected) => assert.ok((actual as number) <= expected),
  };
}

/** 断言一个异步操作会失败。 */
export async function expectRejects(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn);
}

/**
 * 捕获并返回抛出的错误，没抛就返回 undefined。
 *
 * 比 try/catch 加 `throw new Error("本应抛出")` 更不容易写错 ——
 * 后者抛出的哨兵错误会被自己的 catch 抓住，导致测试假通过。
 */
export async function captureError(fn: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
