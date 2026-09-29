import { loadConfig } from "../../config/index.js";
import { resolveBook } from "../../store/paths.js";
import { adoptVolumeSummary, proposeVolumeSummary, readVolumeProposal } from "../../sync/volume.js";
import { booksRootOf, resolveWorkspaceRoot, type GlobalOptions } from "../context.js";
import * as ui from "../ui.js";

export async function runVolumePropose(volume: string, force: boolean, global: GlobalOptions): Promise<number> {
  const config = await loadConfig(resolveWorkspaceRoot(global.dir));
  const proposal = await proposeVolumeSummary({ booksRoot: booksRootOf(global), bookId: global.book, volume, config, force });
  process.stdout.write(global.json === true ? `${JSON.stringify(proposal, null, 2)}\n` : `${ui.bold(volume)} 卷摘要提案\n\n${proposal.summary}\n\n确认后运行 novel volume adopt ${volume}\n`);
  return 0;
}
export async function runVolumeShow(volume: string, global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const proposal = await readVolumeProposal(resolved.paths, volume);
  process.stdout.write(global.json === true ? `${JSON.stringify(proposal, null, 2)}\n` : `${ui.bold(volume)} 卷摘要提案\n\n${proposal.summary}\n`);
  return 0;
}
export async function runVolumeAdopt(volume: string, force: boolean, global: GlobalOptions): Promise<number> {
  const resolved = await resolveBook(booksRootOf(global), global.book);
  const file = await adoptVolumeSummary(resolved.paths, volume, force);
  process.stdout.write(global.json === true ? `${JSON.stringify({ outputFile: file })}\n` : `${ui.green("✓")} 已采用卷摘要 → ${file}\n`);
  return 0;
}
