#!/usr/bin/env node
/**
 * novel —— AI 网文创作工作台 CLI。
 *
 * M0/M1 阶段提供：书籍脚手架、Bible 集合 CRUD、确定性 lint、仪表盘。
 */

import { Command } from "commander";
import { registerCollectionCommands } from "./commands/collections.js";
import { runInit } from "./commands/init.js";
import { runLintCommand } from "./commands/lint.js";
import { runStatus } from "./commands/status.js";
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

/* ── 集合 CRUD ────────────────────────────────── */

registerCollectionCommands(program);

/* ── 入口 ─────────────────────────────────────── */

const invoked = process.argv.slice(2);

if (invoked.length === 0) {
  program.outputHelp();
} else {
  await program.parseAsync(process.argv);
}
