/* 轻译 LightTrans — content script
 * 1) 划词翻译：选中文本出现触发按钮，点击弹出流式翻译卡片（Shadow DOM 隔离样式）
 * 2) 整页双语翻译：切分可译块 -> 后台批量翻译 -> 译文插入原文下方
 */
(() => {
  if (window.__ltLoaded) return;
  window.__ltLoaded = true;

  const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  const detectTarget = (text) => (HAS_CJK.test(text) ? "en" : "zh");
  const dirLabel = (target) => (target === "en" ? "中 → EN" : "EN → 中");

  const MAX_SELECTION_LEN = 6000;

  /* ================= Shadow DOM UI ================= */

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .lt-trigger {
      position: absolute;
      z-index: 2147483646;
      width: 27px; height: 27px;
      border: none; border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      font: 600 13px/27px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      text-align: center;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(99, 102, 241, .45), 0 1px 2px rgba(0,0,0,.15);
      user-select: none;
      opacity: 0;
      transform: scale(.6);
      transition: opacity .12s ease, transform .12s cubic-bezier(.34,1.56,.64,1);
    }
    .lt-trigger.lt-show { opacity: 1; transform: scale(1); }
    .lt-trigger:hover { transform: scale(1.12); box-shadow: 0 3px 12px rgba(99,102,241,.55); }

    .lt-card {
      position: absolute;
      z-index: 2147483647;
      min-width: 280px;
      max-width: 420px;
      border-radius: 14px;
      background: rgba(255, 255, 255, .98);
      color: #1f2328;
      box-shadow: 0 12px 40px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.05);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", sans-serif;
      opacity: 0;
      transform: translateY(6px) scale(.98);
      transition: opacity .15s ease, transform .15s cubic-bezier(.22,1,.36,1);
      overflow: hidden;
    }
    .lt-card.lt-show { opacity: 1; transform: translateY(0) scale(1); }

    .lt-head {
      display: flex; align-items: center; gap: 8px;
      padding: 9px 10px 9px 13px;
      cursor: grab;
      border-bottom: 1px solid rgba(0,0,0,.06);
      background: linear-gradient(to bottom, rgba(99,102,241,.05), transparent);
    }
    .lt-head:active { cursor: grabbing; }
    .lt-badge {
      font-size: 11px; font-weight: 600;
      color: #6366f1;
      background: rgba(99,102,241,.1);
      border-radius: 6px;
      padding: 3px 8px;
      letter-spacing: .3px;
      white-space: nowrap;
    }
    .lt-title { font-size: 12px; color: #8b8f98; flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lt-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px;
      border: none; border-radius: 7px;
      background: transparent; color: #7c828d;
      cursor: pointer;
      transition: background .12s, color .12s;
      flex: none;
    }
    .lt-btn:hover { background: rgba(0,0,0,.06); color: #1f2328; }
    .lt-btn svg { width: 15px; height: 15px; }
    .lt-btn.lt-ok { color: #16a34a; }

    .lt-body {
      padding: 12px 14px 13px;
      font-size: 14px;
      line-height: 1.65;
      max-height: 320px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
      overscroll-behavior: contain;
    }
    .lt-body.lt-streaming::after {
      content: "";
      display: inline-block;
      width: 2px; height: 1em;
      margin-left: 2px;
      vertical-align: -0.15em;
      background: #6366f1;
      animation: lt-blink .8s step-end infinite;
    }
    @keyframes lt-blink { 50% { opacity: 0; } }

    .lt-body.lt-loading-dots { color: #9aa0aa; }
    .lt-error { color: #dc2626; font-size: 13px; }
    .lt-error a { color: #6366f1; cursor: pointer; text-decoration: underline; }

    .lt-progress {
      position: fixed;
      right: 18px; bottom: 18px;
      z-index: 2147483647;
      display: flex; align-items: center; gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      background: rgba(28, 28, 32, .88);
      color: #fff;
      font: 500 12.5px/1 -apple-system, "PingFang SC", sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.25);
      backdrop-filter: blur(8px);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .2s, transform .2s;
      pointer-events: none;
    }
    .lt-progress.lt-show { opacity: 1; transform: translateY(0); }
    .lt-spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(255,255,255,.25);
      border-top-color: #a5b4fc;
      border-radius: 50%;
      animation: lt-spin .7s linear infinite;
    }
    @keyframes lt-spin { to { transform: rotate(360deg); } }

    @media (prefers-color-scheme: dark) {
      .lt-card {
        background: rgba(38, 38, 43, .98);
        color: #e6e6ea;
        box-shadow: 0 12px 40px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08);
      }
      .lt-head { border-bottom-color: rgba(255,255,255,.07); }
      .lt-badge { color: #a5b4fc; background: rgba(129,140,248,.15); }
      .lt-btn:hover { background: rgba(255,255,255,.09); color: #fff; }
      .lt-title { color: #7c828d; }
    }
  `;

  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  let host = null;
  let root = null;

  function ensureUi() {
    if (host && host.isConnected) return root;
    host = document.createElement("lt-translator");
    host.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = UI_CSS;
    root.appendChild(style);
    (document.documentElement || document.body).appendChild(host);
    return root;
  }

  const isInHost = (ev) => host && ev.composedPath && ev.composedPath().includes(host);

  /* ---------------- 触发按钮 ---------------- */

  let triggerEl = null;
  let pendingText = "";

  function hideTrigger() {
    if (triggerEl) { triggerEl.remove(); triggerEl = null; }
  }

  function showTrigger(pageX, pageY, text) {
    const ui = ensureUi();
    hideTrigger();
    pendingText = text;
    triggerEl = document.createElement("button");
    triggerEl.className = "lt-trigger";
    triggerEl.textContent = "译";
    triggerEl.style.left = pageX + "px";
    triggerEl.style.top = pageY + "px";
    triggerEl.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    triggerEl.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const x = pageX, y = pageY;
      hideTrigger();
      openCard(x, y, pendingText);
    });
    ui.appendChild(triggerEl);
    requestAnimationFrame(() => triggerEl && triggerEl.classList.add("lt-show"));
  }

  /* ---------------- 翻译卡片 ---------------- */

  let cardEl = null;
  let cardPort = null;

  function closeCard() {
    if (cardPort) { try { cardPort.disconnect(); } catch (e) {} cardPort = null; }
    if (cardEl) { cardEl.remove(); cardEl = null; }
  }

  function clampCardPosition(el, pageX, pageY) {
    const vw = document.documentElement.clientWidth;
    const width = Math.min(420, Math.max(280, el.offsetWidth || 340));
    let x = pageX;
    const maxX = window.scrollX + vw - width - 12;
    if (x > maxX) x = Math.max(window.scrollX + 12, maxX);
    el.style.left = x + "px";
    el.style.top = pageY + "px";
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".lt-btn")) return;
      dragging = true;
      sx = e.pageX; sy = e.pageY;
      ox = parseFloat(el.style.left) || 0;
      oy = parseFloat(el.style.top) || 0;
      e.preventDefault();
      const move = (ev) => {
        if (!dragging) return;
        el.style.left = ox + (ev.pageX - sx) + "px";
        el.style.top = oy + (ev.pageY - sy) + "px";
      };
      const up = () => {
        dragging = false;
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
    });
  }

  function openCard(pageX, pageY, text) {
    const ui = ensureUi();
    closeCard();

    cardEl = document.createElement("div");
    cardEl.className = "lt-card";

    const head = document.createElement("div");
    head.className = "lt-head";
    const badge = document.createElement("span");
    badge.className = "lt-badge";
    badge.textContent = dirLabel(detectTarget(text));
    const title = document.createElement("span");
    title.className = "lt-title";
    title.textContent = text.length > 24 ? text.slice(0, 24) + "…" : text;

    const copyBtn = document.createElement("button");
    copyBtn.className = "lt-btn";
    copyBtn.title = "复制译文";
    copyBtn.innerHTML = ICON_COPY;
    const closeBtn = document.createElement("button");
    closeBtn.className = "lt-btn";
    closeBtn.title = "关闭";
    closeBtn.innerHTML = ICON_CLOSE;
    closeBtn.addEventListener("click", closeCard);

    head.append(badge, title, copyBtn, closeBtn);

    const body = document.createElement("div");
    body.className = "lt-body lt-loading-dots";
    body.textContent = "翻译中…";

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(body.textContent);
        copyBtn.innerHTML = ICON_CHECK;
        copyBtn.classList.add("lt-ok");
        setTimeout(() => { copyBtn.innerHTML = ICON_COPY; copyBtn.classList.remove("lt-ok"); }, 1200);
      } catch (e) { /* 剪贴板不可用 */ }
    });

    cardEl.append(head, body);
    ui.appendChild(cardEl);
    clampCardPosition(cardEl, pageX, pageY);
    makeDraggable(cardEl, head);
    requestAnimationFrame(() => cardEl && cardEl.classList.add("lt-show"));

    /* 开始流式翻译 */
    let full = "";
    let firstChunk = true;
    try {
      cardPort = chrome.runtime.connect({ name: "translate" });
    } catch (e) {
      body.className = "lt-body lt-error";
      body.textContent = "扩展已更新，请刷新页面后重试。";
      return;
    }
    cardPort.onMessage.addListener((msg) => {
      if (!cardEl) return;
      if (msg.type === "meta") {
        badge.textContent = dirLabel(msg.target);
      } else if (msg.type === "chunk") {
        if (firstChunk) {
          firstChunk = false;
          body.textContent = "";
          body.className = "lt-body lt-streaming";
        }
        full += msg.content;
        body.textContent = full;
      } else if (msg.type === "done") {
        body.className = "lt-body";
      } else if (msg.type === "error") {
        body.className = "lt-body lt-error";
        body.textContent = "";
        body.append(msg.message + " ");
        if (msg.needsSetup) {
          const link = document.createElement("a");
          link.textContent = "打开设置";
          link.addEventListener("click", () => {
            try { chrome.runtime.sendMessage({ type: "lt:open-options" }); } catch (e) {}
          });
          body.append(link);
        }
      }
    });
    cardPort.onDisconnect.addListener(() => { cardPort = null; });
    cardPort.postMessage({ type: "start", text, target: "auto" });
  }

  /* ---------------- 划词事件 ---------------- */

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text || text.length > MAX_SELECTION_LEN) return null;
    if (!/\p{L}/u.test(text)) return null;
    const rect = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect();
    return { text, rect };
  }

  document.addEventListener("mouseup", (ev) => {
    if (isInHost(ev)) return;
    /* 等浏览器完成选区更新 */
    setTimeout(() => {
      const info = selectionInfo();
      if (!info) { hideTrigger(); return; }
      let x, y;
      if (info.rect && (info.rect.width > 0 || info.rect.height > 0)) {
        x = window.scrollX + info.rect.right + 5;
        y = window.scrollY + info.rect.bottom + 7;
      } else {
        x = window.scrollX + ev.clientX + 12;
        y = window.scrollY + ev.clientY + 14;
      }
      const vw = document.documentElement.clientWidth;
      if (x > window.scrollX + vw - 40) x = window.scrollX + vw - 40;
      showTrigger(x, y, info.text);
    }, 0);
  }, true);

  document.addEventListener("mousedown", (ev) => {
    if (isInHost(ev)) return;
    hideTrigger();
    if (cardEl) closeCard();
  }, true);

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { hideTrigger(); closeCard(); }
  }, true);

  /* ================= 整页双语翻译 ================= */

  const BLOCK_SELECTOR =
    'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, figcaption, caption, summary, [data-as="p"]';
  const SKIP_ANCESTOR =
    'script, style, code, pre, noscript, svg, math, textarea, input, select, button, ' +
    '[contenteditable=""], [contenteditable="true"], .lt-translation, lt-translator';
  const MAX_PAGE_SEGMENTS = 600;

  const BOLD_TAGS = new Set(["B", "STRONG"]);
  const ITALIC_TAGS = new Set(["I", "EM"]);

  const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function serializeInline(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += escapeText(child.textContent || "");
      } else if (child.nodeType === 1) {
        if (BOLD_TAGS.has(child.tagName)) out += `<b>${serializeInline(child)}</b>`;
        else if (ITALIC_TAGS.has(child.tagName)) out += `<i>${serializeInline(child)}</i>`;
        else out += serializeInline(child);
      }
    });
    return out;
  }

  function isVisible(el) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden";
  }

  let segCounter = 0;

  function segmentPage(root) {
    const blocks = [];
    for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
      if (el.dataset.ltId) continue;
      if (el.closest(SKIP_ANCESTOR)) continue;
      if (el.querySelector(BLOCK_SELECTOR)) continue; /* 只取叶子块 */
      if (!isVisible(el)) continue;
      const text = serializeInline(el).replace(/\s+/g, " ").trim();
      if (!text || !/\p{L}/u.test(text)) continue;
      const id = "s" + segCounter++;
      el.dataset.ltId = id;
      blocks.push({ id, text, node: el });
      if (blocks.length >= MAX_PAGE_SEGMENTS) break;
    }
    return blocks;
  }

  /* ---- 渲染：译文插入原文下方，复制原块排版 ---- */

  const PAGE_STYLE_ID = "lt-page-style";

  function ensurePageStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = PAGE_STYLE_ID;
    style.textContent = `
      .lt-translation { margin-top: .35em; opacity: .94; }
      .lt-translation[data-lt-loading]::after {
        content: "";
        display: inline-block;
        width: .8em; height: .8em;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        opacity: .4;
        animation: lt-page-spin .7s linear infinite;
        vertical-align: -0.1em;
      }
      @keyframes lt-page-spin { to { transform: rotate(360deg); } }
    `;
    document.documentElement.appendChild(style);
  }

  const INHERITED_PROPS = ["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align"];

  function applyInheritedStyles(target, source) {
    const cs = source.ownerDocument.defaultView?.getComputedStyle(source);
    if (!cs) return;
    for (const p of INHERITED_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) target.style.setProperty(p, v, "important");
    }
  }

  function translationNodeOf(original) {
    /* td/th/li 等容器内译文作为最后的子节点；其余作为兄弟节点 */
    const asChild = /^(TD|TH|LI|DD|DT|CAPTION|FIGCAPTION|SUMMARY)$/.test(original.tagName);
    const candidate = asChild ? original.lastElementChild : original.nextElementSibling;
    return candidate && candidate.classList?.contains("lt-translation") ? candidate : null;
  }

  function insertTranslationNode(original) {
    const asChild = /^(TD|TH|LI|DD|DT|CAPTION|FIGCAPTION|SUMMARY)$/.test(original.tagName);
    const el = document.createElement("div");
    el.className = "lt-translation";
    if (asChild) original.appendChild(el);
    else original.insertAdjacentElement("afterend", el);
    applyInheritedStyles(el, original);
    return el;
  }

  const RICH_TAGS = /<(\/?)(b|strong|i|em)\s*>/gi;

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  /* 只认 <b>/<i>/<strong>/<em> 标记，不用 innerHTML，杜绝注入 */
  function setRichText(el, s) {
    el.textContent = "";
    const stack = [el];
    let lastIndex = 0;
    let m;
    RICH_TAGS.lastIndex = 0;
    while ((m = RICH_TAGS.exec(s)) !== null) {
      const chunk = s.slice(lastIndex, m.index);
      if (chunk) stack[stack.length - 1].appendChild(document.createTextNode(decodeEntities(chunk)));
      lastIndex = m.index + m[0].length;
      const closing = m[1] === "/";
      const tag = m[2].toLowerCase();
      if (!closing) {
        const child = document.createElement(tag === "b" || tag === "strong" ? "strong" : "em");
        stack[stack.length - 1].appendChild(child);
        stack.push(child);
      } else if (stack.length > 1) {
        stack.pop();
      }
    }
    const tail = s.slice(lastIndex);
    if (tail) stack[stack.length - 1].appendChild(document.createTextNode(decodeEntities(tail)));
  }

  function renderLoading(original) {
    if (translationNodeOf(original)) return;
    const el = insertTranslationNode(original);
    el.setAttribute("data-lt-loading", "");
  }

  function renderTranslation(original, translation) {
    let el = translationNodeOf(original);
    if (!el) el = insertTranslationNode(original);
    el.removeAttribute("data-lt-loading");
    setRichText(el, translation);
  }

  function clearLoadingNode(original) {
    const el = translationNodeOf(original);
    if (el && el.hasAttribute("data-lt-loading")) el.remove();
  }

  function removeAllTranslations() {
    document.querySelectorAll(".lt-translation").forEach((e) => e.remove());
    document.querySelectorAll("[data-lt-id]").forEach((e) => delete e.dataset.ltId);
    segCounter = 0;
  }

  /* ---- 进度提示 ---- */

  let progressEl = null;

  function showProgress(textContent) {
    const ui = ensureUi();
    if (!progressEl || !progressEl.isConnected) {
      progressEl = document.createElement("div");
      progressEl.className = "lt-progress";
      const spin = document.createElement("span");
      spin.className = "lt-spinner";
      const label = document.createElement("span");
      progressEl.append(spin, label);
      ui.appendChild(progressEl);
      requestAnimationFrame(() => progressEl && progressEl.classList.add("lt-show"));
    }
    progressEl.lastElementChild.textContent = textContent;
  }

  function hideProgress(finalText) {
    if (!progressEl) return;
    const el = progressEl;
    progressEl = null;
    if (finalText) {
      el.firstElementChild.remove();
      el.lastElementChild.textContent = finalText;
      setTimeout(() => { el.classList.remove("lt-show"); setTimeout(() => el.remove(), 250); }, 1400);
    } else {
      el.classList.remove("lt-show");
      setTimeout(() => el.remove(), 250);
    }
  }

  /* ---- 整页翻译控制 ---- */

  let pageState = "idle"; /* idle | translating | shown */
  let pagePort = null;

  function detectPageTarget(blocks) {
    const sample = blocks.slice(0, 80).map((b) => b.text).join(" ");
    const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    return cjk * 2 > latin ? "en" : "zh";
  }

  function startPageTranslate() {
    ensurePageStyle();
    const blocks = segmentPage(document.body);
    if (blocks.length === 0) {
      hideProgress();
      pageState = document.querySelector(".lt-translation") ? "shown" : "idle";
      return;
    }
    const target = detectPageTarget(blocks);
    /* 跳过已是目标语言的段落 */
    const todo = blocks.filter((b) =>
      target === "en" ? HAS_CJK.test(b.text) : /[A-Za-z]/.test(b.text)
    );
    if (todo.length === 0) {
      pageState = "shown";
      hideProgress("没有需要翻译的内容");
      return;
    }

    const byId = new Map(todo.map((b) => [b.id, b]));
    todo.forEach((b) => renderLoading(b.node));
    pageState = "translating";
    showProgress(`翻译中 0/${todo.length}`);

    try {
      pagePort = chrome.runtime.connect({ name: "page-translate" });
    } catch (e) {
      pageState = "idle";
      todo.forEach((b) => clearLoadingNode(b.node));
      hideProgress();
      return;
    }
    pagePort.onMessage.addListener((msg) => {
      if (msg.type === "results") {
        for (const r of msg.results) {
          const block = byId.get(r.id);
          if (!block) continue;
          if (r.translation) renderTranslation(block.node, r.translation);
          else clearLoadingNode(block.node);
        }
      } else if (msg.type === "progress") {
        showProgress(`翻译中 ${msg.done}/${msg.total}`);
      } else if (msg.type === "done") {
        pageState = "shown";
        hideProgress("翻译完成");
        if (pagePort) { try { pagePort.disconnect(); } catch (e) {} pagePort = null; }
      } else if (msg.type === "error") {
        pageState = "idle";
        todo.forEach((b) => clearLoadingNode(b.node));
        hideProgress();
        if (msg.needsSetup) {
          alert("轻译：尚未配置 API Key，请先在扩展设置页填写。");
        }
        if (pagePort) { try { pagePort.disconnect(); } catch (e) {} pagePort = null; }
      }
    });
    pagePort.onDisconnect.addListener(() => {
      pagePort = null;
      if (pageState === "translating") {
        pageState = document.querySelector(".lt-translation:not([data-lt-loading])") ? "shown" : "idle";
        document.querySelectorAll(".lt-translation[data-lt-loading]").forEach((e) => e.remove());
        hideProgress();
      }
    });
    pagePort.postMessage({
      type: "start",
      target,
      segments: todo.map((b) => ({ id: b.id, text: b.text })),
    });
  }

  function togglePageTranslate() {
    if (pageState === "translating") {
      if (pagePort) { try { pagePort.disconnect(); } catch (e) {} pagePort = null; }
      document.querySelectorAll(".lt-translation[data-lt-loading]").forEach((e) => e.remove());
      pageState = document.querySelector(".lt-translation") ? "shown" : "idle";
      hideProgress();
      return pageState;
    }
    if (pageState === "shown") {
      removeAllTranslations();
      pageState = "idle";
      return pageState;
    }
    startPageTranslate();
    return pageState;
  }

  /* ================= 消息入口 ================= */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "lt:translate-selection") {
      const info = selectionInfo();
      if (info) {
        const x = window.scrollX + info.rect.right + 5;
        const y = window.scrollY + info.rect.bottom + 7;
        hideTrigger();
        openCard(x, y, info.text);
      }
      sendResponse({ ok: true });
    } else if (msg.type === "lt:toggle-page") {
      sendResponse({ state: togglePageTranslate() });
    } else if (msg.type === "lt:page-state") {
      sendResponse({ state: pageState });
    }
    return false;
  });
})();
