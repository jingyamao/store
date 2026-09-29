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
});
