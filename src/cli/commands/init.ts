/**
 * `novel init <book-id>` —— 创建一本新书。
 */

import type { Pov } from "../../domain/schemas.js";
import { initBook } from "../../store/scaffold.js";
import { booksRootOf, CliError, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export interface InitArgs {
  readonly bookId: string;
  readonly title?: string | undefined;
  readonly author?: string | undefined;
  readonly genres?: readonly string[] | undefined;
  readonly pov?: string | undefined;
  readonly platform?: string | undefined;
  readonly logline?: string | undefined;
  readonly force?: boolean | undefined;
}

const POV_ALIASES: Record<string, Pov> = {
  "第一人称": "第一人称",
  "1": "第一人称",
  first: "第一人称",
  "我": "第一人称",
  "第三人称有限": "第三人称有限",
  "3": "第三人称有限",
  "3l": "第三人称有限",
  limited: "第三人称有限",
  "有限": "第三人称有限",
  "第三人称全知": "第三人称全知",
  "3omni": "第三人称全知",
  omniscient: "第三人称全知",
  "全知": "第三人称全知",
};

function normalizePov(raw: string | undefined): Pov | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim();
  const resolved = POV_ALIASES[key] ?? POV_ALIASES[key.toLowerCase()];
  if (resolved === undefined) {
    throw new CliError(
      `无法识别的视角 "${raw}"。可选：第一人称 / 第三人称有限 / 第三人称全知`,
    );
  }
  return resolved;
}

export async function runInit(args: InitArgs, global: GlobalOptions): Promise<number> {
  const booksRoot = booksRootOf(global);
  const pov = normalizePov(args.pov);

  const paths = await initBook(booksRoot, {
    bookId: args.bookId,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.author !== undefined ? { author: args.author } : {}),
    genres: args.genres ?? [],
    ...(pov !== undefined ? { pov } : {}),
    ...(args.platform !== undefined ? { targetPlatform: args.platform } : {}),
    ...(args.logline !== undefined ? { logline: args.logline } : {}),
    force: args.force ?? false,
  });

  if (global.json === true) {
    process.stdout.write(
      `${JSON.stringify({ bookId: args.bookId, root: paths.root }, null, 2)}\n`,
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(`${ui.green("✓")} 已创建书籍 ${ui.bold(args.bookId)}`);
  lines.push("");
  lines.push(`  ${ui.dim(paths.root)}`);
  lines.push("");
  lines.push(
    [
      "  book.yaml               书籍元信息",
      "  style.md                ★ 文风锚定（最该先填这份）",
      "  outline/master.md       全书总纲",
      "  bible/",
      "    characters.yaml       人物卡",
      "    items.yaml            物品",
      "    locations.yaml        地点",
      "    factions.yaml         势力",
      "    power_system.yaml     境界 / 等级体系",
      "    settings.yaml         已立设定（硬规则）",
      "    threads.yaml          伏笔追踪",
      "    timeline.yaml         故事内时间线",
      "  chapters/               正文",
      "  summaries/              章节 / 卷摘要",
      "  runs/                   生成记录",
    ].join("\n"),
  );
  lines.push("");
  lines.push(ui.bold("下一步"));
  lines.push(ui.bullet(`编辑 ${ui.cyan("style.md")} —— 文风锚定是整份 Bible 里最该先填的`));
  lines.push(ui.bullet(`novel char add char_zhujiao --name "主角名"`));
  lines.push(ui.bullet(`novel lint`));

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
