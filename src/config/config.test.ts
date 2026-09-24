import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { SchemaMismatchError } from "../store/file-io.js";
import { captureError, expect, expectRejects } from "../testing/expect.js";
import { createTempDir } from "../testing/workspace.js";
import { configPath, loadConfig, writeDefaultConfig } from "./index.js";

const MANAGED_ENV = [
  "NOVEL_LLM_API_KEY",
  "NOVEL_LLM_BASE_URL",
  "NOVEL_LLM_MODEL",
  "TEST_NOVEL_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>(
  MANAGED_ENV.map((key) => [key, process.env[key]]),
);

const opened: Array<{ root: string; cleanup: () => Promise<void> }> = [];

async function tempDir(): Promise<string> {
  const dir = await createTempDir();
  opened.push(dir);
  return dir.root;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((dir) => dir.cleanup()));
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loadConfig", () => {
  it("没有配置文件时全部走默认值（零配置可用）", async () => {
    const root = await tempDir();
    const config = await loadConfig(root);

    expect(config.configExists).toBe(false);
    expect(config.llm.model).toBe("deepseek-chat");
    expect(config.llm.baseUrl).toMatch("api.deepseek.com");
    expect(config.llm.temperature).toBe(0.85);
    expect(config.budget.contextWindow).toBe(64000);
    expect(config.budget.reserveForOutput).toBe(8000);
    expect(config.budget.layers.recent).toBe(0.3);
    expect(config.generation.recentChapters).toBe(2);
    expect(config.generation.openings).toBe(3);
    expect(config.apiKey).toBeUndefined();
    expect(config.apiKeySource).toBe("未配置");
  });

  it("非法配置被拒绝并指出字段", async () => {
    const root = await tempDir();
    writeFileSync(configPath(root), "budget:\n  contextWindow: -1\n", "utf8");

    const error = await captureError(() => loadConfig(root));
    expect(error instanceof SchemaMismatchError).toBe(true);
    expect((error as SchemaMismatchError).message).toMatch("budget.contextWindow");
  });
});

describe("writeDefaultConfig", () => {
  it("生成的模板本身就是合法配置，能原样读回", async () => {
    const root = await tempDir();
    const filePath = await writeDefaultConfig(root);

    expect(existsSync(filePath)).toBe(true);

    const config = await loadConfig(root);
    expect(config.configExists).toBe(true);
    expect(config.llm.model).toBe("deepseek-chat");
    expect(config.budget.layers.recent).toBe(0.3);
    expect(config.generation.openings).toBe(3);
  });

  it("已存在时拒绝覆盖，除非显式 force", async () => {
    const root = await tempDir();
    await writeDefaultConfig(root);

    await expectRejects(() => writeDefaultConfig(root));
    await writeDefaultConfig(root, { force: true });
  });
});

describe("环境变量覆盖", () => {
  it("NOVEL_LLM_MODEL / NOVEL_LLM_BASE_URL 覆盖配置文件", async () => {
    const root = await tempDir();
    await writeDefaultConfig(root);

    process.env["NOVEL_LLM_MODEL"] = "kimi-k2";
    process.env["NOVEL_LLM_BASE_URL"] = "https://api.moonshot.cn/v1";

    const config = await loadConfig(root);
    expect(config.llm.model).toBe("kimi-k2");
    expect(config.llm.baseUrl).toBe("https://api.moonshot.cn/v1");
  });
});

describe("密钥解析", () => {
  it("从 apiKeyEnv 指定的环境变量读取", async () => {
    const root = await tempDir();
    writeFileSync(configPath(root), "llm:\n  apiKeyEnv: TEST_NOVEL_KEY\n", "utf8");
    process.env["TEST_NOVEL_KEY"] = "sk-from-named";

    const config = await loadConfig(root);
    expect(config.apiKey).toBe("sk-from-named");
    expect(config.apiKeySource).toMatch("TEST_NOVEL_KEY");
  });

  it("NOVEL_LLM_API_KEY 优先级最高", async () => {
    const root = await tempDir();
    writeFileSync(configPath(root), "llm:\n  apiKeyEnv: TEST_NOVEL_KEY\n", "utf8");
    process.env["TEST_NOVEL_KEY"] = "sk-named";
    process.env["NOVEL_LLM_API_KEY"] = "sk-direct";

    const config = await loadConfig(root);
    expect(config.apiKey).toBe("sk-direct");
  });

  it("纯空白的密钥视为未配置", async () => {
    const root = await tempDir();
    writeFileSync(configPath(root), "llm:\n  apiKeyEnv: TEST_NOVEL_KEY\n", "utf8");
    process.env["TEST_NOVEL_KEY"] = "   ";

    expect((await loadConfig(root)).apiKey).toBeUndefined();
  });

  it("密钥不进配置文件，只留环境变量名", async () => {
    const root = await tempDir();
    const filePath = await writeDefaultConfig(root);
    const text = (await import("node:fs")).readFileSync(filePath, "utf8");

    expect(text).toMatch("apiKeyEnv");
    // 模板里不应出现任何像密钥的字面量
    expect(text.includes("sk-")).toBe(false);
  });
});
