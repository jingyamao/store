import { afterEach, describe, it } from "node:test";
import { createHash } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { ChapterOutlineSchema } from "../domain/outline.js";
import { CharacterSchema, ItemSchema, LocationSchema, ThreadSchema } from "../domain/schemas.js";
import { prepareAgentMemory, projectBibleAsOf } from "../agent/memory.js";
import { loadBible, writeCollection } from "../store/bible.js";
import { writeChapterText } from "../store/chapters.js";
import { COLLECTIONS } from "../store/collections.js";
import { writeChapterOutline } from "../store/outlines.js";
import { proposalPath, SyncProposalSchema } from "../sync/index.js";
import { writeYamlFile } from "../store/file-io.js";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { loadHistorySnapshot, recordManualFact, selectHistoricalFacts } from "./history.js";

const opened: TestWorkspace[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((ws) => ws.cleanup())); });

async function workspace(): Promise<TestWorkspace> {
  const ws = await createWorkspace();
  opened.push(ws);
  await writeCollection(ws.paths, COLLECTIONS.characters, [
    CharacterSchema.parse({ id: "char_lin", name: "林渊", state: { asOfChapter: "ch-0005", realm: "筑基" },
      relationships: [{ target: "char_su", type: "宿敌", status: "已决裂", since: "ch-0005" }] }),
    CharacterSchema.parse({ id: "char_su", name: "苏晚" }),
  ]);
  await writeCollection(ws.paths, COLLECTIONS.locations, [LocationSchema.parse({ id: "loc_market", name: "集市" })]);
  await writeChapterText(ws.paths, "ch-0001", "林渊初入宗门，仍是炼气境。苏晚与他同门，相互信任。");
  await writeChapterText(ws.paths, "ch-0003", "林渊在集市见到苏晚。");
  await writeChapterOutline(ws.paths, ChapterOutlineSchema.parse({ chapter: "ch-0004", intent: "林渊与苏晚追查旧事", cast: ["char_lin", "char_su"] }));
  return ws;
}

