/* 轻译 LightTrans — PDF 双语阅读器
 * 左侧 pdf.js 原样渲染（懒渲染 + 远离视口释放内存），右侧逐段译文（按页懒翻译）。
 * 文本抽取：行聚合 -> 双栏识别与阅读顺序还原 -> 段落合并（缩进/行距/连字符启发式）。
 */
import { getDocument, GlobalWorkerOptions } from "./pdfjs/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

let pdfDoc = null;
let target = "zh";
const pages = new Map(); /* pageNum -> { row, canvasWrap, textPane, viewport, rendered, extracted, translated, paras, port } */

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
  $("doc-name").textContent = name || "";
  document.title = `${name || "PDF"} · 轻译`;
  $("empty").classList.add("hidden");
  $("doc").classList.remove("hidden");
  $("btn-mode").classList.remove("hidden");
  $("page-info").textContent = `共 ${pdfDoc.numPages} 页`;
  await buildPages();
}

/* ================= 页面骨架与懒加载 ================= */

const NEAR = 1400; /* 提前量：距视口该像素内开始渲染/翻译 */

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
    /* 占位高度，避免滚动跳动 */
    left.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

    const right = document.createElement("div");
    right.className = "page-right";

    row.append(left, right);
    doc.appendChild(row);
    pages.set(n, {
      page, row, left, right, viewport,
      rendered: false, extracted: false, translated: false,
      paras: [], canvas: null, port: null,
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

/* ---------------- 渲染 / 释放 ---------------- */

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
  if (!p.rendered) return; /* 期间被释放 */
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

function buildLines(items) {
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

  const lines = [];
  for (const f of frags) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - f.y) < Math.max(2, last.h * 0.45)) {
      /* 同一行：按 x 间距决定是否补空格 */
      const gap = f.x - last.x1;
      last.text += (gap > last.h * 0.18 && !last.text.endsWith(" ") ? " " : "") + f.text;
      last.x1 = Math.max(last.x1, f.x + f.w);
      last.h = Math.max(last.h, f.h);
    } else {
      lines.push({ text: f.text, x0: f.x, x1: f.x + f.w, y: f.y, h: f.h });
    }
  }
  return lines;
}

/* 双栏识别：宽行做分隔符，两栏间按 左栏全部 -> 右栏全部 还原阅读顺序 */
function orderByColumns(lines, pageWidth) {
  const mid = pageWidth / 2;
  const MARGIN = 40;
  const ordered = [];
  let leftBuf = [];
  let rightBuf = [];
  const flush = () => {
    ordered.push(...leftBuf, ...rightBuf);
    leftBuf = [];
    rightBuf = [];
  };
  for (const line of lines) {
    const isFull = line.x0 < mid - MARGIN && line.x1 > mid + MARGIN;
    if (isFull) {
      flush();
      ordered.push(line);
    } else if (line.x1 <= mid + MARGIN) {
      leftBuf.push(line);
    } else {
      rightBuf.push(line);
    }
  }
  flush();
  return ordered;
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
    /* 页眉页脚：极靠边且很短的行 */
    if ((line.y > pageHeight - 34 || line.y < 34) && text.length < 90) continue;

    let newPara = false;
    if (!cur) {
      newPara = true;
    } else if (prevLine) {
      const gap = prevLine.y - line.y;
      const sameColumnFlow = gap > 0;
      if (!sameColumnFlow) {
        /* 跨栏/跨区续接：句子未结束且下行小写开头则并入原段 */
        newPara = !(!/[.。!?！？:：]$/.test(cur.text.trim()) && /^[a-z]/.test(text));
      } else if (gap > prevLine.h * 1.7) {
        newPara = true;
      } else if (line.x0 - prevLine.x0 > 9 && gap > prevLine.h * 0.6) {
        newPara = true; /* 首行缩进 */
      } else if (Math.abs(line.h - prevLine.h) > Math.max(2, prevLine.h * 0.25)) {
        newPara = true; /* 字号突变（标题/正文切换） */
      }
    }

    if (newPara) {
      cur = { text };
      paras.push(cur);
    } else {
      cur.text = joinLine(cur.text, text);
    }
    prevLine = line;
  }

  return paras
    .map((p) => p.text.replace(/\s+/g, " ").trim())
    .filter((t) => {
      if (t.length < 2) return false;
      if (/^[\d\s./—-]+$/.test(t)) return false; /* 页码等 */
      const letters = (t.match(/[\p{L}]/gu) || []).length;
      return letters >= t.length * 0.35; /* 公式碎片噪声 */
    });
}

async function extractPage(n, p) {
  if (p.extracted) return;
  p.extracted = true;
  const content = await p.page.getTextContent();
  const lines = buildLines(content.items);
  const ordered = orderByColumns(lines, p.viewport.width);
  const texts = linesToParagraphs(ordered, p.viewport.height);

  if (texts.length === 0) {
    const hint = document.createElement("div");
    hint.className = "page-empty";
    hint.textContent = "本页没有可提取的文本（可能是扫描件或纯图表）";
    p.right.appendChild(hint);
    return;
  }

  p.paras = texts.map((text, i) => {
    const el = document.createElement("div");
    el.className = "para";
    const orig = document.createElement("div");
    orig.className = "orig";
    orig.textContent = text;
    const trans = document.createElement("div");
    trans.className = "trans";
    el.append(orig, trans);
    p.right.appendChild(el);
    return { id: `p${n}_${i}`, text, el, trans };
  });
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

let targetDecided = false;

async function translatePage(n, p) {
  await extractPage(n, p);
  if (p.translated || p.paras.length === 0) return;
  p.translated = true;

  if (!targetDecided) {
    targetDecided = true;
    target = detectDocTarget();
  }

  const todo = p.paras.filter((para) =>
    target === "en" ? HAS_CJK.test(para.text) : /[A-Za-z]/.test(para.text)
  );
  if (todo.length === 0) return;

  const byId = new Map(todo.map((para) => [para.id, para]));
  todo.forEach((para) => para.el.classList.add("pending"));

  let port;
  try {
    port = chrome.runtime.connect({ name: "page-translate" });
  } catch (e) {
    todo.forEach((para) => para.el.classList.remove("pending"));
    p.translated = false;
    return;
  }
  p.port = port;
  port.onMessage.addListener((msg) => {
    if (msg.type === "results") {
      for (const r of msg.results) {
        const para = byId.get(r.id);
        if (!para) continue;
        para.el.classList.remove("pending");
        if (r.translation) {
          para.trans.textContent = r.translation;
        } else {
          para.el.classList.add("error");
          para.trans.textContent = r.error ? `翻译失败：${r.error}` : "翻译失败";
        }
      }
    } else if (msg.type === "done") {
      try { port.disconnect(); } catch (e) {}
      p.port = null;
    } else if (msg.type === "error") {
      todo.forEach((para) => {
        para.el.classList.remove("pending");
      });
      p.translated = false;
      if (msg.needsSetup) {
        showBanner("尚未配置 API Key，请先在设置页填写", 6000);
      } else {
        showBanner(`翻译失败：${msg.message}`, 6000);
      }
      try { port.disconnect(); } catch (e) {}
      p.port = null;
    }
  });
  port.onDisconnect.addListener(() => { p.port = null; });
  port.postMessage({
    type: "start",
    target,
    segments: todo.map((para) => ({ id: para.id, text: para.text })),
  });
}

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

/* URL 参数直接打开：viewer.html?file=<encoded url> */
const param = new URLSearchParams(location.search).get("file");
if (param) openFromUrl(param);
