/**
 * 极小的 expect 垫片 —— 让测试代码可以用 Vitest/Jest 风格的断言，
 * 但跑在 Node 内置的测试运行器上（零原生依赖，零额外依赖树）。
 *
 * 只实现本项目实际用到的断言。非取反路径一律直接调 node:assert，
 * 这样失败信息仍然由 assert 提供，不会因为垫片而变差。
 */

import assert from "node:assert/strict";

interface Matchers {
  readonly not: Matchers;
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

/** 断言失败时用来描述实际值 / 期望值。 */
function fmt(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof RegExp) return String(value);
  if (typeof value === "function") return "[function]";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function didThrow(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** 复制正则再 test，避免 /g 状态下 lastIndex 被推进导致第二次判断翻转。 */
function matches(text: string, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags.replace(/g/g, "")).test(text);
}

function deepEquals(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function createMatchers(actual: unknown, negated: boolean): Matchers {
  /** 取反时统一走这里；不取反时交给传入的 assert 以获得更好的报错。 */
  const expectFalse = (pass: boolean, message: string): void => {
    if (negated) assert.ok(!pass, message);
  };

  const matchers: Matchers = {
    get not(): Matchers {
      return createMatchers(actual, !negated);
    },

    toBe: (expected) => {
      expectFalse(Object.is(actual, expected), `期望不等于 ${fmt(expected)}，但相等`);
      if (!negated) assert.strictEqual(actual, expected);
    },

    toEqual: (expected) => {
      expectFalse(deepEquals(actual, expected), `期望不深等于 ${fmt(expected)}，但相等`);
      if (!negated) assert.deepStrictEqual(actual, expected);
    },

    toThrow: () => {
      assert.strictEqual(
        typeof actual,
        "function",
        "toThrow 需要一个函数，例如 expect(() => parse(...)).toThrow()",
      );
      const threw = didThrow(actual as () => unknown);
      if (negated) {
        assert.ok(!threw, "期望不抛出异常，但抛了");
      } else {
        assert.ok(threw, "期望抛出异常，但没有");
      }
    },

    toMatch: (expected) => {
      const text = String(actual);
      const pass =
        expected instanceof RegExp ? matches(text, expected) : text.includes(expected);

      if (negated) {
        assert.ok(!pass, `期望不匹配 ${fmt(expected)}，实际为 ${fmt(text)}`);
        return;
      }
      if (expected instanceof RegExp) {
        assert.match(text, expected);
      } else {
        assert.ok(
          pass,
          `期望包含 ${JSON.stringify(expected)}，实际为 ${JSON.stringify(text)}`,
        );
      }
    },

    toContain: (expected) => {
      assert.ok(
        Array.isArray(actual) || typeof actual === "string",
        "toContain 需要数组或字符串",
      );
      const pass = (actual as readonly unknown[]).includes(expected as never);

      if (negated) {
        assert.ok(!pass, `期望不包含 ${fmt(expected)}，实际为 ${fmt(actual)}`);
      } else {
        assert.ok(pass, `期望包含 ${fmt(expected)}，实际为 ${fmt(actual)}`);
      }
    },

    toHaveLength: (expected) => {
      const length = (actual as { length: number }).length;
      if (negated) {
        assert.notStrictEqual(length, expected, `期望长度不为 ${expected}`);
      } else {
        assert.strictEqual(length, expected);
      }
    },

    toBeTruthy: () => {
      if (negated) assert.ok(!actual, `期望为假值，实际为 ${fmt(actual)}`);
      else assert.ok(actual, `期望为真值，实际为 ${fmt(actual)}`);
    },

    toBeFalsy: () => {
      if (negated) assert.ok(actual, `期望为真值，实际为 ${fmt(actual)}`);
      else assert.ok(!actual, `期望为假值，实际为 ${fmt(actual)}`);
    },

    toBeDefined: () => {
      if (negated) assert.strictEqual(actual, undefined);
      else assert.ok(actual !== undefined, "期望有值，实际为 undefined");
    },

    toBeUndefined: () => {
      if (negated) assert.notStrictEqual(actual, undefined, "期望不是 undefined");
      else assert.strictEqual(actual, undefined);
    },

    toBeNull: () => {
      if (negated) assert.notStrictEqual(actual, null, "期望不是 null");
      else assert.strictEqual(actual, null);
    },

    toBeGreaterThan: (expected) => {
      if (negated) assert.ok(!((actual as number) > expected), `期望不大于 ${expected}`);
      else assert.ok((actual as number) > expected, `期望大于 ${expected}，实际为 ${fmt(actual)}`);
    },

    toBeGreaterThanOrEqual: (expected) => {
      if (negated) assert.ok(!((actual as number) >= expected), `期望小于 ${expected}`);
      else assert.ok((actual as number) >= expected, `期望不小于 ${expected}，实际为 ${fmt(actual)}`);
    },

    toBeLessThan: (expected) => {
      if (negated) assert.ok(!((actual as number) < expected), `期望不小于 ${expected}`);
      else assert.ok((actual as number) < expected, `期望小于 ${expected}，实际为 ${fmt(actual)}`);
    },

    toBeLessThanOrEqual: (expected) => {
      if (negated) assert.ok(!((actual as number) <= expected), `期望大于 ${expected}`);
      else assert.ok((actual as number) <= expected, `期望不大于 ${expected}，实际为 ${fmt(actual)}`);
    },
  };

  return matchers;
}

export function expect(actual: unknown): Matchers {
  return createMatchers(actual, false);
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
