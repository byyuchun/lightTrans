/* 轻译 LightTrans — PDF 双语阅读器
 * 左侧 pdf.js 原样渲染（懒渲染 + 远离视口释放内存），右侧逐段译文（按页懒翻译）。
 * 文本抽取管线：行聚合 -> 栏缝探测（支持混合版式/基线错位）-> 阅读顺序还原
 *   -> 段落合并（缩进/行距/字号/续接启发式）-> 跨页段落缝合。
 * 在真实双栏期刊论文上校准过的启发式，改动前请先用实际 PDF 验证。
 */
import { getDocument, GlobalWorkerOptions } from "./pdfjs/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

let pdfDoc = null;
let target = "zh";
let targetDecided = false;
const pages = new Map();

/* ================= 打开文件 ================= */

function showBanner(text, ms = 4000) {
  const el = $("banner");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showBanner._t);
  if (ms > 0) showBanner._t = setTimeout(() => el.classList.add("hidden"), ms);
}

async function openFromUrl(url) {
  showBanner("正在下载 PDF…", 0);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    $("banner").classList.add("hidden");
    await loadPdf(data, decodeURIComponent(url.split("/").pop() || "文档").split("?")[0]);
  } catch (e) {
    showBanner(`下载失败：${e.message}。可将文件下载到本地后用「打开文件」`, 8000);
  }
}

async function openFromFile(file) {
  const data = await file.arrayBuffer();
  await loadPdf(data, file.name);
}

async function loadPdf(data, name) {
  try {
    pdfDoc = await getDocument({ data }).promise;
  } catch (e) {
    showBanner(`无法解析 PDF：${e.message}`, 6000);
    return;
  }
  targetDecided = false;
  $("doc-name").textContent = name || "";
  document.title = `${name || "PDF"} · 轻译`;
  $("empty").classList.add("hidden");
  $("doc").classList.remove("hidden");
  $("btn-mode").classList.remove("hidden");
  $("page-info").textContent = `共 ${pdfDoc.numPages} 页`;
  await buildPages();
}

/* ================= 页面骨架与懒加载 ================= */

const NEAR = 1400;

async function buildPages() {
  const doc = $("doc");
  doc.textContent = "";
  pages.clear();

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });

    const row = document.createElement("div");
    row.className = "page-row";
    row.dataset.page = n;

    const left = document.createElement("div");
    left.className = "page-left";
    const num = document.createElement("span");
    num.className = "page-num";
    num.textContent = String(n);
    left.appendChild(num);
    left.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

    const right = document.createElement("div");
    right.className = "page-right";

    row.append(left, right);
    doc.appendChild(row);
    pages.set(n, {
      page, row, left, right, viewport,
      rendered: false, translated: false,
      extractPromise: null, stitchComputed: false,
      paras: [], canvas: null,
    });
  }

  const io = new IntersectionObserver(onVisibility, { rootMargin: `${NEAR}px 0px` });
  pages.forEach((p) => io.observe(p.row));
}

function onVisibility(entries) {
  for (const entry of entries) {
    const n = Number(entry.target.dataset.page);
    const p = pages.get(n);
    if (!p) continue;
    if (entry.isIntersecting) {
      renderPage(p);
      translatePage(n, p);
    } else {
      releaseCanvas(p);
    }
  }
}

async function renderPage(p) {
  if (p.rendered) return;
  p.rendered = true;
  const cssWidth = p.left.clientWidth || 700;
  const scale = (cssWidth / p.viewport.width) * Math.min(window.devicePixelRatio || 1, 2);
  const vp = p.page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  try {
    await p.page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  } catch (e) {
    p.rendered = false;
    return;
  }
  if (!p.rendered) return;
  p.canvas = canvas;
  p.left.appendChild(canvas);
}

function releaseCanvas(p) {
  if (!p.rendered) return;
  p.rendered = false;
  if (p.canvas) {
    p.canvas.remove();
    p.canvas.width = 0;
    p.canvas.height = 0;
    p.canvas = null;
  }
}

/* ================= 文本抽取：行 -> 栏 -> 段落 ================= */

function buildRows(items) {
  const frags = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height || Math.abs(it.transform[3]) || 10,
    }));
  frags.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const f of frags) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - f.y) < Math.max(2, last.h * 0.45)) {
      last.frags.push(f);
      last.h = Math.max(last.h, f.h);
    } else {
      rows.push({ y: f.y, h: f.h, frags: [f] });
    }
  }
  return rows;
}

