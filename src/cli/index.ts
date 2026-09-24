#!/usr/bin/env node
/**
 * novel —— AI 网文创作工作台 CLI。
 *
 * 提供：书籍脚手架、Bible 集合 CRUD、确定性 lint、仪表盘，
 * 以及 M2 的单章生成闭环（细纲 → 开篇方案 → 初稿 → runs 记录）。
 */

import { Command } from "commander";
import { registerCollectionCommands } from "./commands/collections.js";
import { runConfigInit, runConfigShow } from "./commands/config.js";
import { runInit } from "./commands/init.js";
import { runLintCommand } from "./commands/lint.js";
import { runPlanList, runPlanNew, runPlanSet, runPlanShow } from "./commands/plan.js";
import { runRuns } from "./commands/runs.js";
import { runStatus } from "./commands/status.js";
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
        },
        globals(),
      ),
    ),
  );

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

/* ── 集合 CRUD ────────────────────────────────── */

registerCollectionCommands(program);

/* ── 入口 ─────────────────────────────────────── */

const invoked = process.argv.slice(2);

if (invoked.length === 0) {
  program.outputHelp();
} else {
  await program.parseAsync(process.argv);
}
