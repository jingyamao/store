import { describe, it } from "node:test";
import { expect } from "../testing/expect.js";
import {
  deleteByPath,
  getByPath,
  parsePath,
  parseScalar,
  setByPath,
} from "./dotted-path.js";

describe("parsePath", () => {
  it("按点与下标拆分", () => {
    expect(parsePath("state.realm")).toEqual(["state", "realm"]);
    expect(parsePath("aliases[0]")).toEqual(["aliases", "0"]);
    expect(parsePath("relationships.0.target")).toEqual(["relationships", "0", "target"]);
    expect(parsePath("a.b[2].c[0]")).toEqual(["a", "b", "2", "c", "0"]);
  });

  it("忽略空段", () => {
    expect(parsePath("a..b")).toEqual(["a", "b"]);
    expect(parsePath("")).toEqual([]);
  });
});

describe("parseScalar", () => {
  it("解析 JSON 标量", () => {
    expect(parseScalar("123")).toBe(123);
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("false")).toBe(false);
    expect(parseScalar("null")).toBeNull();
    expect(parseScalar('["a","b"]')).toEqual(["a", "b"]);
  });

  it("普通中文字符串原样返回", () => {
    expect(parseScalar("筑基后期")).toBe("筑基后期");
    expect(parseScalar("林渊")).toBe("林渊");
  });

  it("空串返回空字符串而不是抛错", () => {
    expect(parseScalar("")).toBe("");
  });
});

describe("setByPath", () => {
  it("写入已存在的字段", () => {
    const target: Record<string, unknown> = { state: { realm: "筑基" } };
    setByPath(target, "state.realm", "金丹");
    expect(getByPath(target, "state.realm")).toBe("金丹");
  });

  it("自动创建缺失的中间对象", () => {
    const target: Record<string, unknown> = {};
    setByPath(target, "state.realm", "筑基后期");
    expect(target).toEqual({ state: { realm: "筑基后期" } });
  });

  it("数字段自动创建数组", () => {
    const target: Record<string, unknown> = {};
    setByPath(target, "aliases[0]", "渊哥");
    expect(target).toEqual({ aliases: ["渊哥"] });
  });

  it("写入数组元素内的字段", () => {
    const target: Record<string, unknown> = { relationships: [{ target: "char_a" }] };
    setByPath(target, "relationships[0].type", "宿敌");
    expect(getByPath(target, "relationships[0].type")).toBe("宿敌");
  });
});

describe("getByPath", () => {
  it("取不到时返回 undefined 而不抛错", () => {
    expect(getByPath({}, "a.b.c")).toBeUndefined();
    expect(getByPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getByPath(null, "a")).toBeUndefined();
  });
});

describe("deleteByPath", () => {
  it("删除对象字段", () => {
    const target: Record<string, unknown> = { state: { realm: "筑基", location: "loc_a" } };
    expect(deleteByPath(target, "state.realm")).toBe(true);
    expect(target).toEqual({ state: { location: "loc_a" } });
  });

  it("删除数组元素并收缩数组", () => {
    const target: Record<string, unknown> = { aliases: ["a", "b", "c"] };
    expect(deleteByPath(target, "aliases[1]")).toBe(true);
    expect(target).toEqual({ aliases: ["a", "c"] });
  });

  it("路径不存在时返回 false", () => {
    expect(deleteByPath({ a: 1 }, "b")).toBe(false);
    expect(deleteByPath({ a: 1 }, "a.b.c")).toBe(false);
  });
});
