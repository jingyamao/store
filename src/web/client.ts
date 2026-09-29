/** 浏览器端交互。所有书籍数据只通过本地 API 读写。 */
export const CLIENT = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const editor = $('text');
  const shell = $('appShell');
  const panel = $('panelContent');
  const store = { book: null, chapters: [], id: null, outline: null, outlineHash: null, hash: null, saved: '', review: null, tab: 'plan', run: null, draft: null, outlineDrafts: {} };
  let saveTimer = null;
  let savePromise = null;
  let toastTimer = null;
  let busy = false;

  function node(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  }
  function message(text, error = false) {
    const box = $('toast');
    box.textContent = text;
    box.className = error ? 'toast error' : 'toast';
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, error ? 6500 : 3300);
  }
  function saveStatus(text, mode = 'saved') {
    $('saveLabel').textContent = text;
    $('saveIndicator').dataset.state = mode;
    $('editorMessage').textContent = text === '已保存' ? '正文已保存在本机' : text;
  }
  async function api(path, method = 'GET', data) {
    const response = await fetch(path, { method, headers: data === undefined ? {} : { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || ('请求失败：' + response.status));
      error.status = response.status;
      throw error;
    }
    return result;
  }
  async function action(button, work) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    try { await work(); }
    catch (error) { message(error.message || String(error), true); if (error.status === 409) saveStatus('保存冲突 · 请检查原文件', 'error'); }
    finally { busy = false; if (button) button.disabled = false; }
  }
  function wordCount(text) { return text.replace(/\s/g, '').length; }
  function updateWords() {
    const words = wordCount(editor.value);
    $('wordCount').textContent = words.toLocaleString('zh-CN') + ' 字';
    const target = store.outline && store.outline.targetWords;
    $('targetCount').textContent = target ? '目标 ' + target.toLocaleString('zh-CN') + ' 字' : '自由写作';
  }
  function dirty() { return store.id !== null && editor.value !== store.saved; }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveEditor().catch((error) => { message(error.message, true); saveStatus('保存失败 · 正文仍在页面', 'error'); }); }, 1300);
  }
  async function saveEditor() {
    clearTimeout(saveTimer);
    if (!store.id || !dirty()) return;
    if (savePromise) {
      await savePromise;
      if (dirty()) return saveEditor();
      return;
    }
    const chapter = store.id;
    const snapshot = editor.value;
    const expected = store.hash;
    saveStatus('正在保存…', 'dirty');
    const operation = api('/api/chapter/' + chapter, 'PUT', { text: snapshot, baseHash: expected });
    savePromise = operation;
    try {
      const result = await operation;
      if (store.id === chapter) {
        store.hash = result.hash;
        store.saved = snapshot;
        saveStatus(dirty() ? '有未保存修改' : '已保存', dirty() ? 'dirty' : 'saved');
        const progress = store.chapters.find((item) => item.id === chapter);
        if (progress) { progress.words = wordCount(snapshot); progress.hasText = snapshot.trim() !== ''; }
        $('bookWordCount').textContent = store.chapters.reduce((sum, item) => sum + item.words, 0).toLocaleString('zh-CN') + ' 字';
        renderChapters();
        if (dirty()) scheduleSave();
      }
    } finally { if (savePromise === operation) savePromise = null; }
  }
  async function flushEditor() {
    clearTimeout(saveTimer);
    while (dirty()) await saveEditor();
    if (savePromise) await savePromise;
  }
  function chapterLabel(item) { return item.title || ('第 ' + item.number + ' 章'); }
  function renderChapters() {
    const list = $('chapterList');
    list.replaceChildren();
    if (!store.chapters.length) {
      list.append(node('div', 'empty-panel', '还没有章节。点击上方的＋开始写作。'));
      return;
    }
    for (const item of store.chapters) {
      const button = node('button', 'chapter-item' + (item.id === store.id ? ' active' : ''));
      button.type = 'button';
      button.setAttribute('aria-current', item.id === store.id ? 'page' : 'false');
      button.append(node('span', 'chapter-number', String(item.number).padStart(2, '0')));
      const copy = node('span', 'chapter-copy');
      copy.append(node('strong', '', chapterLabel(item)));
      copy.append(node('small', '', (item.words ? item.words.toLocaleString('zh-CN') + ' 字' : '尚未开始') + (item.hasSummary ? ' · 已归档' : item.hasText ? ' · 待摘要' : '')));
      button.append(copy, node('span', 'chapter-status' + (item.hasSummary ? ' ready' : item.hasText ? ' needs-summary' : '')));
      button.addEventListener('click', () => action(button, async () => { await openChapter(item.id); shell.classList.remove('nav-open'); }));
      list.append(button);
    }
  }
  async function loadState(selectFirst = false) {
    const data = await api('/api/state');
    store.book = data.book;
    store.chapters = data.chapters;
    store.characters = data.characters || [];
    $('bookTitle').textContent = data.book.title || '未命名小说';
    $('bookWordCount').textContent = store.chapters.reduce((sum, item) => sum + item.words, 0).toLocaleString('zh-CN') + ' 字';
    $('bookChapterCount').textContent = store.chapters.length + ' 章';
    $('bookMeta').textContent = store.chapters.length ? '继续书写你的长篇故事' : '你的故事，从这里开始。';
    renderChapters();
    if (selectFirst && !store.id && store.chapters.length) await openChapter(store.chapters[0].id, true);
    if (selectFirst && !store.chapters.length) { editor.disabled = true; saveStatus('等待创建章节'); renderPanel(); }
  }
  async function openChapter(id, skipFlush = false) {
    editor.disabled = true;
    let data;
    try {
      if (!skipFlush) await flushEditor();
      data = await api('/api/chapter/' + id);
    } catch (error) { editor.disabled = false; throw error; }
    store.id = id;
    store.hash = data.hash;
    store.saved = data.text;
    store.outline = data.outline;
    store.outlineHash = data.outlineHash;
    store.review = null;
    store.run = null;
    store.draft = null;
    store.proposal = null;
    editor.disabled = false;
    editor.value = data.text;
    const item = store.chapters.find((entry) => entry.id === id);
    $('chapterEyebrow').textContent = 'MANUSCRIPT  /  ' + id.toUpperCase();
    $('chapterTitle').textContent = data.outline && data.outline.title ? data.outline.title : (item ? chapterLabel(item) : '第 ' + Number(id.slice(3)) + ' 章');
    $('chapterSubtitle').textContent = data.outline && data.outline.intent ? data.outline.intent : '为这一章写下方向，然后开始创作。';
    $('headerLocation').textContent = (store.book ? store.book.title + ' / ' : '') + $('chapterTitle').textContent;
    saveStatus('已保存');
    $('inlineNotice').hidden = true;
    updateWords();
    renderChapters();
    renderPanel();
    editor.scrollTop = 0;
  }
  function sectionTitle(text) { return node('div', 'section-divider', text); }
  function card(kicker, title, body, variant = '') {
    const box = node('div', 'panel-card' + (variant ? ' ' + variant : ''));
    if (kicker) box.append(node('div', 'card-kicker', kicker));
    if (title) box.append(node('h3', '', title));
    if (body) box.append(node('p', '', body));
    return box;
  }
  function field(form, label, value, kind = 'input', hint = '') {
    const wrap = node('label', 'form-field');
    const title = node('span', '', label);
    if (hint) title.append(node('span', 'field-hint', hint));
    const input = node(kind === 'textarea' ? 'textarea' : 'input', kind === 'textarea' ? 'field-textarea' : 'field-input');
    input.value = value === undefined || value === null ? '' : String(value);
    if (kind === 'textarea') input.rows = 3;
    wrap.append(title, input);
    form.append(wrap);
    return input;
  }
  function renderPlan() {
    panel.append(node('p', 'panel-lead', '写下这一章要发生什么。计划会进入生成上下文，也方便你在写作时随时核对。'));
    if (!store.id) { panel.append(node('div', 'empty-panel', '先创建或选择一个章节。')); return; }
    const outline = store.outlineDrafts[store.id] || store.outline || {};
    const form = node('form', 'panel-card outline-form');
    form.append(node('div', 'card-kicker', 'CHAPTER OUTLINE'), node('h3', '', store.outline ? '本章细纲' : '建立本章细纲'));
    const title = field(form, '章节标题', outline.title || '', 'input', '可稍后再定');
    const intent = field(form, '本章目标', outline.intent || '', 'textarea', '这一章要推动什么？');
    const conflict = field(form, '核心冲突', outline.conflict || '', 'textarea', '谁想要什么，阻力是什么？');
    const target = field(form, '目标字数', outline.targetWords || '', 'input', '可留空');
    target.type = 'number'; target.min = '1'; target.placeholder = '例如 3000';
    const cast = node('div', 'form-field');
    cast.append(node('span', '', '出场人物'));
    const castRow = node('div', 'chip-row');
    for (const character of (store.characters || [])) {
      const chip = node('label', 'cast-chip');
      const input = node('input'); input.type = 'checkbox'; input.value = character.id; input.checked = (outline.cast || []).includes(character.id);
      chip.append(input, node('span', '', character.name || character.id)); castRow.append(chip);
    }
    if (!castRow.children.length) castRow.append(node('span', 'micro-copy', '尚未创建人物。可先写目标和冲突。'));
    cast.append(castRow); form.append(cast);
    const readFields = () => ({ title: title.value.trim(), intent: intent.value.trim(), conflict: conflict.value.trim(), cast: [...castRow.querySelectorAll('input:checked')].map((input) => input.value), targetWords: target.value ? Number(target.value) : null });
    form.addEventListener('input', () => { store.outlineDrafts[store.id] = readFields(); });
    form.addEventListener('change', () => { store.outlineDrafts[store.id] = readFields(); });
    const actions = node('div', 'form-actions'); actions.append(node('span', 'micro-copy', '保存后即可生成开篇'));
    const submit = node('button', 'button button-primary', '保存细纲'); submit.type = 'submit'; actions.append(submit); form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      action(submit, async () => {
        const chapter = store.id;
        const submitted = readFields();
        const result = await api('/api/outline/' + chapter, 'PATCH', { ...submitted, baseHash: store.outlineHash });
        const updated = result.outline;
        store.outline = updated;
        store.outlineHash = result.hash;
        if (JSON.stringify(store.outlineDrafts[chapter]) === JSON.stringify(submitted)) delete store.outlineDrafts[chapter];
        $('chapterTitle').textContent = updated.title || ('第 ' + Number(store.id.slice(3)) + ' 章');
        $('chapterSubtitle').textContent = updated.intent || '为这一章写下方向，然后开始创作。';
        $('headerLocation').textContent = store.book.title + ' / ' + $('chapterTitle').textContent;
        updateWords(); await loadState(); renderPlanFresh(); message('章节计划已保存');
      });
    });
    panel.append(form);
    panel.append(sectionTitle('正文检查'));
    const review = card('QUALITY CHECK', '让本章更稳妥', '查看字数、对白比例和潜在的一致性问题。', 'warm');
    const button = node('button', 'button button-quiet', store.review ? '重新检查' : '运行章节体检');
    button.type = 'button'; button.addEventListener('click', () => action(button, runReview)); review.append(button); panel.append(review);
    if (store.review) showReviewFindings(store.review);
  }
  function renderPlanFresh() { if (store.tab === 'plan') { panel.replaceChildren(); renderPlan(); } }
  function showReviewFindings(result) {
    const summary = card('REVIEW RESULT', '本章体检', result.metrics.words + ' 字 · ' + result.metrics.paragraphs + ' 段 · 对白 ' + Math.round(result.metrics.dialogueRatio * 100) + '%');
    panel.append(summary);
    if (!result.findings.length) panel.append(card('', '检查完成', '没有发现规则问题。', 'accent'));
    for (const finding of result.findings) {
      const issue = node('div', 'issue ' + (finding.level || 'warn'), (finding.line ? '第 ' + finding.line + ' 行 · ' : '') + finding.message);
      panel.append(issue);
    }
  }
  async function runReview() {
    if (!store.id) throw new Error('先选择章节');
    await flushEditor();
    store.review = await api('/api/review/' + store.id);
    showTab('plan');
    message(store.review.findings.length ? '体检完成：' + store.review.findings.length + ' 条提示' : '体检完成，没有发现规则问题');
  }
  function renderAi() {
    if (!store.id) { panel.append(node('div', 'empty-panel', '选择章节后即可使用 AI 助手。')); return; }
    if (store.run && store.run.openings && !store.run.draft) { renderOpenings(store.run); return; }
    if (store.run && store.run.draft) { renderDraft(store.run); return; }
    if (store.proposal) { renderProposal(store.proposal); return; }
    const guide = card('THE WRITING FLOW', '从想法到定稿', '', 'accent');
    const steps = node('div', 'step-list');
    for (const [number, title, detail] of [['01', '确定章节方向', '先在「章节计划」写下目标与冲突。'], ['02', '挑选开篇', '生成不同切入点，由你选择。'], ['03', '审阅初稿', '先看全文，确认后再采用到正文。']]) {
      const step = node('div', 'step');
      step.append(node('span', 'step-number', number));
      const copy = node('div'); copy.append(node('strong', '', title), node('p', '', detail)); step.append(copy); steps.append(step);
    }
    guide.append(steps);
    const actions = node('div', 'action-grid');
    const agent = node('button', 'button button-primary', 'Agent 写初稿'); agent.type = 'button'; agent.addEventListener('click', () => action(agent, generateAgentDraft));
    const openings = node('button', 'button', '生成开篇'); openings.type = 'button'; openings.addEventListener('click', () => action(openings, generateOpenings));
    const sync = node('button', 'button', '提取状态'); sync.type = 'button'; sync.addEventListener('click', () => action(sync, extractState));
    actions.append(agent, openings, sync); guide.append(actions); panel.append(guide);
    if (!store.outline || !store.outline.intent.trim()) {
      const hint = card('BEFORE GENERATING', '先补充本章目标', '生成开篇需要明确的剧情方向。填写章节计划后，再回来开始。', 'warm');
      const jump = node('button', 'helper-link', '去填写章节计划 →'); jump.onclick = () => showTab('plan'); hint.append(jump); panel.append(hint);
    }
    panel.append(sectionTitle('最近生成'));
    const runs = node('div'); runs.id = 'runList'; runs.append(node('p', 'panel-lead', '正在载入生成记录…')); panel.append(runs);
    loadRuns(runs, store.id).catch((error) => { runs.replaceChildren(node('p', 'panel-lead', error.message)); });
  }
  async function loadRuns(container, chapter) {
    const runs = (await api('/api/runs')).filter((run) => run.chapterId === chapter && !run.dryRun).slice(0, 8);
    if (store.id !== chapter || !container.isConnected) return;
    container.replaceChildren();
    if (!runs.length) { container.append(node('div', 'empty-panel', '这一章还没有生成记录。')); return; }
    for (const run of runs) {
      const item = node('button', 'run-item'); item.type = 'button';
      item.append(node('strong', '', run.hasDraft ? '已生成初稿' : '开篇待选择'));
      item.append(node('span', '', run.runId + (run.applied ? ' · 已采用' : ' · 待审阅')));
      item.onclick = () => action(item, async () => { const detail = await api('/api/run/' + encodeURIComponent(run.runId)); store.run = { id: run.runId, openings: detail.openings, draft: detail.draft, applied: detail.record.applied, findings: detail.record.draftCheck || [], warnings: detail.record.warnings || [], usage: detail.record.usage, agentPlan: detail.agentPlan, memorySources: detail.memorySources }; renderPanel(); });
      container.append(item);
    }
  }
  async function generateOpenings() {
    if (!store.id) throw new Error('先选择章节');
    if (!store.outline || !store.outline.intent.trim()) { showTab('plan'); throw new Error('请先填写本章目标并保存细纲'); }
    await flushEditor();
    message('正在生成开篇，请稍候…');
    const result = await api('/api/generate', 'POST', { chapter: store.id, openingsOnly: true });
    store.proposal = null;
    store.run = { id: result.run, openings: result.openings, draft: null, applied: false, findings: [] };
    renderPanel();
    message('开篇已生成，选一版继续写');
  }
  async function generateAgentDraft() {
    if (!store.id) throw new Error('先选择章节');
    if (!store.outline || !store.outline.intent.trim()) { showTab('plan'); throw new Error('请先填写本章目标并保存细纲'); }
    await flushEditor();
    message('Agent 正在检索旧章节、规划场景并写作，请稍候…');
    const result = await api('/api/agent/write', 'POST', { chapter: store.id });
    store.proposal = null;
    store.run = { id: result.run, openings: [], draft: result.draft, applied: false, findings: result.findings || [], warnings: result.warnings || [], usage: result.usage, agentPlan: result.agentPlan, memorySources: result.memorySources };
    renderPanel();
    message('Agent 初稿已生成，请审阅后采用');
  }
  function renderOpenings(run) {
    panel.append(node('p', 'panel-lead', '开篇已经保存。挑选最符合本章方向的一版，再让 AI 续写初稿。'));
    const back = node('button', 'helper-link', '← 返回 AI 助手'); back.onclick = () => { store.run = null; renderPanel(); }; panel.append(back);
    panel.append(sectionTitle('选择开篇 · ' + run.openings.length + ' 个方案'));
    run.openings.forEach((opening, index) => {
      const box = node('div', 'opening-card'); box.append(node('strong', '', '方案 ' + String(index + 1).padStart(2, '0')), node('p', '', opening));
      const button = node('button', 'button button-primary', '选这版，生成初稿'); button.type = 'button';
      button.onclick = () => action(button, async () => {
        message('正在续写初稿，请稍候…');
        const result = await api('/api/generate', 'POST', { chapter: store.id, fromRun: run.id, pick: index + 1 });
        store.run = { id: result.run, openings: result.openings, draft: result.draft, applied: false, findings: result.findings || [] };
        renderPanel(); message('初稿已生成，请审阅后采用');
      });
      box.append(button); panel.append(box);
    });
  }
  function renderDraft(run) {
    panel.append(node('p', 'panel-lead', '初稿仍保存在生成记录中。先审阅全文，再决定是否采用。'));
    if (run.usage) panel.append(node('p', 'micro-copy', '本次生成：' + ((run.usage.promptTokens || 0) + (run.usage.completionTokens || 0)).toLocaleString('zh-CN') + ' token'));
    if (run.agentPlan) {
      const detail = node('details', 'memory-detail');
      detail.append(node('summary', '', '查看 Agent 场景计划与历史证据'));
      detail.append(node('pre', 'agent-plan', run.agentPlan));
      if (run.memorySources && run.memorySources.length) detail.append(node('p', 'micro-copy', '历史证据：' + run.memorySources.join('、')));
      panel.append(detail);
    }
    for (const warning of run.warnings || []) panel.append(node('div', 'issue warn', warning));
    const box = card('DRAFT IS READY', run.applied ? '这版初稿已采用' : '初稿等待你审阅', (run.draft || '').slice(0, 180) + ((run.draft || '').length > 180 ? '…' : ''), 'accent');
    const review = node('button', 'button button-primary', '展开阅读全文'); review.type = 'button'; review.onclick = () => openDraft(run); box.append(review); panel.append(box);
    for (const finding of run.findings || []) panel.append(node('div', 'issue ' + finding.level, finding.message));
    const back = node('button', 'helper-link', '← 返回 AI 助手'); back.onclick = () => { store.run = null; renderPanel(); }; panel.append(back);
  }
  function openDraft(run) {
    store.run = run;
    $('draftFullText').textContent = run.draft || '';
    $('draftRunLabel').textContent = '生成记录 ' + run.id;
    $('adoptDraft').disabled = run.applied;
    $('adoptDraft').textContent = run.applied ? '已采用' : '采用这版初稿';
    $('draftDialog').showModal();
  }
  async function adoptDraft() {
    if (!store.run) throw new Error('没有可采用的初稿');
    editor.disabled = true;
    try {
      await flushEditor();
      await api('/api/adopt', 'POST', { run: store.run.id, baseHash: store.hash });
      store.run.applied = true;
      $('draftDialog').close();
      await loadState();
      await openChapter(store.id, true);
      showTab('ai');
      message('已采用初稿。现在可以继续修改正文。');
    } finally { editor.disabled = false; }
  }
  async function extractState() {
    if (!store.id) throw new Error('先选择章节');
    await flushEditor();
    let proposal;
    try { proposal = await api('/api/proposal/' + store.id); }
    catch (error) {
      if (error.status !== 404) throw error;
      message('正在提取状态变化，请稍候…');
      proposal = await api('/api/proposal/' + store.id, 'POST');
    }
    store.run = null; store.proposal = proposal; renderPanel();
  }
  function renderProposal(proposal) {
    panel.append(node('p', 'panel-lead', '只有勾选并应用的内容才会写回长期设定。请逐项核对正文依据。'));
    const back = node('button', 'helper-link', '← 返回 AI 助手'); back.onclick = () => { store.proposal = null; renderPanel(); }; panel.append(back);
    const refresh = node('button', 'helper-link', '正文改过了？重新提取当前状态 ↻');
    refresh.type = 'button';
    refresh.onclick = () => action(refresh, async () => {
      await flushEditor();
      store.proposal = await api('/api/proposal/' + proposal.chapter, 'POST', { force: true });
      renderPanel(); message('已根据当前正文重新提取提案');
    });
    panel.append(refresh);
    panel.append(card('CHAPTER SUMMARY', '章节摘要', proposal.summary, 'warm'));
    const selected = [];
    if (proposal.changes.length) panel.append(sectionTitle('状态变化 · ' + proposal.changes.length + ' 项'));
    for (const [index, change] of proposal.changes.entries()) {
      const line = node('label', 'proposal-change');
      const check = node('input'); check.type = 'checkbox'; check.value = String(index + 1); check.disabled = (proposal.applied || []).includes(index + 1);
      const text = node('span'); text.append(node('strong', '', (index + 1) + '. ' + change.id + ' · ' + change.field + (check.disabled ? ' · 已应用' : '')));
      text.append(node('small', '', JSON.stringify(change.before) + ' → ' + JSON.stringify(change.after) + '\n依据：' + change.evidence));
      line.append(check, text); panel.append(line); selected.push(check);
    }
    const summaryLabel = node('label', 'proposal-summary');
    const summary = node('input'); summary.type = 'checkbox'; summary.disabled = proposal.summaryApplied;
    summaryLabel.append(summary, node('span', '', proposal.summaryApplied ? '章节摘要已确认' : '同时采用章节摘要')); panel.append(summaryLabel);
    const button = node('button', 'button button-primary', '应用勾选内容'); button.type = 'button';
    button.onclick = () => action(button, async () => {
      const accept = selected.filter((input) => input.checked).map((input) => Number(input.value));
      if (!accept.length && !summary.checked) throw new Error('请先勾选至少一项变化或章节摘要');
      await api('/api/apply/' + proposal.chapter, 'POST', { accept, summary: summary.checked });
      store.proposal = await api('/api/proposal/' + proposal.chapter);
      await loadState(); renderPanel(); message('已写回确认的状态');
    });
    panel.append(button);
  }
  function renderSearch() {
    panel.append(node('p', 'panel-lead', '查找人物、物品、伏笔或已经写过的情节。结果可直接跳转到对应章节。'));
    const bar = node('form', 'search-bar');
    const input = node('input', 'search-input'); input.type = 'search'; input.placeholder = '例如：断岳刀的裂痕'; input.setAttribute('aria-label', '搜索小说资料');
    const button = node('button', 'button button-primary', '搜索'); button.type = 'submit'; bar.append(input, button); panel.append(bar);
    panel.append(node('p', 'micro-copy', '检索时会自动更新本地索引。'));
    const results = node('div'); results.id = 'searchResults'; panel.append(results);
    bar.onsubmit = (event) => { event.preventDefault(); action(button, async () => {
      const query = input.value.trim(); if (!query) return;
      results.replaceChildren(node('p', 'panel-lead', '正在检索…'));
      const hits = await api('/api/search?q=' + encodeURIComponent(query));
      results.replaceChildren(sectionTitle('检索结果 · ' + hits.length));
      if (!hits.length) results.append(node('div', 'empty-panel', '没有找到相关内容。试试更具体的人名或物品名。'));
      for (const hit of hits) {
        const item = node(hit.chapter ? 'button' : 'div', 'search-hit');
        if (hit.chapter) { item.type = 'button'; item.onclick = () => action(item, async () => { await openChapter(hit.chapter); showTab('search'); }); }
        item.append(node('strong', '', hit.chapter ? hit.chapter + ' · ' + hit.source : hit.source));
        item.append(node('p', '', hit.snippet)); results.append(item);
      }
    }); };
  }
  function renderPanel() {
    panel.replaceChildren();
    if (store.tab === 'plan') renderPlan();
    else if (store.tab === 'ai') renderAi();
    else renderSearch();
  }
  function showTab(tab) {
    if (shell.classList.contains('focus-mode')) {
      shell.classList.remove('focus-mode');
      $('focusButton').setAttribute('aria-pressed', 'false');
      $('focusButton').textContent = '专注模式';
      localStorage.setItem('novel-focus', 'false');
    }
    store.tab = tab;
    for (const button of document.querySelectorAll('[data-tab]')) button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    shell.classList.add('panel-open'); shell.classList.remove('nav-open');
    renderPanel();
  }
  function nextChapterId() {
    const max = store.chapters.reduce((value, item) => Math.max(value, item.number), 0);
    return 'ch-' + String(max + 1).padStart(4, '0');
  }
  async function createChapter(id) {
    if (!/^ch-\d{4,}$/.test(id)) throw new Error('章节编号应为 ch-0001 这样的格式');
    if (store.chapters.some((item) => item.id === id)) throw new Error('章节已存在，请换一个编号');
    editor.disabled = true;
    try {
      await flushEditor();
      const existing = await api('/api/chapter/' + id);
      if (existing.text.trim() || existing.outline) throw new Error('这个章节已存在');
      await api('/api/outline/' + id, 'PATCH', { baseHash: existing.outlineHash, title: '', intent: '', conflict: '', cast: [], targetWords: null });
      await loadState(); await openChapter(id, true); showTab('plan');
      $('newChapterDialog').close(); editor.focus(); message('新章节已创建，先写下本章目标吧');
    } finally { editor.disabled = false; }
  }

  editor.addEventListener('input', () => { if (!store.id) return; updateWords(); saveStatus('有未保存修改', 'dirty'); scheduleSave(); });
  $('saveButton').onclick = () => action($('saveButton'), async () => { await flushEditor(); message('正文已保存'); });
  $('reviewButton').onclick = () => action($('reviewButton'), runReview);
  $('assistantButton').onclick = () => showTab('ai');
  $('newChapter').onclick = () => { $('newChapterId').value = nextChapterId(); $('newChapterDialog').showModal(); $('newChapterId').focus(); };
  $('newChapterForm').onsubmit = (event) => { event.preventDefault(); action(event.submitter, () => createChapter($('newChapterId').value.trim())); };
  $('adoptDraft').onclick = () => action($('adoptDraft'), adoptDraft);
  for (const button of document.querySelectorAll('[data-close-dialog]')) button.onclick = () => button.closest('dialog').close();
  for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => showTab(button.dataset.tab);
  $('panelButton').onclick = () => { shell.classList.toggle('panel-open'); shell.classList.remove('nav-open'); };
  $('closePanel').onclick = () => shell.classList.remove('panel-open');
  $('menuButton').onclick = () => { shell.classList.toggle('nav-open'); shell.classList.remove('panel-open'); };
  $('focusButton').onclick = () => { const enabled = shell.classList.toggle('focus-mode'); $('focusButton').setAttribute('aria-pressed', String(enabled)); $('focusButton').textContent = enabled ? '退出专注' : '专注模式'; localStorage.setItem('novel-focus', String(enabled)); };
  let fontSize = Number(localStorage.getItem('novel-font-size')) || 18;
  function setFontSize(value) { fontSize = Math.min(24, Math.max(15, value)); document.documentElement.style.setProperty('--manuscript-size', fontSize + 'px'); localStorage.setItem('novel-font-size', String(fontSize)); }
  $('smallerFont').onclick = () => setFontSize(fontSize - 1); $('largerFont').onclick = () => setFontSize(fontSize + 1); setFontSize(fontSize);
  if (localStorage.getItem('novel-focus') === 'true') { shell.classList.add('focus-mode'); $('focusButton').setAttribute('aria-pressed', 'true'); $('focusButton').textContent = '退出专注'; }
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); action($('saveButton'), async () => { await flushEditor(); message('正文已保存'); }); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showTab('search'); panel.querySelector('input[type=search]')?.focus(); }
    if (event.key === 'Escape') { shell.classList.remove('nav-open', 'panel-open'); }
  });
  window.addEventListener('beforeunload', (event) => { if (dirty() || Object.keys(store.outlineDrafts).length) { event.preventDefault(); event.returnValue = ''; } });
  loadState(true).catch((error) => { message(error.message, true); saveStatus('载入失败', 'error'); });
})();
`;
