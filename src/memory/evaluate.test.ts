import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { CharacterSchema } from "../domain/schemas.js";
import { writeCollection } from "../store/bible.js";
import { writeChapterText } from "../store/chapters.js";
import { COLLECTIONS } from "../store/collections.js";
import { writeYamlFile } from "../store/file-io.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { recordManualFact } from "./history.js";
import { evaluateMemory } from "./evaluate.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

async function fixture(): Promise<TestWorkspace> {
  const ws = await createWorkspace();
  opened.push(ws);
  await writeCollection(ws.paths, COLLECTIONS.characters, [CharacterSchema.parse({
    id: "char_lin", name: "林渊", state: { asOfChapter: "ch-0003", realm: "筑基" },
  })]);
  await writeChapterText(ws.paths, "ch-0001", "林渊仍是炼气境。");
  await writeChapterText(ws.paths, "ch-0003", "林渊升入筑基。");
  await recordManualFact({ booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters", id: "char_lin",
    field: "state.realm", value: "炼气", evidence: "仍是炼气境" });
  await recordManualFact({ booksRoot: ws.booksRoot, chapter: "ch-0003", collection: "characters", id: "char_lin",
    field: "state.realm", value: "筑基", evidence: "升入筑基" });
  return ws;
}

describe("历史记忆离线评测", () => {
  it("逐题检查章节时点、未知值和来源，并汇总可重复的准确率", async () => {
    const ws = await fixture();
    const datasetPath = join(ws.root, "eval.yaml");
    const base = { collection: "characters", entity: "char_lin", field: "state.realm" };
    await writeYamlFile(datasetPath, { version: 1, cases: [
      { id: "early", chapter: "ch-0002", ...base, expected: "炼气", source: "memory/ch-0001.yaml#characters:char_lin:state.realm" },
      { id: "late", chapter: "ch-0004", ...base, expected: "筑基", source: "memory/ch-0003.yaml#characters:char_lin:state.realm" },
      { id: "unknown", chapter: "ch-0002", ...base, field: "state.location", expected: null, source: null },
      { id: "wrong-value", chapter: "ch-0004", ...base, expected: "炼气" },
      { id: "wrong-source", chapter: "ch-0002", ...base, expected: "炼气", source: "memory/ch-0003.yaml#characters:char_lin:state.realm" },
    ] });
    const report = await evaluateMemory({ booksRoot: ws.booksRoot, datasetPath });
    if (report.total !== 5 || report.passed !== 3 || report.failed !== 2 || report.accuracy !== 0.6) throw new Error("评测汇总不正确");
    if (!report.results[0]?.pass || report.results[0].source?.includes("ch-0003")) throw new Error("早期事实或出处不正确");
    if (report.results[2]?.actual !== null || !report.results[2].pass) throw new Error("未知字段没有作为 null 评测");
    if (report.results[3]?.valuePass !== false || report.results[4]?.sourcePass !== false) throw new Error("未区分值与出处错误");
    const cli = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
    const failed = spawnSync(process.execPath, ["--import", "tsx", cli, "-C", ws.root, "--json", "memory", "evaluate", datasetPath], { encoding: "utf8" });
    if (failed.status !== 1 || JSON.parse(failed.stdout).failed !== 2) throw new Error(`CLI 未返回失败题目的退出码或报告：${failed.stderr}`);
    await writeYamlFile(datasetPath, { version: 1, cases: [
      { id: "early", chapter: "ch-0002", ...base, expected: "炼气" },
    ] });
    const passed = spawnSync(process.execPath, ["--import", "tsx", cli, "-C", ws.root, "--json", "memory", "evaluate", datasetPath], { encoding: "utf8" });
    if (passed.status !== 0 || JSON.parse(passed.stdout).passed !== 1) throw new Error(`CLI 未返回通过题目的退出码或报告：${passed.stderr}`);
    const unsafe = spawnSync(process.execPath, ["--import", "tsx", cli, "-C", ws.root, "memory", "evaluate", datasetPath, "--output", datasetPath], { encoding: "utf8" });
    if (unsafe.status !== 1 || !readFileSync(datasetPath, "utf8").includes("version: 1")) throw new Error("报告覆盖了题目集");
    const bookOverwrite = spawnSync(process.execPath, ["--import", "tsx", cli, "-C", ws.root, "memory", "evaluate", datasetPath, "--output", ws.paths.bookFile, "--force"], { encoding: "utf8" });
    if (bookOverwrite.status !== 1 || !readFileSync(ws.paths.bookFile, "utf8").includes("测试书")) throw new Error("报告覆盖了书籍资料");
    const output = join(ws.root, "report.json");
    const saved = spawnSync(process.execPath, ["--import", "tsx", cli, "-C", ws.root, "memory", "evaluate", datasetPath, "--output", output], { encoding: "utf8" });
    if (saved.status !== 0 || !existsSync(output)) throw new Error(`安全报告路径未写入：${saved.stderr}`);
    const noForce = spawnSync(process.execPath, ["--import", "tsx", cli, "-C", ws.root, "memory", "evaluate", datasetPath, "--output", output], { encoding: "utf8" });
    if (noForce.status !== 1) throw new Error("已有报告被无提示覆盖");
  });

  it("拒绝重复题号、缺少预期值和任意字段", async () => {
    const ws = await fixture();
    const datasetPath = join(ws.root, "invalid.yaml");
    const one = { id: "same", chapter: "ch-0002", collection: "characters", entity: "char_lin", field: "state.realm", expected: "炼气" };
    for (const cases of [
      [one, one],
      [{ id: "missing", chapter: "ch-0002", collection: "characters", entity: "char_lin", field: "state.realm" }],
      [{ ...one, field: "name" }],
      [{ ...one, expected: true }],
    ]) {
      await writeYamlFile(datasetPath, { version: 1, cases });
      let failed = false;
      try { await evaluateMemory({ booksRoot: ws.booksRoot, datasetPath }); } catch { failed = true; }
      if (!failed) throw new Error("无效题目集被接受");
    }
  });
});