/* 单行在某 gx 处的状态：
 * blocked=文字穿越 / open=左右都有且留空 / left|right=整行只在一侧（栏基线错位时的常态） */
function rowStatusAt(row, gx) {
  if (row.frags.some((fr) => fr.x < gx && fr.x + fr.w > gx)) return "blocked";
  const leftX1 = Math.max(...row.frags.filter((fr) => fr.x + fr.w <= gx).map((fr) => fr.x + fr.w), -1);
  const rightX0 = Math.min(...row.frags.filter((fr) => fr.x >= gx).map((fr) => fr.x), Infinity);
  const hasLeft = leftX1 > 0;
  const hasRight = rightX0 < Infinity;
  if (hasLeft && hasRight) return rightX0 - leftX1 > 3 ? "open" : "blocked";
  return hasLeft ? "left" : "right";
}

/* 栏缝探测：找一条大量行留空/单侧、几乎无文字穿越的垂直带。
 * 支持混合版式（上半单栏、下半双栏）与左右栏基线错位。 */
function detectGutter(rows, pageWidth) {
  let best = null;
  for (let gx = pageWidth * 0.36; gx <= pageWidth * 0.64; gx += 2) {
    let open = 0, left = 0, right = 0;
    const statuses = rows.map((row) => rowStatusAt(row, gx));
    for (const s of statuses) {
      if (s === "open") open++;
      else if (s === "left") left++;
      else if (s === "right") right++;
    }
    const score = open + Math.min(left, right);
    if (!best || score > best.score) best = { gx, score, statuses };
  }
  if (!best || best.score < Math.max(6, rows.length * 0.2)) return null;

  /* 剔除孤立证据行（页眉等偶然留空），再要求证据纵向跨度内证据占多数 */
  const isEvidence = (s) => s === "open" || s === "left" || s === "right";
  const idx = [];
  best.statuses.forEach((s, i) => { if (isEvidence(s)) idx.push(i); });
  const clustered = idx.filter((i, k) =>
    (k > 0 && i - idx[k - 1] <= 3) || (k < idx.length - 1 && idx[k + 1] - i <= 3)
  );
  if (clustered.length < Math.max(6, rows.length * 0.2)) return null;
  let good = 0, bad = 0;
  for (let i = clustered[0]; i <= clustered[clustered.length - 1]; i++) {
    if (isEvidence(best.statuses[i])) good++;
    else bad++;
  }
  return good >= (good + bad) * 0.6 ? best.gx : null;
}

function fragsToLine(frags) {
  frags.sort((a, b) => a.x - b.x);
  let text = "";
  let x1 = null;
  let h = 0;
  for (const f of frags) {
    if (text) {
      const gap = f.x - x1;
      text += gap > h * 0.18 && !text.endsWith(" ") ? " " : "";
    }
    text += f.text;
    x1 = Math.max(x1 ?? -1, f.x + f.w);
    h = Math.max(h, f.h);
  }
  return { text, x0: frags[0].x, x1, y: frags[0].y, h };
}

function rowsToLines(rows, gutterX) {
  const lines = [];
  for (const row of rows) {
    if (gutterX == null) {
      const line = fragsToLine(row.frags);
      line.col = "F";
      lines.push(line);
      continue;
    }
    const covered = row.frags.some((fr) => fr.x < gutterX && fr.x + fr.w > gutterX);
    const leftFrags = row.frags.filter((fr) => fr.x + fr.w <= gutterX);
    const rightFrags = row.frags.filter((fr) => fr.x >= gutterX);
    const leftX1 = Math.max(...leftFrags.map((fr) => fr.x + fr.w), -1);
    const rightX0 = Math.min(...rightFrags.map((fr) => fr.x), Infinity);
    const splittable = !covered && leftFrags.length && rightFrags.length && rightX0 - leftX1 > 3;
    if (splittable) {
      const l = fragsToLine(leftFrags);
      l.col = "L";
      const r = fragsToLine(rightFrags);
      r.col = "R";
      lines.push(l, r);
    } else {
      const line = fragsToLine(row.frags);
      line.col = line.x1 <= gutterX ? "L" : line.x0 >= gutterX ? "R" : "F";
      lines.push(line);
    }
  }
  const bounds = {};
  for (const c of ["L", "R", "F"]) {
    const cl = lines.filter((l) => l.col === c);
    if (cl.length) {
      bounds[c] = {
        x0: Math.min(...cl.map((l) => l.x0)),
        x1: Math.max(...cl.map((l) => l.x1)),
      };
    }
  }
  for (const l of lines) {
    l.cx0 = bounds[l.col].x0;
    l.cx1 = bounds[l.col].x1;
  }
  return lines;
}

