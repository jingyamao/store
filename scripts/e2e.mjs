#!/usr/bin/env node
/**
 * 端到端验证：init → 填充 Bible → lint → status → 删除 → 悬空引用检查。
 *
 * 用 Node 而不是 shell 脚本编写，理由：
 *   · 无编码问题（Windows PowerShell 5.1 读 .ps1 默认按 GBK，中文会乱码）
 *   · 无 shell 引号/数组展开差异
 *   · 可以直接断言退出码与输出内容
 *
 * 用法：node scripts/e2e.mjs
 * 前提：npm run build
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRATCH = join(ROOT, ".scratch-e2e");
const CLI = join(ROOT, "dist", "cli", "index.js");
const BOOK = join(SCRATCH, "books", "demo");

let failures = 0;

function section(title) {
  process.stdout.write(`\n${"=".repeat(64)}\n  ${title}\n${"=".repeat(64)}\n`);
}

function check(condition, message) {
  if (condition) {
    process.stdout.write(`  \u2713 ${message}\n`);
  } else {
    failures += 1;
    process.stderr.write(`  \u2717 ${message}\n`);
  }
}

/** 跑一条 novel 命令，回显输出并断言退出码。 */
function novel(args, expectedExit = 0, options = {}) {
  const result = spawnSync(process.execPath, [CLI, "--dir", SCRATCH, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (options.echo !== false) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  const status = result.status ?? 1;
  if (status !== expectedExit) {
    failures += 1;
    process.stderr.write(
      `\n  \u2717 期望退出码 ${expectedExit}，实际 ${status}：novel ${args.join(" ")}\n`,
    );
  }
  return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 只要输出、不回显，用于 --json 这类输出很长的命令。 */
function novelJson(args, expectedExit = 0) {
  const result = novel(args, expectedExit, { echo: false });
  return JSON.parse(result.stdout);
}

const write = (path, content) => writeFileSync(path, content, "utf8");
const read = (path) => readFileSync(path, "utf8");

/* ─────────────────────────────────────────────── */

rmSync(SCRATCH, { recursive: true, force: true });

section("1. novel init");
novel([
  "init",
  "demo",
  "-t",
  "剑起微尘",
  "-g",
  "玄幻",
  "仙侠",
  "-p",
  "第三人称有限",
  "-l",
  "一个被逐出宗门的小人物，靠一把有裂痕的刀重新爬上来。",
]);
check(existsSync(join(BOOK, "book.yaml")), "book.yaml 已创建");
check(existsSync(join(BOOK, "style.md")), "style.md 已创建");
check(existsSync(join(BOOK, "bible", "threads.yaml")), "bible/threads.yaml 已创建");

section("2. 用 CLI 填充 Bible");
for (const args of [
  ["char", "add", "char_linyuan", "--name", "林渊"],
  ["char", "add", "char_suwan", "--name", "苏晚"],
  ["char", "add", "char_zhaoqian", "--name", "赵乾"],
  ["item", "add", "item_duanyue", "--name", "断岳刀"],
  ["loc", "add", "loc_qingyunzong", "--name", "青云宗"],
  ["loc", "add", "loc_luoxiagu", "--name", "落霞谷"],
  ["thread", "add", "thread_001", "--title", "断岳刀的裂痕"],
  ["setting", "add", "setting_001", "--statement", "灵力无法在无月之夜恢复"],
]) {
  novel(args);
}
check(read(join(BOOK, "bible", "characters.yaml")).includes("林渊"), "人物已写入 YAML");

section("3. 用 set 修改字段（含数组与嵌套路径）");
for (const args of [
  ["char", "set", "char_linyuan", "role", "protagonist"],
  ["char", "set", "char_linyuan", "aliases", '["渊哥"]'],
  ["char", "set", "char_linyuan", "personality", '["表面散漫，实际记仇"]'],
  ["char", "set", "char_linyuan", "state.realm", "筑基后期"],
  ["char", "set", "char_linyuan", "state.location", "loc_luoxiagu"],
  ["char", "set", "char_linyuan", "state.possession", '["item_duanyue"]'],
  ["char", "set", "char_linyuan", "firstAppearance", "ch-0001"],
  ["char", "set", "char_linyuan", "speechStyle.patterns", '["啧","有意思"]'],
  ["char", "set", "char_suwan", "firstAppearance", "ch-0002"],
  ["char", "set", "char_suwan", "role", "deuteragonist"],
  ["char", "set", "char_suwan", "personality", '["外冷内热"]'],
  ["char", "set", "char_suwan", "speechStyle.patterns", '["师兄"]'],
  ["char", "set", "char_suwan", "state.realm", "炼气九层"],
  ["char", "set", "char_suwan", "state.asOfChapter", "ch-0002"],
  ["char", "set", "char_zhaoqian", "personality", '["贪婪，怕死"]'],
  ["char", "set", "char_zhaoqian", "firstAppearance", "ch-0002"],
  ["char", "set", "char_zhaoqian", "state.asOfChapter", "ch-0002"],
  ["char", "set", "char_linyuan", "state.asOfChapter", "ch-0002"],
  ["item", "set", "item_duanyue", "firstAppearance", "ch-0001"],
  ["loc", "set", "loc_luoxiagu", "parent", "loc_qingyunzong"],
  ["thread", "set", "thread_001", "plantedAt", "ch-0001"],
  ["thread", "set", "thread_001", "related", '["char_linyuan","item_duanyue"]'],
  ["setting", "set", "setting_001", "establishedAt", "ch-0001"],
]) {
  novel(args);
}
check(
  read(join(BOOK, "bible", "characters.yaml")).includes("筑基后期"),
  "嵌套路径 state.realm 已写入",
);
check(
  read(join(BOOK, "bible", "characters.yaml")).includes("渊哥"),
  "数组字段 aliases 已写入",
);

section("4. 手写 YAML 也是头等公民（境界体系 / 章节正文 / 文风锚定）");
write(
  join(BOOK, "bible", "power_system.yaml"),
  [
    "realms:",
    "  - name: 炼气",
    "    levels: 9",
    "  - name: 筑基",
    "    levels: 3",
    "  - name: 金丹",
    "    levels: 1",
    "rules:",
    "  - 越级战斗上限为一个大境界",
    "",
  ].join("\n"),
);
write(
  join(BOOK, "chapters", "ch-0001.md"),
  "林渊把断岳刀插进石缝里。刀身那道裂痕，又深了一分。\n",
);
write(
  join(BOOK, "chapters", "ch-0002.md"),
  "苏晚站在谷口。林渊抬头看了她一眼。赵乾跟在后面，脸色不太好看。\n",
);
write(
  join(BOOK, "style.md"),
  [
    "# 文风锚定",
    "",
    "## 一、整体基调",
    "冷硬克制，情绪不直说，靠动作与环境反衬。战斗描写偏短句、重节奏。",
    "",
    "## 二、叙述人称与视角",
    "第三人称有限，始终跟随主角，不进入他人内心。",
    "",
    "## 三、句式偏好",
    "- 句长：以 15–25 字为主，紧张处压到 8 字以内",
    "- 忌用：不用“仿佛”“不禁”“这一刻”",
    "",
    "## 四、对白风格",
    "口语化，少用敬语；主角说话带刺；反派不解释动机。",
    "",
    "## 五、正面范例",
    "刀锋擦过耳侧，带起一线血珠。",
    "他没躲。不是来不及，是不想躲。",
    "",
    "## 七、自定义 AI 味黑名单",
    "```",
    "仿佛",
    "不禁",
    "这一刻",
    "嘴角勾起",
    "```",
    "",
  ].join("\n"),
);
write(
  join(BOOK, "outline", "master.md"),
  [
    "# 全书总纲",
    "",
    "## 一句话简介",
    "一个被逐出宗门的小人物，靠一把有裂痕的刀重新爬上来。",
    "",
    "## 核心冲突",
    "林渊要在宗门倾轧与自身旧伤的夹缝中查清父母死因。",
    "",
    "## 主线脉络",
    "1. 被逐出宗门，流落落霞谷",
    "2. 从残卷中习得失传刀法",
    "3. 重返青云宗，揭开旧案",
    "",
  ].join("\n"),
);
novel(["status", "--no-lint"]);

section("5. 第一次 lint（配置完整，应当干净，退出码 0）");
const clean = novel(["lint", "--strict"]);
check(clean.status === 0, "--strict 下退出码为 0");
check(clean.stdout.includes("全部通过"), "输出包含「全部通过」");

section("6. 制造三类典型错误，验证 lint 能抓住");
process.stdout.write("  → 境界写成体系外的「大罗金仙」\n");
novel(["char", "set", "char_suwan", "state.realm", "大罗金仙"]);
process.stdout.write("  → 专名冲突：给赵乾起别名「林渊」\n");
novel(["char", "set", "char_zhaoqian", "aliases", '["林渊"]']);
process.stdout.write("  → 关系指向不存在的人物\n");
novel([
  "char",
  "set",
  "char_linyuan",
  "relationships",
  '[{"target":"char_ghost","type":"宿敌"}]',
]);

section("7. 第二次 lint（应当报错，退出码 1）");
const dirty = novel(["lint"], 1);
check(dirty.status === 1, "退出码为 1");
check(dirty.stdout.includes("realm-validity"), "报出 realm-validity");
check(dirty.stdout.includes("alias-conflict"), "报出 alias-conflict");
check(dirty.stdout.includes("dangling-reference"), "报出 dangling-reference");

section("8. 单规则排查 + JSON 输出");
// 此时境界错误仍在，退出码应当是 1
const json = novel(["--json", "lint", "--rule", "realm-validity"], 1);
const parsed = JSON.parse(json.stdout);
check(parsed.findings.length === 1, "JSON 输出恰好 1 条发现");
check(parsed.summary.error === 1, "JSON summary 记为 1 个 error");

section("9. status 仪表盘");
novel(["status"]);

section("10. 删除物品，应当提示悬空引用");
const removed = novel(["item", "rm", "item_duanyue"]);
check(removed.stdout.includes("悬空"), "删除时主动提示悬空引用");

section("11. 删除后 lint 应报出悬空引用");
const dangling = novel(["lint", "--rule", "dangling-reference"], 1);
check(dangling.status === 1, "退出码为 1");
check(dangling.stdout.includes("item_duanyue"), "指出是 item_duanyue 悬空");

section("12. 列表 / 详情 / 自动回收伏笔");
novel(["char", "list"]);
novel(["thread", "list"]);
novel(["char", "show", "char_linyuan"]);
const resolved = novel(["thread", "resolve", "thread_001", "--at", "ch-0002"]);
check(resolved.status === 0, "thread resolve 成功");
check(
  read(join(BOOK, "bible", "threads.yaml")).includes("resolvedAt: ch-0002"),
  "伏笔已标记回收于 ch-0002",
);

section("13. 修好所有问题后应当重新干净");
novel(["char", "set", "char_suwan", "state.realm", "炼气九层"]);
novel(["char", "set", "char_zhaoqian", "aliases", "[]"]);
novel(["char", "set", "char_linyuan", "relationships", "[]"]);
// 第 10 节删掉的物品要补回来，两处悬空引用随之复原
novel(["item", "add", "item_duanyue", "--name", "断岳刀"]);
const final = novel(["lint", "--strict"]);
check(final.status === 0, "全部修复后 --strict 退出码为 0");
check(final.stdout.includes("全部通过"), "输出包含「全部通过」");

/* ─────────────── M2：单章生成闭环 ─────────────── */

section("14. novel config init / show");
novel(["config", "init"], 0, { echo: false });
const cfg = novel(["config", "show"]);
check(cfg.stdout.includes("未配置"), "没设密钥时明确显示「未配置」");
check(cfg.stdout.includes("文风锚定"), "上下文预算分层表已渲染");

section("15. 章节细纲（novel plan）");
novel(["plan", "new", "ch-0001", "-t", "逐出宗门"]);
// 逗号列表不需要引号 —— Windows PowerShell 也就吃不掉它
novel(["plan", "set", "ch-0001", "cast", "char_linyuan,char_suwan"]);
novel(["plan", "set", "ch-0001", "intent", "先铺垫，再爆发，最后收束"]);
novel(["plan", "set", "ch-0001", "mustInclude", "断岳刀第一次出现"]);
const planList = novel(["plan", "list"]);
check(planList.stdout.includes("ch-0001"), "细纲已登记");
check(
  read(join(BOOK, "outline", "chapters", "ch-0001.yaml")).includes("先铺垫，再爆发，最后收束"),
  "含逗号的普通文本没有被切成数组",
);

section("16. 拼错的字段名必须报错，而不是静默成功");
const typo = novel(["plan", "set", "ch-0001", "casts", "x"], 1);
check(typo.stderr.includes("拼错"), "指出多半是名字拼错了");

section("17. novel write --dry-run（不需要 API Key）");
const dry = novelJson(["--json", "write", "ch-0001", "--dry-run"]);
check(dry.record.dryRun === true, "记录标记为 dry-run");
check(dry.draft === null, "dry-run 不产生初稿");
check(existsSync(join(dry.runDir, "context.json")), "上下文已落盘");
check(!existsSync(join(dry.runDir, "prompt.txt")), "dry-run 不写提示词");

section("18. Context Pack 分层与预算");
const pack = JSON.parse(read(join(dry.runDir, "context.json")));
check(pack.layers.length === 6, "六个层都在");
check(
  pack.layers.every((layer) => layer.usedTokens <= layer.budgetTokens),
  "每一层都没有超出预算",
);
check(
  pack.layers.some((layer) =>
    layer.items.some((item) => item.source.includes("char_linyuan")),
  ),
  "细纲里的人物进了实体层",
);
check(
  pack.layers.some((layer) => layer.items.some((item) => item.source === "style.md")),
  "文风锚定进了文风层",
);

section("19. novel runs");
const runsOut = novel(["runs"]);
check(runsOut.stdout.includes("dry-run"), "生成历史里能看到这条记录");

section("20. 没有细纲时给出可操作的下一步");
const missing = novel(["write", "ch-0099", "--dry-run"], 1);
check(missing.stderr.includes("novel plan new ch-0099"), "直接给出该运行的命令");

/* ────────── 自己写的内容也要能进系统 ────────── */

// 注意：前面的段落为了布置 lint 场景，已经用 fs 直接写了 ch-0001 / ch-0002，
// 所以这里换一个还没有正文的章节来验证 chapter 命令。
section("21. 手写正文导入（novel chapter）");
const handWritten = join(SCRATCH, "hand-written.md");
writeFileSync(
  handWritten,
  "第 3 章正文。林渊握紧断岳刀，感知到刀身那道裂痕又深了一分。\n",
  "utf8",
);
novel(["chapter", "import", "ch-0003", handWritten]);
check(existsSync(join(BOOK, "chapters", "ch-0003.md")), "正文已落盘");
check(
  novel(["chapter", "show", "ch-0003"]).stdout.includes("断岳刀"),
  "chapter show 读得到正文",
);

section("22. 拒绝静默覆盖已有正文");
const clash = novel(["chapter", "import", "ch-0003", handWritten], 1);
check(clash.stderr.includes("拒绝覆盖"), "明确拒绝并说明现有字数");
check(
  novel(["chapter", "import", "ch-0003", handWritten, "--force"]).status === 0,
  "加 --force 后允许替换",
);

section("23. 章节总览点出摘要缺口");
const chapterList = novel(["chapter", "list"]);
check(chapterList.stdout.includes("ch-0003"), "列出章节");
check(chapterList.stdout.includes("有正文但没有摘要"), "点出摘要缺口");

section("24. 摘要骨架必须被识别为「没填」");
novel(["chapter", "summary", "new", "ch-0003"]);
const afterScaffold = novelJson(["--json", "chapter", "list"]);
const scaffolded = afterScaffold.chapters.find((chapter) => chapter.id === "ch-0003");
check(scaffolded.hasText === true, "有正文");
check(scaffolded.summaryIsPlaceholder === true, "骨架被识别为占位");
check(scaffolded.hasSummary === false, "占位摘要不算覆盖");
check(
  afterScaffold.missingSummaries.includes("ch-0003"),
  "仍计入缺失，不谎报已覆盖",
);

section("25. 手写摘要真的进入 Context Pack");
const summaryFile = join(SCRATCH, "summary-3.md");
writeFileSync(
  summaryFile,
  "### 情节\n林渊被逐出青云宗。\n\n### 状态变化\n- 物品：林渊获得断岳刀\n\n### 遗留\n苏晚为什么出现在谷口？\n",
  "utf8",
);
novel(["chapter", "summary", "set", "ch-0003", summaryFile]);

// 摘要要进入上下文，得有一个「更靠后」的章节来生成；默认只全文回看 2 章
for (const id of ["ch-0004", "ch-0005", "ch-0006"]) {
  novel(["plan", "new", id], 0, { echo: false });
}
const withSummary = novelJson(["--json", "write", "ch-0006", "--dry-run"]);
const summaryLayer = withSummary.record.context.layers.find(
  (layer) => layer.id === "summaries",
);
check(summaryLayer.itemCount === 1, "历史摘要层收到了 1 条");
check(
  summaryLayer.sources.includes("summaries/ch-0003"),
  "来源正是手写的那份摘要",
);
check(summaryLayer.usedTokens > 0, "摘要真的占了 token，而不是空条目");

const contextText = read(join(withSummary.runDir, "context.json"));
check(contextText.includes("苏晚为什么出现在谷口"), "摘要正文进了上下文");
check(!contextText.includes("（这一章发生了什么"), "骨架提示语没有混进去");

section("26. 摘要在 status 里可见");
const statusOut = novel(["status", "--no-lint"]);
check(statusOut.stdout.includes("摘要覆盖"), "status 展示摘要覆盖率");

/* ─────────────────────────────────────────────── */

section(failures === 0 ? "端到端验证全部通过" : `端到端验证有 ${failures} 项失败`);
process.stdout.write(`产物位于 ${SCRATCH}\n`);
if (failures > 0) process.exitCode = 1;
