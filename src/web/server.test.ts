import { afterEach, describe, it } from "node:test";
import { createWorkspace, type TestWorkspace } from "../testing/workspace.js";
import { expect } from "../testing/expect.js";
import { startWorkbench } from "./server.js";
import type { Server } from "node:http";

const opened: Array<{ ws: TestWorkspace; server: Server }> = [];
afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    await entry.ws.cleanup();
  }
});

describe("本地写作台", () => {
  it("提供三栏页面，并用版本哈希避免覆盖外部改稿", async () => {
    const ws = await createWorkspace();
    const { server, url } = await startWorkbench({ booksRoot: ws.booksRoot, workspaceRoot: ws.root, port: 0 });
    opened.push({ ws, server });
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch("本地写作台");
    const stylesheet = await fetch(`${url}/app.css`);
    expect(stylesheet.status).toBe(200);
    expect(await stylesheet.text()).toMatch("paper-wrap");
    const script = await fetch(`${url}/app.js`);
    expect(script.status).toBe(200);
    const source = await script.text();
    expect(source).toMatch("章节计划");
    expect(source).toMatch("Agent 写初稿");
    expect(source).toMatch("恢复这个旧版本");
    expect(await (await fetch(url)).text()).toMatch("版本历史");
    new Function(source);
    const beforeOutline = await (await fetch(`${url}/api/chapter/ch-0001`)).json() as { outlineHash: string };
    const outlineResponse = await fetch(`${url}/api/outline/ch-0001`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseHash: beforeOutline.outlineHash, title: "山门风波", intent: "主角离开宗门", conflict: "长老阻拦", cast: [], targetWords: 2800 }),
    });
    expect(outlineResponse.status).toBe(200);
    const agentPreview = await fetch(`${url}/api/agent/write`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chapter: "ch-0001", dryRun: true }),
    });
    expect(agentPreview.status).toBe(200);
    const preview = await agentPreview.json() as { run: string; draft: string | null };
    expect(preview.draft).toBe(null);
    expect(preview.run).toMatch("ch-0001");
    const staleOutline = await fetch(`${url}/api/outline/ch-0001`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseHash: beforeOutline.outlineHash, title: "旧细纲", intent: "旧计划", conflict: "", cast: [], targetWords: null }),
    });
    expect(staleOutline.status).toBe(409);
    const emptyChapter = await (await fetch(`${url}/api/chapter/ch-0009`)).json() as { outlineHash: string };
    const createChapter = await fetch(`${url}/api/outline/ch-0009`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseHash: emptyChapter.outlineHash, title: "", intent: "", conflict: "", cast: [], targetWords: null }),
    });
    expect(createChapter.status).toBe(200);
    const progress = await (await fetch(`${url}/api/state`)).json() as { chapters: Array<{ id: string }> };
    expect(progress.chapters.some((item) => item.id === "ch-0009")).toBe(true);
    const initial = await (await fetch(`${url}/api/chapter/ch-0001`)).json() as { hash: string; outline: { title: string } };
    expect(initial.outline.title).toBe("山门风波");
    const first = await fetch(`${url}/api/chapter/ch-0001`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "第一章正文", baseHash: initial.hash }) });
    expect(first.status).toBe(200);
    const stale = await fetch(`${url}/api/chapter/ch-0001`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "旧稿覆盖", baseHash: initial.hash }) });
    expect(stale.status).toBe(409);
  });

  it("可预览并恢复正文与细纲；过期预览不能覆盖新保存", async () => {
    const ws = await createWorkspace();
    const { server, url } = await startWorkbench({ booksRoot: ws.booksRoot, workspaceRoot: ws.root, port: 0 });
    opened.push({ ws, server });
    const chapterUrl = `${url}/api/chapter/ch-0001`;
    const put = (text: string, baseHash: string) => fetch(chapterUrl, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, baseHash }),
    });
    const initial = await (await fetch(chapterUrl)).json() as { hash: string; outlineHash: string };
    expect((await put("第一版", initial.hash)).status).toBe(200);
    const first = await (await fetch(chapterUrl)).json() as { hash: string };
    expect((await put("第二版", first.hash)).status).toBe(200);
    const listing = await (await fetch(`${url}/api/history/ch-0001?kind=text`)).json() as { versions: Array<{ id: string; reason: string }> };
    const old = listing.versions.find((entry) => entry.id !== "current");
    if (old === undefined) throw new Error("旧正文未进入版本历史");
    const previewUrl = `${url}/api/history/ch-0001/${old.id}?kind=text`;
    const preview = await (await fetch(previewUrl)).json() as { currentHash: string; lines: Array<{ kind: string; text: string }> };
    if (!preview.lines.some((line) => line.kind === "remove" && line.text === "第一版")) throw new Error("没有显示旧版差异");
    expect((await put("第三版", preview.currentHash)).status).toBe(200);
    const restoreUrl = `${url}/api/history/ch-0001/${old.id}/restore`;
    const restore = (kind: string, baseHash: string, route = restoreUrl) => fetch(route, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, baseHash }),
    });
    expect((await restore("text", preview.currentHash)).status).toBe(409);
    const fresh = await (await fetch(previewUrl)).json() as { currentHash: string };
    expect((await restore("text", fresh.currentHash)).status).toBe(200);
    const restored = await (await fetch(chapterUrl)).json() as { text: string; outlineHash: string };
    expect(restored.text).toBe("第一版");
    const after = await (await fetch(`${url}/api/history/ch-0001?kind=text`)).json() as { versions: Array<{ reason: string }> };
    if (!after.versions.some((entry) => entry.reason === "restore")) throw new Error("恢复前正文未保存");

    const patch = (title: string, baseHash: string) => fetch(`${url}/api/outline/ch-0001`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseHash, title, intent: "", conflict: "", cast: [], targetWords: null }),
    });
    expect((await patch("旧细纲", restored.outlineHash)).status).toBe(200);
    const outlineFirst = await (await fetch(chapterUrl)).json() as { outlineHash: string };
    expect((await patch("新细纲", outlineFirst.outlineHash)).status).toBe(200);
    const outlineList = await (await fetch(`${url}/api/history/ch-0001?kind=outline`)).json() as { versions: Array<{ id: string }> };
    const oldOutline = outlineList.versions.find((entry) => entry.id !== "current");
    if (oldOutline === undefined) throw new Error("旧细纲未进入版本历史");
    const outlinePreview = await (await fetch(`${url}/api/history/ch-0001/${oldOutline.id}?kind=outline`)).json() as { currentHash: string };
    expect((await restore("outline", outlinePreview.currentHash, `${url}/api/history/ch-0001/${oldOutline.id}/restore`)).status).toBe(200);
    const outlineRestored = await (await fetch(chapterUrl)).json() as { outline: { title: string } };
    expect(outlineRestored.outline.title).toBe("旧细纲");
  });
});