/* 阅读顺序：宽行做分隔，左栏 -> 右栏 */
function orderByColumns(lines) {
  const ordered = [];
  let leftBuf = [];
  let rightBuf = [];
  const flush = () => { ordered.push(...leftBuf, ...rightBuf); leftBuf = []; rightBuf = []; };
  for (const line of lines) {
    if (line.col === "F") { flush(); ordered.push(line); }
    else if (line.col === "L") leftBuf.push(line);
    else rightBuf.push(line);
  }
  flush();
  return ordered;
}

const endsSentence = (t) => /[.。!?！？…:：;；]["')\]]?$/.test(t.trim());
/* 编号式标题："2. Data and methods" / "a. Datasets" / "IV. Results" */
const isHeading = (t) => /^(\d+|[a-z]|[ivxlc]+)[.)]\s/i.test(t.trim());
/* 跨栏/跨旁注/跨页的句子续接判断：上文未完 + 下文像句中续写 */
function continues(prevText, nextText) {
  const p = prevText.trim();
  if (endsSentence(p) || isHeading(p)) return false;
  return /^[a-z(（]/.test(nextText) || /[a-z][,;、，；-]?$/.test(p);
}

function joinLine(prev, next) {
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return prev.slice(0, -1) + next;
  return prev + " " + next;
}

function linesToParagraphs(lines, pageHeight) {
  const paras = [];
  let cur = null;
  let prevLine = null;

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if ((line.y > pageHeight - 48 || line.y < 48) && text.length < 100) continue;
    let newPara = false;
    if (!cur) {
      newPara = true;
    } else if (prevLine) {
      const gap = prevLine.y - line.y;
      const sameColumnFlow = gap > 0 && prevLine.col === line.col;
      if (!sameColumnFlow) {
        /* 跨栏续接要求字号一致，防止脚注/图注粘进正文 */
        const sameFont = Math.abs(line.h - prevLine.h) <= prevLine.h * 0.15;
        newPara = !(sameFont && continues(cur.text, text));
      } else if (gap > prevLine.h * 1.7) {
        newPara = true;
      } else if (line.x0 - prevLine.x0 > 6 && line.x0 - line.cx0 > 3) {
        newPara = true; /* 首行缩进（相对上一行且相对本栏左边界） */
      } else if (line.col !== "F" && prevLine.cx1 - prevLine.x1 > Math.max(15, prevLine.h * 1.2)) {
        newPara = !continues(cur.text, text); /* 上一行未排满；标题折行等续写除外 */
      } else if (Math.abs(line.h - prevLine.h) > Math.max(2, prevLine.h * 0.25)) {
        newPara = true; /* 字号突变 */
      }
    }
    if (newPara) { cur = { text, h: line.h, n: 1 }; paras.push(cur); }
    else { cur.text = joinLine(cur.text, text); cur.n++; }
    prevLine = line;
  }

  /* 小字号段落（脚注/图注/版权信息）标记为旁注 */
  const bodyParas = paras.filter((p) => p.n >= 2 || p.text.length > 120);
  const hs = bodyParas.map((p) => p.h).sort((a, b) => a - b);
  const medianH = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
  for (const p of paras) p.aside = p.h < medianH * 0.92;

  /* 正文被旁注打断时续接未完成的句子（桥接保守：字号一致 + 长正文或小写开头） */
  const merged = [];
  for (const p of paras) {
    let prevBody = null;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (!merged[i].aside) { prevBody = merged[i]; break; }
    }
    const bridgeable = prevBody && !p.aside && continues(prevBody.text, p.text) &&
      Math.abs(p.h - prevBody.h) <= prevBody.h * 0.2 &&
      (prevBody.text.length > 150 || /^[a-z(（]/.test(p.text));
    if (bridgeable) {
      prevBody.text = joinLine(prevBody.text, p.text);
    } else {
      merged.push(p);
    }
  }

  return merged
    .map((p) => ({ text: p.text.replace(/\s+/g, " ").trim(), aside: p.aside, h: p.h }))
    .filter((p) => {
      const t = p.text;
      if (t.length < 2) return false;
      if (/^[\d\s./—-]+$/.test(t)) return false;
      const letters = (t.match(/[\p{L}]/gu) || []).length;
      return letters >= t.length * 0.35;
    });
}

