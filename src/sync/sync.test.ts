import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../config/index.js";
import { MockProvider } from "../llm/mock.js";
import { loadBible, writeCollection } from "../store/bible.js";
import { writeChapterText } from "../store/chapters.js";
import { COLLECTIONS } from "../store/collections.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { captureError, expect } from "../testing/expect.js";
import { applySync, proposalPath, proposeSync, readProposal } from "./index.js";
import { writeTextFile } from "../store/file-io.js";
import { join } from "node:path";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

describe("状态回写", () => {
  it("模型只写提案；作者确认一项后才修改 Bible 和摘要", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ id: "char_lin", name: "林渊", state: { alive: true } } as never]);
    await writeChapterText(ws.paths, "ch-0001", "林渊倒在雪中。他没有死，只是左臂受伤了。");
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: [JSON.stringify({ summary: "情节：林渊受伤。\n状态变化：左臂受伤。\n伏笔：无。\n遗留：疗伤。", changes: [{ collection: "characters", id: "char_lin", field: "state.injuries", after: ["左臂受伤"], evidence: "左臂受伤了" }] })] });
    const proposal = await proposeSync({ booksRoot: ws.booksRoot, chapter: "ch-0001", config, provider });
    expect((await loadBible(ws.booksRoot)).characters[0]?.state.injuries).toHaveLength(0);
    await applySync(ws.paths, proposal, { accept: [1], acceptSummary: true });
    expect((await loadBible(ws.booksRoot)).characters[0]?.state.injuries).toHaveLength(1);
    expect(readFileSync(`${ws.paths.summariesDir}/ch-0001.md`, "utf8")).toMatch("林渊受伤");
  });

  it("正文改变后拒绝应用旧提案", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ id: "char_lin", name: "林渊" } as never]);
    await writeChapterText(ws.paths, "ch-0001", "林渊走进山谷。");
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: [JSON.stringify({ summary: "走进山谷。", changes: [] })] });
    const proposal = await proposeSync({ booksRoot: ws.booksRoot, chapter: "ch-0001", config, provider });
    await writeChapterText(ws.paths, "ch-0001", "林渊没有走进山谷。");
    const error = await captureError(() => applySync(ws.paths, proposal, { accept: [], acceptSummary: true }));
    expect(String(error)).toMatch("正文在提案生成后已改动");
  });

  it("人物状态已推进到后续章节时拒绝回写旧章节", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ id: "char_lin", name: "林渊" } as never]);
    await writeChapterText(ws.paths, "ch-0001", "林渊左臂受伤。");
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: [JSON.stringify({ summary: "林渊受伤。", changes: [{ collection: "characters", id: "char_lin", field: "state.injuries", after: ["左臂受伤"], evidence: "左臂受伤" }] })] });
    const proposal = await proposeSync({ booksRoot: ws.booksRoot, chapter: "ch-0001", config, provider });
    const character = (await loadBible(ws.booksRoot)).characters[0];
    if (character === undefined) throw new Error("测试人物缺失");
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ ...character, state: { ...character.state, asOfChapter: "ch-0002" } }]);
    const error = await captureError(() => applySync(ws.paths, proposal, { accept: [1] }));
    expect(String(error)).toMatch("较早章节");
  });

  it("中断的多文件写回可在下次读取提案时恢复", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeCollection(ws.paths, COLLECTIONS.characters, [{ id: "char_lin", name: "林渊" } as never]);
    await writeChapterText(ws.paths, "ch-0001", "林渊站起来。");
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: [JSON.stringify({ summary: "林渊站起来。", changes: [] })] });
    await proposeSync({ booksRoot: ws.booksRoot, chapter: "ch-0001", config, provider });
    const charactersFile = join(ws.paths.bibleDir, "characters.yaml");
    const original = readFileSync(charactersFile, "utf8");
    await writeTextFile(charactersFile, "characters: []\n");
    await writeTextFile(proposalPath(ws.paths, "ch-0001") + ".pending.json", JSON.stringify({ phase: "prepared", originals: { characters: original } }));
    await captureError(() => readProposal(ws.paths, "ch-0002"));
    expect(readFileSync(charactersFile, "utf8")).toBe(original);
    await readProposal(ws.paths, "ch-0001");
  });
  it("其他进程持有状态锁时，读取提案不会回滚正在进行的事务", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeChapterText(ws.paths, "ch-0001", "林渊出发。");
    const config = await loadConfig(ws.root);
    await proposeSync({ booksRoot: ws.booksRoot, chapter: "ch-0001", config, provider: new MockProvider({ responses: [JSON.stringify({ summary: "林渊出发。", changes: [] })] }) });
    const lockFile = join(ws.paths.root, ".sync.lock");
    const journal = proposalPath(ws.paths, "ch-0001") + ".pending.json";
    await writeTextFile(journal, JSON.stringify({ phase: "prepared", originals: {} }));
    await writeTextFile(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    let finished = false;
    const reading = readProposal(ws.paths, "ch-0001").then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(finished).toBe(false);
    expect(readFileSync(journal, "utf8")).toMatch("prepared");
    await import("node:fs/promises").then((fs) => fs.unlink(lockFile));
    await reading;
    expect(finished).toBe(true);
  });
  it("模型首次输出无效 JSON 时修正重试，不写入脏提案", async () => {
    const ws = await createWorkspace(); opened.push(ws);
    await writeChapterText(ws.paths, "ch-0001", "林渊出发。");
    const config = await loadConfig(ws.root);
    const provider = new MockProvider({ responses: ["这不是 JSON", JSON.stringify({ summary: "林渊出发。", changes: [] })] });
    const proposal = await proposeSync({ booksRoot: ws.booksRoot, chapter: "ch-0001", config, provider });
    expect(provider.calls).toHaveLength(2);
    expect(proposal.summary).toBe("林渊出发。");
  });
});
