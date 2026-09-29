#!/usr/bin/env node
/**
 * novel —— AI 网文创作工作台 CLI。
 *
 * 提供：书籍脚手架、Bible 集合 CRUD、确定性 lint、仪表盘，
 * 以及 M2 的单章生成闭环（细纲 → 开篇方案 → 初稿 → runs 记录）。
 */

import { Command } from "commander";
import {
  runChapterImport,
  runChapterList,
  runChapterNew,
  runChapterShow,
  runSummaryNew,
  runSummarySet,
  runSummaryShow,
} from "./commands/chapter.js";
import { registerCollectionCommands } from "./commands/collections.js";
import { runConfigInit, runConfigShow } from "./commands/config.js";
import { runAgentWrite } from "./commands/agent.js";
import { runMemoryRecord, runMemoryShow } from "./commands/memory.js";
import { runInit } from "./commands/init.js";
import { runLintCommand } from "./commands/lint.js";
import { runPlanList, runPlanNew, runPlanSet, runPlanShow } from "./commands/plan.js";
import { runReview } from "./commands/review.js";
import { runAsk, runIndexRebuild, runSearch } from "./commands/search.js";
import { runServe } from "./commands/serve.js";
import { runVolumeAdopt, runVolumePropose, runVolumeShow } from "./commands/volume.js";
import { runAdopt, runRuns } from "./commands/runs.js";
import { runStatus } from "./commands/status.js";
import { runSyncApply, runSyncPropose, runSyncShow } from "./commands/sync.js";
import { runWrite } from "./commands/write.js";
import { fail, type GlobalOptions } from "./context.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("novel")
  .description(
    "AI 网文创作工作台 —— 长篇一致性优先的人机协作写作工具\n" +
      "用 novel <集合> --help 查看某个集合的完整操作。",
  )
  .version(VERSION, "-v, --version", "显示版本号")
  .option("-C, --dir <path>", "工作区根目录（默认 $NOVEL_HOME 或当前目录）")
  .option("-b, --book <id>", "指定书籍 id（默认自动探测）")
  .option("--json", "以 JSON 输出，便于脚本消费")
  .showHelpAfterError()
  .showSuggestionAfterError();

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

/** 统一异常处理：只打印消息，不抛堆栈。 */
function guard<A extends unknown[]>(
  handler: (...args: A) => Promise<number>,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    try {
      process.exitCode = await handler(...args);
    } catch (error) {
      fail(error);
      process.exitCode = 1;
    }
  };
}

/* ── init ─────────────────────────────────────── */

interface InitCliOptions {
  readonly title?: string;
  readonly author?: string;
  readonly genre?: string[];
  readonly pov?: string;
  readonly platform?: string;
  readonly logline?: string;
  readonly force?: boolean;
}

program
  .command("init <book-id>")
  .description("创建一本新书")
  .option("-t, --title <title>", "书名")
  .option("-a, --author <name>", "作者")
  .option("-g, --genre <genre...>", "题材，可写多个")
  .option("-p, --pov <pov>", "视角：第一人称 / 第三人称有限 / 第三人称全知")
  .option("--platform <name>", "目标平台")
  .option("-l, --logline <text>", "一句话简介")
  .option("-f, --force", "目录已存在时覆盖模板文件")
  .action(
    guard(async (bookId: string, options: InitCliOptions) =>
      runInit(
        {
          bookId,
          ...(options.title !== undefined ? { title: options.title } : {}),
          ...(options.author !== undefined ? { author: options.author } : {}),
          ...(options.genre !== undefined ? { genres: options.genre } : {}),
          ...(options.pov !== undefined ? { pov: options.pov } : {}),
          ...(options.platform !== undefined ? { platform: options.platform } : {}),
          ...(options.logline !== undefined ? { logline: options.logline } : {}),
          force: options.force ?? false,
        },
        globals(),
      ),
    ),
  );

/* ── status ───────────────────────────────────── */

interface StatusCliOptions {
  readonly all?: boolean;
  /** commander 的 --no-lint 会把它置为 false。 */
  readonly lint?: boolean;
}