/* ================= 抽取到 DOM ================= */

function extractPage(n, p) {
  p.extractPromise ||= (async () => {
    const content = await p.page.getTextContent();
    const rows = buildRows(content.items);
    const gutterX = detectGutter(rows, p.viewport.width);
    const lines = rowsToLines(rows, gutterX);
    const ordered = orderByColumns(lines);
    const texts = linesToParagraphs(ordered, p.viewport.height);

    if (texts.length === 0) {
      const hint = document.createElement("div");
      hint.className = "page-empty";
      hint.textContent = "本页没有可提取的文本（可能是扫描件或纯图表）";
      p.right.appendChild(hint);
      p.paras = [];
      return;
    }

    p.paras = texts.map((t, i) => {
      const el = document.createElement("div");
      el.className = t.aside ? "para aside" : "para";
      const orig = document.createElement("div");
      orig.className = "orig";
      orig.textContent = t.text;
      const trans = document.createElement("div");
      trans.className = "trans";
      el.append(orig, trans);
      p.right.appendChild(el);
      return { id: `p${n}_${i}`, text: t.text, aside: t.aside, el, trans, stitchedInto: null, fullText: null };
    });
  })();
  return p.extractPromise;
}

/* 跨页段落缝合：上页末段句子未完时，与下页首段合并成一个翻译单元 */
async function ensureStitch(n) {
  const a = pages.get(n);
  const b = pages.get(n + 1);
  if (!a || !b) return;
  await Promise.all([extractPage(n, a), extractPage(n + 1, b)]);
  if (a.stitchComputed) return;
  a.stitchComputed = true;
  const lastBody = [...a.paras].reverse().find((x) => !x.aside);
  const firstBody = b.paras.find((x) => !x.aside);
  if (lastBody && firstBody && continues(lastBody.text, firstBody.text)) {
    lastBody.fullText = joinLine(lastBody.text, firstBody.text);
    firstBody.stitchedInto = lastBody;
    /* 下页首段跟随上页译文，届时一并填充 */
    lastBody.mirror = firstBody;
  }
}

/* ================= 翻译 ================= */

function detectDocTarget() {
  let sample = "";
  for (const [, p] of pages) {
    for (const para of p.paras) sample += para.text + " ";
    if (sample.length > 2000) break;
  }
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return cjk * 2 > latin ? "en" : "zh";
}

async function translatePage(n, p) {
  await extractPage(n, p);
  await Promise.all([ensureStitch(n - 1), ensureStitch(n)]);
  if (p.translated || p.paras.length === 0) return;
  p.translated = true;

  if (!targetDecided) {
    targetDecided = true;
    target = detectDocTarget();
  }

  const todo = p.paras.filter((para) => {
    if (para.stitchedInto) return false; /* 由上一页的合并段落负责 */
    const t = para.fullText || para.text;
    return target === "en" ? HAS_CJK.test(t) : /[A-Za-z]/.test(t);
  });
  if (todo.length === 0) return;

  const byId = new Map(todo.map((para) => [para.id, para]));
  todo.forEach((para) => {
    para.el.classList.add("pending");
    if (para.mirror) para.mirror.el.classList.add("pending");
  });

  const fill = (para, text, isError) => {
    para.el.classList.remove("pending");
    if (isError) para.el.classList.add("error");
    para.trans.textContent = text;
    if (para.mirror) {
      para.mirror.el.classList.remove("pending");
      para.mirror.trans.textContent = text ? `〔接上页〕${text}` : text;
    }
  };

  let port;
  try {
    port = chrome.runtime.connect({ name: "page-translate" });
  } catch (e) {
    todo.forEach((para) => fill(para, "", false));
    p.translated = false;
    return;
  }
  port.onMessage.addListener((msg) => {
    if (msg.type === "results") {
      for (const r of msg.results) {
        const para = byId.get(r.id);
        if (!para) continue;
        if (r.translation) fill(para, r.translation, false);
        else fill(para, r.error ? `翻译失败：${r.error}` : "翻译失败", true);
      }
    } else if (msg.type === "done") {
      try { port.disconnect(); } catch (e) {}
    } else if (msg.type === "error") {
      todo.forEach((para) => {
        para.el.classList.remove("pending");
        if (para.mirror) para.mirror.el.classList.remove("pending");
      });
      p.translated = false;
      showBanner(msg.needsSetup ? "尚未配置 API Key，请先在设置页填写" : `翻译失败：${msg.message}`, 6000);
      try { port.disconnect(); } catch (e) {}
    }
  });
  port.postMessage({
    type: "start",
    target,
    segments: todo.map((para) => ({ id: para.id, text: para.fullText || para.text })),
  });
}

