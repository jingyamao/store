/**
 * Bible 集合的 CRUD 命令。
 *
 * 六个集合共用同一套 CRUD 实现，全部由 COLLECTION_LIST 驱动 ——
 * 新增一个集合只需要在 collections.ts 里登记一次。
 *
 * 设计取舍：本工具的核心原则之一是「文件即真相」，作者完全可以直接编辑 YAML。
 * 所以这里不提供复杂的编辑界面，只提供那些手改容易出错的操作
 * （新建骨架、按路径改单字段、删除时报告悬空引用）。
 */

import type { Command } from "commander";
import { chapterNumber, formatChapterId } from "../../domain/ids.js";
import type {
  Character,
  CharacterRole,
  Faction,
  Item,
  Location,
  Setting,
  Thread,
  ThreadStatus,
} from "../../domain/schemas.js";
import { listChapterIds } from "../../store/chapters.js";
import {
  findEntity,
  loadCollections,
  readAnyCollection,
  removeEntity,
  upsertEntity,
  writeAnyCollection,
} from "../../store/bible.js";
import {
  COLLECTION_LIST,
  type AnyCollectionDef,
  type AnyEntity,
} from "../../store/collections.js";
import { dumpYaml, validate } from "../../store/file-io.js";
import { resolveBook, type BookPaths } from "../../store/paths.js";
import { deleteByPath, getByPath, parseScalar, setByPath } from "../../util/dotted-path.js";
import { booksRootOf, CliError, fail, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

/* ── 展示标签 ─────────────────────────────────── */

const ROLE_LABEL: Record<CharacterRole, string> = {
  protagonist: "主角",
  deuteragonist: "次主角",
  antagonist: "反派",
  supporting: "配角",
  cameo: "龙套",
};

const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = {
  open: "未回收",
  hinted: "有推进",
  resolved: "已回收",
  abandoned: "已放弃",
};

/* ── 列定义 ───────────────────────────────────── */

interface Column {
  readonly header: string;
  readonly value: (entity: any) => string;
}

function columnsFor(def: AnyCollectionDef): Column[] {
  switch (def.key) {
    case "characters":
      return [
        { header: "ID", value: (e: Character) => e.id },
        { header: "姓名", value: (e: Character) => e.name },
        { header: "角色", value: (e: Character) => ROLE_LABEL[e.role] },
        { header: "境界", value: (e: Character) => e.state.realm ?? "" },
        { header: "状态", value: (e: Character) => (e.state.alive ? "" : "已死亡") },
      ];
    case "items":
      return [
        { header: "ID", value: (e: Item) => e.id },
        { header: "名称", value: (e: Item) => e.name },
        { header: "类别", value: (e: Item) => e.kind ?? "" },
        { header: "状态", value: (e: Item) => e.condition ?? "" },
      ];
    case "locations":
      return [
        { header: "ID", value: (e: Location) => e.id },
        { header: "名称", value: (e: Location) => e.name },
        { header: "上级", value: (e: Location) => e.parent ?? "" },
      ];
    case "factions":
      return [
        { header: "ID", value: (e: Faction) => e.id },
        { header: "名称", value: (e: Faction) => e.name },
        { header: "立场", value: (e: Faction) => e.alignment },
        { header: "根据地", value: (e: Faction) => e.base ?? "" },
      ];
    case "threads":
      return [
        { header: "ID", value: (e: Thread) => e.id },
        { header: "标题", value: (e: Thread) => e.title },
        { header: "状态", value: (e: Thread) => THREAD_STATUS_LABEL[e.status] },
        { header: "埋设", value: (e: Thread) => e.plantedAt ?? "" },
        { header: "回收", value: (e: Thread) => e.resolvedAt ?? e.targetResolve ?? "" },
      ];
    case "settings":
      return [
        { header: "ID", value: (e: Setting) => e.id },
        { header: "设定", value: (e: Setting) => e.statement },
        { header: "章节", value: (e: Setting) => e.establishedAt ?? "" },
        { header: "不可变", value: (e: Setting) => (e.immutable ? "是" : "否") },
      ];
    default:
      return [
        { header: "ID", value: (e: AnyEntity) => e.id },
      ];
  }
}

/* ── 悬空引用检测（删除后提示） ────────────────── */

async function findInboundReferences(paths: BookPaths, targetId: string): Promise<string[]> {
  const collections = await loadCollections(paths);
  const hits: string[] = [];

  const record = (owner: string, field: string, value: string | undefined) => {
    if (value === targetId) hits.push(`${owner} · ${field}`);
  };

  for (const character of collections.characters) {
    record(character.id, "state.location", character.state.location);
    character.state.possession.forEach((itemId, index) =>
      record(character.id, `state.possession[${index}]`, itemId),
    );
    character.relationships.forEach((relation, index) =>
      record(character.id, `relationships[${index}].target`, relation.target),
    );
  }

  for (const location of collections.locations) {
    record(location.id, "parent", location.parent);
  }

  for (const faction of collections.factions) {
    record(faction.id, "base", faction.base);
  }

  for (const thread of collections.threads) {
    thread.related.forEach((id, index) => record(thread.id, `related[${index}]`, id));
  }

  return hits;
}

/* ── 通用前置 ─────────────────────────────────── */

interface Loaded {
  readonly paths: BookPaths;
  readonly entities: AnyEntity[];
}

async function loadFor(def: AnyCollectionDef, global: GlobalOptions): Promise<Loaded> {
  const booksRoot = booksRootOf(global);
  const { paths } = await resolveBook(booksRoot, global.book);
  const entities = await readAnyCollection(paths, def);
  return { paths, entities };
}

function requireEntity(def: AnyCollectionDef, entities: AnyEntity[], id: string): AnyEntity {
  const entity = findEntity(entities, id);
  if (entity === undefined) {
    throw new CliError(
      `${def.label} "${id}" 不存在。\n可运行 \`novel ${def.key} list\` 查看全部${def.label}。`,
    );
  }
  return entity;
}

/* ── list ─────────────────────────────────────── */

async function handleList(
  def: AnyCollectionDef,
  global: GlobalOptions,
  query: string | undefined,
): Promise<number> {
  const { entities } = await loadFor(def, global);
  const columns = columnsFor(def);

  let shown = entities;
  if (query !== undefined && query.trim() !== "") {
    const needle = query.trim().toLowerCase();
    shown = entities.filter(
      (entity) =>
        entity.id.toLowerCase().includes(needle) ||
        columns.some((column) => column.value(entity).toLowerCase().includes(needle)),
    );
  }

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    return 0;
  }

  if (shown.length === 0) {
    const hint =
      query !== undefined
        ? `没有匹配 "${query}" 的${def.label}`
        : `还没有任何${def.label}`;
    process.stdout.write(
      `${ui.dim(hint)}\n` +
        (query === undefined
          ? `${ui.dim(`  用 novel ${def.key} add ${def.idPrefix}xxx --${def.primary.name} "..." 新增`)}\n`
          : ""),
    );
    return 0;
  }

  const rows = shown.map((entity) => columns.map((column) => column.value(entity)));
  process.stdout.write(
    `${ui.renderTable(columns.map((column) => column.header), rows)}\n` +
      `${ui.dim(`${shown.length} 条${shown.length !== entities.length ? ` / 共 ${entities.length} 条` : ""}`)}\n`,
  );
  return 0;
}