describe("章节历史记忆", () => {
  it("过期同步提案不得进入早期上下文，已应用字段也须遮蔽", async () => {
    const ws = await workspace();
    const body = "林渊在集市见到苏晚。";
    const proposal = SyncProposalSchema.parse({
      chapter: "ch-0003", sourceHash: createHash("sha256").update(body).digest("hex"), generatedAt: "2026-01-01", summary: "物品变化",
      changes: [{ collection: "characters", id: "char_lin", field: "state.realm", before: "炼气", after: "筑基", evidence: body }], applied: [1],
    });
    await writeYamlFile(proposalPath(ws.paths, "ch-0003"), proposal);
    await writeChapterText(ws.paths, "ch-0003", "本章已重写。");
    const snapshot = await loadHistorySnapshot(ws.booksRoot);
    if (snapshot.proposals.length !== 0 || snapshot.staleProposals.length !== 1 || snapshot.warnings.length === 0) throw new Error("过期同步提案未隔离");
    const projected = projectBibleAsOf(snapshot.bible, "ch-0004", snapshot.proposals, snapshot.manual, snapshot.staleProposals);
    if (projected.bible.characters[0]?.state.realm !== undefined || projected.facts.length !== 0) throw new Error("过期同步值仍进入历史上下文");
    const later = SyncProposalSchema.parse({
      ...proposal, chapter: "ch-0005", changes: [{ ...proposal.changes[0], before: "筑基", after: "金丹" }],
    });
    const chained = projectBibleAsOf(snapshot.bible, "ch-0004", [later], [], [proposal]);
    if (chained.bible.characters[0]?.state.realm !== undefined) throw new Error("过期值从后续提案的 before 回流");
  });

  it("读取已应用同步提案时重验字段白名单与正文证据", async () => {
    const ws = await workspace();
    const body = "林渊在集市见到苏晚。";
    const proposal = SyncProposalSchema.parse({
      chapter: "ch-0003", sourceHash: createHash("sha256").update(body).digest("hex"), generatedAt: "2026-01-01", summary: "被篡改的提案",
      changes: [{ collection: "characters", id: "char_lin", field: "name", before: "林渊", after: "MALICIOUS", evidence: body }], applied: [1],
    });
    await writeYamlFile(proposalPath(ws.paths, "ch-0003"), proposal);
    let rejected = false;
    try { await loadHistorySnapshot(ws.booksRoot); } catch { rejected = true; }
    if (!rejected) throw new Error("越权字段被当作已确认同步事实");
    await writeYamlFile(proposalPath(ws.paths, "ch-0003"), { ...proposal,
      changes: [{ ...proposal.changes[0], field: "state.realm", before: "炼气", after: "筑基", evidence: "正文中不存在的证据" }],
    });
    rejected = false;
    try { await loadHistorySnapshot(ws.booksRoot); } catch { rejected = true; }
    if (!rejected) throw new Error("正文外证据被当作已确认同步事实");
  });

  it("缺少状态时点时只保留已确认的早期事实", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);
    const lin = bible.characters.find((character) => character.id === "char_lin");
    if (lin === undefined) throw new Error("人物缺失");
    delete lin.state.asOfChapter;
    lin.state.realm = "后期境界";
    lin.state.injuries = ["后期伤势"];
    const manual = await recordManualFact({ booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters", id: "char_lin", field: "state.realm", value: "炼气", evidence: "仍是炼气境" });
    const projected = projectBibleAsOf(bible, "ch-0004", [], [manual.fact]);
    const state = projected.bible.characters.find((character) => character.id === "char_lin")?.state;
    if (state?.realm !== "炼气" || state.injuries?.includes("后期伤势") || projected.warnings.length === 0) throw new Error("缺少时间锚点的后期状态泄漏");
  });

  it("未写章节和未来章节值不能作为已发生事实", async () => {
    const ws = await workspace();
    const common = { booksRoot: ws.booksRoot, collection: "characters" as const, id: "char_lin", field: "state.realm", value: "炼气", evidence: "作者确认", authorNote: true };
    let missing = false;
    try { await recordManualFact({ ...common, chapter: "ch-0099" }); } catch { missing = true; }
    if (!missing) throw new Error("未写章节被记录为既成事实");
    let future = false;
    try { await recordManualFact({ ...common, chapter: "ch-0001", field: "state.diedAt", value: "ch-0100" }); } catch { future = true; }
    if (!future) throw new Error("未来发生章号被记录在过去");
  });

  it("回写早期章节时隐藏无时间记录的后期物品、伏笔与关系状态", async () => {
    const ws = await workspace();
    const bible = await loadBible(ws.booksRoot, ws.bookId);
    const lin = bible.characters.find((character) => character.id === "char_lin");
    if (lin === undefined) throw new Error("人物缺失");
    lin.relationships = [{ target: "char_su", type: "同门", status: "后期决裂", since: "ch-0001" }];
    bible.items.push(ItemSchema.parse({ id: "item_key", name: "铜钥匙", firstAppearance: "ch-0001", condition: "后期损坏" }));
    bible.threads.push(ThreadSchema.parse({ id: "thread_001", title: "钥匙谜团", plantedAt: "ch-0001", status: "hinted" }));
    const projected = projectBibleAsOf(bible, "ch-0002", [], [], [], 3);
    if (projected.bible.characters[0]?.relationships.length !== 0) throw new Error("后期关系状态泄漏");
    if (projected.bible.items[0]?.condition !== undefined) throw new Error("后期物品状态泄漏");
    if (projected.bible.threads[0]?.status !== "open") throw new Error("后期伏笔状态泄漏");
  });
  it("补录事实必须有可靠依据，并在正文改动后失效", async () => {
    const ws = await workspace();
    const common = { booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters" as const, id: "char_lin", field: "state.realm", value: "炼气" };
    await recordManualFact({ ...common, evidence: "仍是炼气境" });
    const first = await loadHistorySnapshot(ws.booksRoot);
    if (first.manual.length !== 1) throw new Error("未装载已确认事实");
    let invalid = false;
    try { await recordManualFact({ ...common, evidence: "正文里没有这句话", force: true }); } catch { invalid = true; }
    if (!invalid) throw new Error("没有校验正文依据");
    await writeChapterText(ws.paths, "ch-0001", "第一章已重写。");
    const stale = await loadHistorySnapshot(ws.booksRoot);
    if (stale.manual.length !== 0 || stale.warnings.length === 0) throw new Error("正文改动后旧依据仍然生效");
    await recordManualFact({ ...common, evidence: "作者确认主角开局为炼气", authorNote: true, force: true });
    const author = await loadHistorySnapshot(ws.booksRoot);
    if (author.manual.length !== 1 || author.warnings.length !== 0) throw new Error("作者说明未被保留");
  });

  it("同章作者补录覆盖同步差量，后续同步变化仍按章节生效", async () => {
    const ws = await workspace();
    const manual = await recordManualFact({ booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters", id: "char_lin",
      field: "state.realm", value: "炼气", evidence: "仍是炼气境" });
    const proposal = SyncProposalSchema.parse({
      chapter: "ch-0001", sourceHash: "0".repeat(64), generatedAt: "2026-01-01", summary: "境界",
      changes: [{ collection: "characters", id: "char_lin", field: "state.realm", before: null, after: "练气", evidence: "仍是炼气境" }], applied: [1],
    });
    const selected = selectHistoricalFacts("ch-0002", [proposal], [manual.fact]);
    if (selected.facts[0]?.value !== "炼气" || selected.warnings.length !== 1) throw new Error("同章手工优先级错误");
    const later = SyncProposalSchema.parse({
      ...proposal, chapter: "ch-0003", changes: [{ ...proposal.changes[0], before: "炼气", after: "炼气后期" }],
    });
    const future = selectHistoricalFacts("ch-0003", [proposal, later], [manual.fact]);
    if (future.facts[0]?.value !== "炼气") throw new Error("提前读取未来变化");
    const after = selectHistoricalFacts("ch-0004", [proposal, later], [manual.fact]);
    if (after.facts[0]?.value !== "炼气后期") throw new Error("后续同步变化未生效");
  });

  it("早期人物关系与状态进入 Agent 上下文，后期状态不会泄漏", async () => {
    const ws = await workspace();
    await recordManualFact({ booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters", id: "char_lin",
      field: "state.realm", value: "炼气", evidence: "仍是炼气境" });
    await recordManualFact({ booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters", id: "char_lin",
      field: "relationships", value: [{ target: "char_su", type: "同门", status: "相互信任" }], evidence: "相互信任" });
    const bible = await loadBible(ws.booksRoot, ws.bookId);
    const snapshot = await loadHistorySnapshot(ws.booksRoot);
    const projected = projectBibleAsOf(bible, "ch-0004", [], snapshot.manual);
    const lin = projected.bible.characters.find((character) => character.id === "char_lin");
    if (lin?.state.realm !== "炼气" || lin.relationships[0]?.status !== "相互信任") throw new Error("历史状态或关系未回溯");
    if (lin.relationships.some((relation) => relation.status === "已决裂")) throw new Error("后期关系泄漏");
    const config = await loadConfig(ws.root);
    const memory = await prepareAgentMemory({ booksRoot: ws.booksRoot, chapterId: "ch-0004", config });
    const sources = memory.pack.layers.flatMap((layer) => layer.items.map((item) => item.source));
    if (!sources.some((source) => source.includes("memory/ch-0001.yaml#characters:char_lin:relationships"))) throw new Error("关系记录缺少来源");
    if (memory.facts.length < 2) throw new Error("作者事实未被记录到 Agent 审计信息");
    if (memory.pack.layers.flatMap((layer) => layer.items.map((item) => item.text)).join("\n").includes("已决裂")) throw new Error("未来关系进入提示词");
  });

  it("拒绝任意字段和重复记录，允许明确替换", async () => {
    const ws = await workspace();
    const options = { booksRoot: ws.booksRoot, chapter: "ch-0001", collection: "characters" as const, id: "char_lin", evidence: "仍是炼气境" };
    let invalid = false;
    try { await recordManualFact({ ...options, field: "personality", value: ["崩坏"] }); } catch { invalid = true; }
    if (!invalid) throw new Error("未拒绝非历史字段");
    await recordManualFact({ ...options, field: "state.realm", value: "炼气" });
    let duplicate = false;
    try { await recordManualFact({ ...options, field: "state.realm", value: "炼气后期" }); } catch { duplicate = true; }
    if (!duplicate) throw new Error("重复记录未拒绝");
    await recordManualFact({ ...options, field: "state.realm", value: "炼气后期", force: true });
    const snapshot = await loadHistorySnapshot(ws.booksRoot);
    if (snapshot.manual.length !== 1 || snapshot.manual[0]?.value !== "炼气后期") throw new Error("强制替换失败");
  });
});
