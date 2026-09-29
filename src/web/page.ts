/** 写作台的语义结构；样式和交互独立维护。 */
export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f6f3ed">
  <title>novel · 本地写作台</title>
  <link rel="stylesheet" href="/app.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <div class="app-shell" id="appShell">
    <header class="topbar">
      <div class="topbar-left">
        <button class="icon-button mobile-menu" id="menuButton" type="button" aria-label="打开章节列表">☰</button>
        <div class="brand-mark" aria-hidden="true">N<span>.</span></div>
        <div class="brand-copy"><strong>novel</strong><span>本地写作台</span></div>
        <span class="header-divider"></span>
        <div class="header-location" id="headerLocation">尚未选择章节</div>
      </div>
      <div class="topbar-actions">
        <span class="save-indicator" id="saveIndicator" role="status"><span class="indicator-dot"></span><span id="saveLabel">正在载入</span></span>
        <button class="text-button focus-button" id="focusButton" type="button" aria-pressed="false">专注模式</button>
        <button class="icon-button panel-toggle" id="panelButton" type="button" aria-label="打开工作面板">☷</button>
      </div>
    </header>

    <div class="workspace">
      <aside class="navigation" id="navigation" aria-label="章节导航">
        <div class="book-overview">
          <span class="eyebrow">CURRENT PROJECT</span>
          <h1 id="bookTitle">正在载入</h1>
          <p id="bookMeta">你的故事，从这里开始。</p>
          <div class="book-progress"><span id="bookWordCount">0 字</span><span id="bookChapterCount">0 章</span></div>
        </div>
        <div class="nav-section-title"><span>章节目录</span><button id="newChapter" class="square-button" type="button" title="新建章节" aria-label="新建章节">＋</button></div>
        <div id="chapterList" class="chapter-list"></div>
        <div class="nav-bottom"><span class="nav-bottom-mark">✦</span><span>每一章，写得更笃定。</span></div>
      </aside>

      <main class="writing-area" id="writingArea">
        <div class="writing-inner">
          <div class="chapter-heading">
            <div class="eyebrow" id="chapterEyebrow">YOUR MANUSCRIPT</div>
            <h2 id="chapterTitle">开始你的故事</h2>
            <p id="chapterSubtitle">选择左侧章节，或创建一个新章节。</p>
          </div>
          <div class="editor-actions">
            <div class="editor-action-left">
              <button class="button button-primary" id="saveButton" type="button">保存正文</button>
              <button class="button button-quiet" id="reviewButton" type="button">章节体检</button>
              <button class="button button-quiet" id="assistantButton" type="button">AI 助手 <span aria-hidden="true">↗</span></button>
            </div>
            <div class="font-controls" aria-label="正文字号"><button id="smallerFont" type="button" aria-label="缩小正文字号">A−</button><button id="largerFont" type="button" aria-label="放大正文字号">A＋</button></div>
          </div>
          <div class="paper-wrap">
            <div class="paper-rule" aria-hidden="true"></div>
            <textarea id="text" class="manuscript" spellcheck="false" aria-label="章节正文" placeholder="故事从这里开始。\n\n写下第一句，剩下的交给时间。"></textarea>
          </div>
          <div class="writing-footer"><span id="editorMessage">本地自动保存已开启</span><div><span id="wordCount">0 字</span><span class="footer-separator">·</span><span id="targetCount">自由写作</span></div></div>
          <div class="inline-notice" id="inlineNotice" hidden></div>
        </div>
      </main>

      <aside class="inspector" id="inspector" aria-label="工作面板">
        <div class="inspector-heading"><div><span class="eyebrow">YOUR WORKSPACE</span><h2>创作工作台</h2></div><button class="icon-button close-panel" id="closePanel" type="button" aria-label="关闭工作面板">×</button></div>
        <div class="panel-tabs" role="tablist" aria-label="工作面板标签">
          <button type="button" role="tab" data-tab="plan" aria-selected="true">章节计划</button>
          <button type="button" role="tab" data-tab="ai" aria-selected="false">AI 助手</button>
          <button type="button" role="tab" data-tab="search" aria-selected="false">资料检索</button>
          <button type="button" role="tab" data-tab="history" aria-selected="false">版本历史</button>
        </div>
        <div id="panelContent" class="panel-content" role="tabpanel"></div>
      </aside>
    </div>
  </div>

  <dialog id="newChapterDialog" class="dialog small-dialog" aria-labelledby="newChapterHeading">
    <form id="newChapterForm" method="dialog"><button type="button" class="dialog-close" data-close-dialog aria-label="关闭">×</button><span class="eyebrow">NEW CHAPTER</span><h2 id="newChapterHeading">开启新的一章</h2><p>先给这一章一个编号，标题和剧情方向可以稍后在右侧填写。</p><label for="newChapterId">章节编号</label><input id="newChapterId" type="text" required pattern="ch-[0-9]{4,}" autocomplete="off" placeholder="ch-0001"><div class="dialog-actions"><button class="button button-quiet" type="button" data-close-dialog>取消</button><button class="button button-primary" type="submit">创建章节</button></div></form>
  </dialog>

  <dialog id="draftDialog" class="dialog draft-dialog" aria-labelledby="draftHeading">
    <div class="draft-dialog-head"><div><span class="eyebrow">DRAFT REVIEW</span><h2 id="draftHeading">审阅生成初稿</h2><p>确认内容后再采用；采用后仍可在正文中修改。</p></div><button class="dialog-close" type="button" data-close-dialog aria-label="关闭">×</button></div>
    <div id="draftFullText" class="draft-full-text"></div>
    <div class="draft-dialog-footer"><span id="draftRunLabel"></span><div><button class="button button-quiet" type="button" data-close-dialog>继续考虑</button><button class="button button-primary" id="adoptDraft" type="button">采用这版初稿</button></div></div>
  </dialog>

  <div id="toast" class="toast" role="alert" aria-live="polite" hidden></div>
</body>
</html>`;