/* ── show ─────────────────────────────────────── */

async function handleShow(
  def: AnyCollectionDef,
  global: GlobalOptions,
  id: string,
): Promise<number> {
  const { entities } = await loadFor(def, global);
  const entity = requireEntity(def, entities, id);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(entity, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(dumpYaml(entity));
  return 0;
}

/* ── add ──────────────────────────────────────── */

async function handleAdd(
  def: AnyCollectionDef,
  global: GlobalOptions,
  id: string,
  primaryValue: string,
): Promise<number> {
  const { paths, entities } = await loadFor(def, global);

  if (findEntity(entities, id) !== undefined) {
    throw new CliError(
      `${def.label} "${id}" 已存在。\n用 \`novel ${def.key} set ${id} <字段> <值>\` 修改，或先 rm。`,
    );
  }

  // 交给 schema 补齐所有默认值 —— 这样 CLI 不需要知道每个集合有哪些字段
  const entity = validate(
    def.schema,
    { id, [def.primary.name]: primaryValue },
    `${def.label} ${id}`,
  ) as AnyEntity;

  const { next } = upsertEntity(entities, entity);
  await writeAnyCollection(paths, def, next);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(entity, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${ui.green("✓")} 已创建${def.label} ${ui.bold(id)} ${ui.dim(`→ ${def.file}`)}\n` +
      `${ui.dim(`  按需补充：novel ${def.key} set ${id} <字段> <值>`)}\n`,
  );
  return 0;
}

/* ── set / unset ──────────────────────────────── */

async function handleSet(
  def: AnyCollectionDef,
  global: GlobalOptions,
  id: string,
  path: string,
  rawValue: string,
): Promise<number> {
  const { paths, entities } = await loadFor(def, global);
  const entity = requireEntity(def, entities, id);

  const draft = structuredClone(entity) as Record<string, unknown>;
  const previous = getByPath(draft, path);
  const value = parseScalar(rawValue);
  setByPath(draft, path, value);

  const next = validate(def.schema, draft, `${def.label} ${id}`) as AnyEntity;
  const { next: updated } = upsertEntity(entities, next);
  await writeAnyCollection(paths, def, updated);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return 0;
  }

  const from =
    previous === undefined ? ui.dim("(未设置)") : ui.dim(JSON.stringify(previous));
  process.stdout.write(
    `${ui.green("✓")} ${id} · ${ui.bold(path)}\n` +
      `  ${from} ${ui.dim("→")} ${JSON.stringify(value)}\n`,
  );
  return 0;
}

async function handleUnset(
  def: AnyCollectionDef,
  global: GlobalOptions,
  id: string,
  path: string,
): Promise<number> {
  const { paths, entities } = await loadFor(def, global);
  const entity = requireEntity(def, entities, id);

  const draft = structuredClone(entity) as Record<string, unknown>;
  if (!deleteByPath(draft, path)) {
    throw new CliError(`${id} 上不存在字段 "${path}"`);
  }

  // 删掉必填字段时这里会抛出可读的校验错误，而不是写出坏数据
  const next = validate(def.schema, draft, `${def.label} ${id}`) as AnyEntity;
  const { next: updated } = upsertEntity(entities, next);
  await writeAnyCollection(paths, def, updated);

  process.stdout.write(`${ui.green("✓")} 已移除 ${id} · ${path}\n`);
  return 0;
}

/* ── rm ───────────────────────────────────────── */

async function handleRemove(
  def: AnyCollectionDef,
  global: GlobalOptions,
  id: string,
): Promise<number> {
  const { paths, entities } = await loadFor(def, global);
  requireEntity(def, entities, id);

  const { next, removed } = removeEntity(entities, id);
  if (removed === undefined) throw new CliError(`${def.label} "${id}" 不存在`);

  await writeAnyCollection(paths, def, next);

  if (global.json === true) {
    process.stdout.write(`${JSON.stringify({ removed: id }, null, 2)}\n`);
    return 0;
  }

  const lines = [`${ui.green("✓")} 已删除${def.label} ${ui.bold(id)}`];

  // 删除会制造悬空引用 —— 主动告诉作者「谁受了影响」，而不是等他跑 lint
  const inbound = await findInboundReferences(paths, id);
  if (inbound.length > 0) {
    lines.push("");
    lines.push(ui.yellow(`! 以下 ${inbound.length} 处引用现在已经悬空：`));
    for (const hit of inbound) lines.push(ui.bullet(hit));
    lines.push(ui.dim("  运行 novel lint 查看完整报告"));
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/* ── threads resolve ──────────────────────────── */

async function handleResolve(
  def: AnyCollectionDef,
  global: GlobalOptions,
  id: string,
  at: string | undefined,
): Promise<number> {
  const { paths, entities } = await loadFor(def, global);
  const entity = requireEntity(def, entities, id);

  let chapterId = at;
  if (chapterId === undefined) {
    const ids = await listChapterIds(paths);
    const last = ids[ids.length - 1];
    if (last === undefined) {
      throw new CliError("chapters/ 下还没有任何章节，请用 --at ch-XXXX 显式指定回收章节");
    }
    chapterId = last;
  }

  const draft = structuredClone(entity) as Record<string, unknown>;
  setByPath(draft, "status", "resolved");
  setByPath(draft, "resolvedAt", chapterId);

  const next = validate(def.schema, draft, `${def.label} ${id}`) as AnyEntity;
  const { next: updated } = upsertEntity(entities, next);
  await writeAnyCollection(paths, def, updated);

  process.stdout.write(
    `${ui.green("✓")} 伏笔 ${ui.bold(id)} 已标记为回收于 ${chapterId}\n`,
  );
  return 0;
}

/* ── commander 接线 ───────────────────────────── */

type Handler = (input: {
  positional: unknown[];
  options: Record<string, unknown>;
  global: GlobalOptions;
}) => Promise<number>;

/**
 * 包装 action：统一异常处理与退出码。
 *
 * commander 会把 (…位置参数, options, command) 传给 action，
 * 因此倒数第二个是 options、最后一个是 command 对象。
 */
function action(handler: Handler, global: () => GlobalOptions) {
  return async (...raw: unknown[]): Promise<void> => {
    const options = (raw[raw.length - 2] ?? {}) as Record<string, unknown>;
    const positional = raw.slice(0, -2);
    try {
      process.exitCode = await handler({ positional, options, global: global() });
    } catch (error) {
      fail(error);
      process.exitCode = 1;
    }
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`缺少参数 ${label}`);
  }
  return value;
}

export function registerCollectionCommands(program: Command): void {
  const global = (): GlobalOptions => program.opts<GlobalOptions>();

  for (const def of COLLECTION_LIST) {
    const group = program.command(def.key).description(`${def.label}管理`);
    for (const alias of def.aliases) group.alias(alias);

    group
      .command("list")
      .description(`列出全部${def.label}`)
      .option("-q, --query <text>", "按关键词过滤")
      .action(
        action(
          ({ options, global: g }) =>
            handleList(
              def,
              g,
              typeof options["query"] === "string" ? options["query"] : undefined,
            ),
          global,
        ),
      );

    group
      .command("show <id>")
      .description(`查看单条${def.label}（YAML 原文）`)
      .action(
        action(
          ({ positional, global: g }) =>
            handleShow(def, g, requireString(positional[0], "<id>")),
          global,
        ),
      );

    group
      .command("add <id>")
      .description(`新增${def.label}（其余字段由 schema 补默认值）`)
      .requiredOption(`--${def.primary.name} <value>`, def.primary.label)
      .action(
        action(
          ({ positional, options, global: g }) =>
            handleAdd(
              def,
              g,
              requireString(positional[0], "<id>"),
              requireString(options[def.primary.name], `--${def.primary.name}`),
            ),
          global,
        ),
      );

    group
      .command("set <id> <path> <value>")
      .description("按路径修改字段，如 state.realm 筑基后期")
      .action(
        action(
          ({ positional, global: g }) =>
            handleSet(
              def,
              g,
              requireString(positional[0], "<id>"),
              requireString(positional[1], "<path>"),
              requireString(positional[2], "<value>"),
            ),
          global,
        ),
      );

    group
      .command("unset <id> <path>")
      .description("按路径移除字段")
      .action(
        action(
          ({ positional, global: g }) =>
            handleUnset(
              def,
              g,
              requireString(positional[0], "<id>"),
              requireString(positional[1], "<path>"),
            ),
          global,
        ),
      );

    group
      .command("rm <id>")
      .description(`删除${def.label}，并报告因此悬空的引用`)
      .action(
        action(
          ({ positional, global: g }) =>
            handleRemove(def, g, requireString(positional[0], "<id>")),
          global,
        ),
      );

    if (def.key === "threads") {
      group
        .command("resolve <id>")
        .description("标记伏笔已回收")
        .option("--at <chapter>", "回收章节，默认为最新一章")
        .action(
          action(
            ({ positional, options, global: g }) =>
              handleResolve(
                def,
                g,
                requireString(positional[0], "<id>"),
                typeof options["at"] === "string" ? options["at"] : undefined,
              ),
            global,
          ),
        );
    }
  }
}
