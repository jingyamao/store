/**
 * dotted path 读写工具 —— 支撑 `novel set char_xxx state.realm 筑基后期` 这类命令。
 *
 * 支持语法：
 *   state.realm
 *   aliases[0]
 *   relationships.0.target
 */

/** 把 `a.b[0].c` 拆成 ['a','b','0','c']。 */
export function parsePath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** 把命令行的字符串解析成合适的 JS 值。解析不出来就当字符串。 */
export function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
}

export function getByPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of parsePath(path)) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 就地写入 dotted path，缺失的中间层自动创建（数字段创建数组）。
 *
 * @returns 被写入的值
 */
export function setByPath(root: Record<string, unknown>, path: string, value: unknown): unknown {
  const segments = parsePath(path);
  const first = segments[0];
  if (first === undefined) throw new Error(`非法路径: ${path}`);

  let cursor: Record<string, unknown> | unknown[] = root;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    if (segment === undefined || nextSegment === undefined) break;

    const wantsArray = /^\d+$/.test(nextSegment);

    if (Array.isArray(cursor)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) throw new Error(`路径 ${path} 中期望数组下标，得到 "${segment}"`);
      const existing: unknown = cursor[index];
      if (!isPlainObject(existing) && !Array.isArray(existing)) {
        cursor[index] = wantsArray ? [] : {};
      }
      cursor = cursor[index] as Record<string, unknown> | unknown[];
    } else {
      const existing = cursor[segment];
      if (!isPlainObject(existing) && !Array.isArray(existing)) {
        cursor[segment] = wantsArray ? [] : {};
      }
      cursor = cursor[segment] as Record<string, unknown> | unknown[];
    }
  }

  const last = segments[segments.length - 1];
  if (last === undefined) throw new Error(`非法路径: ${path}`);

  if (Array.isArray(cursor)) {
    const index = Number.parseInt(last, 10);
    if (!Number.isInteger(index)) throw new Error(`路径 ${path} 中期望数组下标，得到 "${last}"`);
    cursor[index] = value;
  } else {
    cursor[last] = value;
  }

  return value;
}

/** 就地删除 dotted path。 */
export function deleteByPath(root: Record<string, unknown>, path: string): boolean {
  const segments = parsePath(path);
  if (segments.length === 0) return false;

  let cursor: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment === undefined) return false;
    if (Array.isArray(cursor)) {
      cursor = cursor[Number.parseInt(segment, 10)];
    } else if (isPlainObject(cursor)) {
      cursor = cursor[segment];
    } else {
      return false;
    }
  }

  const last = segments[segments.length - 1];
  if (last === undefined) return false;

  if (Array.isArray(cursor)) {
    const index = Number.parseInt(last, 10);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return false;
    cursor.splice(index, 1);
    return true;
  }
  if (isPlainObject(cursor) && last in cursor) {
    delete cursor[last];
    return true;
  }
  return false;
}