/* ================= 划词翻译（右侧文本区） ================= */

let selCard = null;
let selTrigger = null;
let selPort = null;

function closeSelUi() {
  if (selPort) { try { selPort.disconnect(); } catch (e) {} selPort = null; }
  if (selCard) { selCard.remove(); selCard = null; }
  if (selTrigger) { selTrigger.remove(); selTrigger = null; }
}

function openSelCard(x, y, text) {
  closeSelUi();
  selCard = document.createElement("div");
  selCard.className = "sel-card";
  const body = document.createElement("div");
  body.className = "sel-body";
  body.textContent = "翻译中…";
  selCard.appendChild(body);
  selCard.style.left = Math.min(x, window.innerWidth - 400) + "px";
  selCard.style.top = y + "px";
  document.body.appendChild(selCard);

  let full = "";
  let first = true;
  try {
    selPort = chrome.runtime.connect({ name: "translate" });
  } catch (e) {
    body.textContent = "扩展已更新，请刷新页面";
    return;
  }
  selPort.onMessage.addListener((msg) => {
    if (!selCard) return;
    if (msg.type === "chunk") {
      if (first) { first = false; body.textContent = ""; }
      full += msg.content;
      body.textContent = full;
    } else if (msg.type === "error") {
      body.textContent = msg.message;
    }
  });
  selPort.postMessage({ type: "start", text, target: "auto" });
}

document.addEventListener("mouseup", (ev) => {
  if (ev.target.closest?.(".sel-card, .sel-trigger")) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text || text.length > 6000 || !/\p{L}/u.test(text)) return;
    if (!sel.anchorNode || !$("doc").contains(sel.anchorNode)) return;
    closeSelUi();
    selTrigger = document.createElement("button");
    selTrigger.className = "sel-trigger";
    selTrigger.textContent = "译";
    selTrigger.style.left = ev.clientX + 10 + "px";
    selTrigger.style.top = ev.clientY + 12 + "px";
    selTrigger.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    selTrigger.addEventListener("click", () => {
      const x = parseFloat(selTrigger.style.left);
      const y = parseFloat(selTrigger.style.top);
      openSelCard(x, y, text);
    });
    document.body.appendChild(selTrigger);
  }, 0);
});

document.addEventListener("mousedown", (ev) => {
  if (!ev.target.closest?.(".sel-card, .sel-trigger")) closeSelUi();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeSelUi();
});
window.addEventListener("scroll", () => { if (selTrigger) closeSelUi(); }, { passive: true });

/* ================= 交互 ================= */

document.body.classList.add("trans-only");

$("btn-mode").addEventListener("click", () => {
  const only = document.body.classList.toggle("trans-only");
  $("btn-mode").textContent = only ? "显示原文" : "仅译文";
});

$("btn-open").addEventListener("click", () => $("file-input").click());
$("btn-pick").addEventListener("click", () => $("file-input").click());
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

$("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) openFromFile(file);
  e.target.value = "";
});

$("btn-load-url").addEventListener("click", () => {
  const url = $("url-input").value.trim();
  if (url) openFromUrl(url);
});
$("url-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-load-url").click();
});

const dropZone = $("drop-zone");
["dragover", "dragenter"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "drop") {
      const file = e.dataTransfer?.files?.[0];
      if (file && /pdf$/i.test(file.name)) openFromFile(file);
      else if (file) showBanner("请拖入 PDF 文件");
    }
    dropZone.classList.remove("over");
  })
);

const param = new URLSearchParams(location.search).get("file");
if (param) openFromUrl(param);