program
  .command("status [book-id]")
  .description("查看书籍进度与 Bible 规模")
  .option("-A, --all", "列出工作区内的全部书籍")
  .option("--no-lint", "跳过 lint 汇总（速度更快）")
  .action(
    guard(async (bookId: string | undefined, options: StatusCliOptions) =>
      runStatus(
        {
          bookId,
          all: options.all ?? false,
          skipLint: options.lint === false,
        },
        globals(),
      ),
    ),
  );

/* ── lint ─────────────────────────────────────── */

interface LintCliOptions {
  readonly threadExpiry?: number;
  readonly strict?: boolean;
  readonly rule?: string;
}

program
  .command("lint [book-id]")
  .description("运行确定性检查（专名冲突 / 悬空引用 / 境界矛盾 / 伏笔超期 ...）")
  .option("--thread-expiry <n>", "伏笔超期阈值（章），默认 60", (value) =>
    Number.parseInt(value, 10),
  )
  .option("--strict", "警告也视为失败（退出码 1）")
  .option("--rule <name>", "只运行指定规则")
  .action(
    guard(async (bookId: string | undefined, options: LintCliOptions) =>
      runLintCommand(
        {
          bookId,
          ...(options.threadExpiry !== undefined && !Number.isNaN(options.threadExpiry)
            ? { threadExpiry: options.threadExpiry }
            : {}),
          strict: options.strict ?? false,
          ...(options.rule !== undefined ? { rule: options.rule } : {}),
        },
        globals(),
      ),
    ),
  );

/* ── 章节细纲 ─────────────────────────────────── */

const plan = program
  .command("plan")
  .description("章节细纲 —— 人机协作的第一个决策点：你定「写什么」，AI 管「怎么写」");

plan
  .command("list")
  .description("列出所有已写细纲的章节")
  .action(guard(async () => runPlanList(globals())));

plan
  .command("show <chapter>")
  .description("查看某一章的细纲")
  .action(guard(async (chapter: string) => runPlanShow(chapter, globals())));

interface PlanNewCliOptions {
  readonly title?: string;
  readonly force?: boolean;
}

plan
  .command("new <chapter>")
  .description("生成细纲骨架（章节 id 形如 ch-0001）")
  .option("-t, --title <title>", "章节标题")
  .option("-f, --force", "已存在时覆盖")
  .action(
    guard(async (chapter: string, options: PlanNewCliOptions) =>
      runPlanNew(
        chapter,
        {
          ...(options.title !== undefined ? { title: options.title } : {}),
          force: options.force ?? false,
        },
        globals(),
      ),
    ),
  );

plan
  .command("set <chapter> <path> <value>")
  .description("改细纲的单个字段，如 cast / intent / mustInclude")
  .action(
    guard(async (chapter: string, path: string, value: string) =>
      runPlanSet(chapter, path, value, globals()),
    ),
  );

/* ── 单章生成 ─────────────────────────────────── */

interface WriteCliOptions {
  readonly dryRun?: boolean;
  readonly openings?: number;
  readonly pick?: number;
  readonly words?: number;
  readonly apply?: boolean;
  readonly force?: boolean;
  readonly openingsOnly?: boolean;
  readonly fromRun?: string;
}

program
  .command("write <chapter>")
  .description("生成一章初稿（默认只写进 runs/，确认后再加 --apply 落盘）")
  .option("--dry-run", "只组装上下文并落盘，不调用模型、不需要密钥")
  .option("--openings <n>", "开篇方案数量", (value) => Number.parseInt(value, 10))
  .option("--pick <n>", "选中第几个开篇方案，默认 1", (value) => Number.parseInt(value, 10))
  .option("--words <n>", "目标字数，覆盖细纲与配置", (value) => Number.parseInt(value, 10))
  .option("--apply", "生成后写入 chapters/<章节>.md")
  .option("--force", "配合 --apply：目标已有内容时允许覆盖")
  .option("--openings-only", "只生成开篇方案，先阅读再选择")
  .option("--from-run <id>", "从已有开篇记录续写初稿，不重复生成开篇")
  .action(
    guard(async (chapter: string, options: WriteCliOptions) =>
      runWrite(
        chapter,
        {
          ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
          ...(options.openings !== undefined && !Number.isNaN(options.openings)
            ? { openings: options.openings }
            : {}),
          ...(options.pick !== undefined && !Number.isNaN(options.pick)
            ? { pick: options.pick }
            : {}),
          ...(options.words !== undefined && !Number.isNaN(options.words)
            ? { words: options.words }
            : {}),
          ...(options.apply !== undefined ? { apply: options.apply } : {}),
          ...(options.force !== undefined ? { force: options.force } : {}),
          ...(options.openingsOnly !== undefined ? { openingsOnly: options.openingsOnly } : {}),
          ...(options.fromRun !== undefined ? { fromRun: options.fromRun } : {}),
        },
        globals(),
      ),
    ),
  );

const agent = program.command("agent").description("长篇写作 Agent：按章节时间点检索多层记忆、规划场景并生成初稿");
agent.command("write <chapter>")
  .description("检索历史证据、规划本章、生成待审阅初稿")
  .option("--dry-run", "只生成记忆快照，不调用模型")
  .option("--words <n>", "目标字数", (value) => Number.parseInt(value, 10))
  .action(guard(async (chapter: string, options: { dryRun?: boolean; words?: number }) =>
    runAgentWrite(chapter, options, globals()),
  ));

const memory = program.command("memory").description("补录并查询有章节出处的长期历史事实");
memory.command("record <chapter> <collection> <entity> <field> [value]")
  .description("记录作者确认的历史事实；value 为 JSON 或普通文本")
  .requiredOption("--evidence <text>", "定稿正文原句，或配合 --author-note 使用作者说明")
  .option("--author-note", "依据为作者说明，不要求正文中出现相同文字")
  .option("--value-file <path>", "从 JSON 文件读取数组或对象值")
  .option("--force", "替换同章节、同实体、同字段的记录")
  .action(guard(async (chapter: string, collection: string, entity: string, field: string, value: string | undefined,
    options: { evidence: string; authorNote?: boolean; valueFile?: string; force?: boolean }) =>
    runMemoryRecord(chapter, collection, entity, field, value, options, globals()),
  ));
memory.command("show <chapter>")
  .description("查看这一章开始之前生效的已确认历史事实")
  .option("--entity <id>", "只显示某个实体")
  .action(guard(async (chapter: string, options: { entity?: string }) => runMemoryShow(chapter, options.entity, globals())));

interface RunsCliOptions {
  readonly limit?: number;
}

program
  .command("runs")
  .description("查看历史生成记录")
  .option("-n, --limit <n>", "显示最近多少条，默认 20", (value) => Number.parseInt(value, 10))
  .action(
    guard(async (options: RunsCliOptions) =>
      runRuns(
        options.limit !== undefined && !Number.isNaN(options.limit)
          ? { limit: options.limit }
          : {},
        globals(),
      ),
    ),
  );

program
  .command("adopt <run-id>")
  .description("采用已有生成记录的初稿，不再次调用模型")
  .option("-f, --force", "已有正文时覆盖")
  .action(guard(async (runId: string, options: { force?: boolean }) =>
    runAdopt(runId, options.force ?? false, globals()),
  ));

/* ── 配置 ─────────────────────────────────────── */

const config = program.command("config").description("工作区配置（模型、密钥来源、上下文预算）");

config
  .command("show")
  .description("显示当前生效的配置（密钥打码）")
  .action(guard(async () => runConfigShow(globals())));

config
  .command("init")
  .description("生成带注释的 novel.config.yaml")
  .option("-f, --force", "已存在时覆盖")
  .action(
    guard(async (options: { force?: boolean }) =>
      runConfigInit({ force: options.force ?? false }, globals()),
    ),
  );

/* ── 正文与摘要 ───────────────────────────────── */

const chapter = program
  .command("chapter")
  .description("正文与摘要 —— 自己写的内容走这里，不必经过模型");

chapter
  .command("list")
  .description("章节总览：细纲 / 正文 / 字数 / 摘要")
  .action(guard(async () => runChapterList(globals())));

chapter
  .command("new <chapter>")
  .description("新建正文文件")
  .option("-f, --force", "已存在时覆盖")
  .action(
    guard(async (chapterId: string, options: { force?: boolean }) =>
      runChapterNew(chapterId, { force: options.force ?? false }, globals()),
    ),
  );

chapter
  .command("show <chapter>")
  .description("查看正文")
  .action(guard(async (chapterId: string) => runChapterShow(chapterId, globals())));

chapter
  .command("import <chapter> <file>")
  .description("导入正文（自己写的稿子 / 外部工具产出），<file> 用 - 表示标准输入")
  .option("-f, --force", "已存在正文时允许覆盖")
  .action(
    guard(async (chapterId: string, file: string, options: { force?: boolean }) =>
      runChapterImport(chapterId, file, { force: options.force ?? false }, globals()),
    ),
  );

const summary = chapter
  .command("summary")
  .description("章节摘要 —— 更早的章节靠它进入模型上下文");

summary
  .command("show <chapter>")
  .description("查看摘要")
  .action(guard(async (chapterId: string) => runSummaryShow(chapterId, globals())));

summary
  .command("new <chapter>")
  .description("生成摘要骨架，四个问题各写一两行即可")
  .option("-f, --force", "已存在时覆盖")
  .action(
    guard(async (chapterId: string, options: { force?: boolean }) =>
      runSummaryNew(chapterId, { force: options.force ?? false }, globals()),
    ),
  );

summary
  .command("set <chapter> <file>")
  .description("写入摘要，<file> 用 - 表示标准输入")
  .action(
    guard(async (chapterId: string, file: string) =>
      runSummarySet(chapterId, file, globals()),
    ),
  );

/* ── 集合 CRUD ────────────────────────────────── */

registerCollectionCommands(program);

program.command("review <chapter>")
  .description("检查已写正文的 AI 味、文风和节奏；--ai 增加模型评审")
  .option("--ai", "调用模型做节奏、情节评审")
  .action(guard(async (chapter: string, options: { ai?: boolean }) =>
    runReview(chapter, options.ai ?? false, globals()),
  ));

const index = program.command("index").description("可重建的小说全文检索索引");
index.command("rebuild").description("从 YAML/Markdown 重建 SQLite FTS5 索引")
  .action(guard(async () => runIndexRebuild(globals())));
program.command("search <query>").description("搜索正文、摘要、细纲和 Bible")
  .action(guard(async (query: string) => runSearch(query, globals())));
program.command("ask <question>").description("检索资料后让模型回答，并标明资料来源")
  .action(guard(async (question: string) => runAsk(question, globals())));
program.command("serve").description("启动本地三栏写作台")
  .option("-p, --port <number>", "监听端口，默认 4173", (value) => Number.parseInt(value, 10))
  .action(guard(async (options: { port?: number }) => runServe(options.port ?? 4173, globals())));

/* ── 定稿后的状态回写 ─────────────────────────── */
const sync = program.command("sync").description("从定稿提取状态变化，人工确认后回写 Bible");
sync.command("propose <chapter>")
  .description("让模型从正文提取摘要和状态变化，生成待确认提案")
  .option("-f, --force", "重新生成已有提案")
  .action(guard(async (chapter: string, options: { force?: boolean }) =>
    runSyncPropose(chapter, options.force ?? false, globals()),
  ));
sync.command("show <chapter>")
  .description("查看状态变化的旧值、新值和正文依据")
  .action(guard(async (chapter: string) => runSyncShow(chapter, globals())));
sync.command("apply <chapter>")
  .description("逐项接受状态变化；摘要需单独加 --summary")
  .option("--accept <numbers>", "接受的序号，例如 1,3")
  .option("--summary", "同时采用提案中的章节摘要")
  .action(guard(async (chapter: string, options: { accept?: string; summary?: boolean }) =>
    runSyncApply(chapter, options.accept, options.summary ?? false, globals()),
  ));

const volume = program.command("volume").description("从已确认的章节摘要生成卷摘要");
volume.command("propose <volume>").description("生成卷摘要待确认提案")
  .option("-f, --force", "重新生成提案")
  .action(guard(async (id: string, options: { force?: boolean }) => runVolumePropose(id, options.force ?? false, globals())));
volume.command("show <volume>").description("查看卷摘要提案")
  .action(guard(async (id: string) => runVolumeShow(id, globals())));
volume.command("adopt <volume>").description("采用已审阅的卷摘要")
  .option("-f, --force", "已有卷摘要时覆盖")
  .action(guard(async (id: string, options: { force?: boolean }) => runVolumeAdopt(id, options.force ?? false, globals())));

/* ── 入口 ─────────────────────────────────────── */

const invoked = process.argv.slice(2);

if (invoked.length === 0) {
  program.outputHelp();
} else {
  await program.parseAsync(process.argv);
}
