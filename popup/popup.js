/* 轻译 LightTrans — popup */

const $ = (id) => document.getElementById(id);
const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

let direction = "auto";
let port = null;

const dirLabel = (target) => (target === "en" ? "中 → EN" : "EN → 中");

/* ---------------- 配置检查 ---------------- */

async function checkSetup() {
  const { settings } = await chrome.storage.local.get("settings");
  const ok = Boolean(settings?.apiKey);
  $("setup-hint").classList.toggle("hidden", ok);
  return ok;
}

$("link-setup").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

/* ---------------- 方向切换 ---------------- */

$("direction").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-dir]");
  if (!btn) return;
  direction = btn.dataset.dir;
  document.querySelectorAll("#direction button").forEach((b) => b.classList.toggle("on", b === btn));
  chrome.storage.local.set({ uiDirection: direction });
});

chrome.storage.local.get("uiDirection").then(({ uiDirection }) => {
  if (!uiDirection) return;
  const btn = document.querySelector(`#direction button[data-dir="${uiDirection}"]`);
  if (btn) {
    direction = uiDirection;
    document.querySelectorAll("#direction button").forEach((b) => b.classList.toggle("on", b === btn));
  }
});

/* ---------------- 文本翻译 ---------------- */

function startTranslate() {
  const text = $("input").value.trim();
  if (!text) return;

  if (port) { try { port.disconnect(); } catch (e) {} port = null; }

  const wrap = $("result-wrap");
  const result = $("result");
  const badge = $("result-badge");
  wrap.classList.remove("hidden");
  result.className = "result";
  result.textContent = "翻译中…";
  badge.textContent = direction === "auto" ? dirLabel(HAS_CJK.test(text) ? "en" : "zh") : dirLabel(direction);
  $("btn-translate").disabled = true;

  let full = "";
  let firstChunk = true;

  port = chrome.runtime.connect({ name: "translate" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "meta") {
      badge.textContent = dirLabel(msg.target);
    } else if (msg.type === "chunk") {
      if (firstChunk) {
        firstChunk = false;
        result.textContent = "";
        result.className = "result streaming";
      }
      full += msg.content;
      result.textContent = full;
      result.scrollTop = result.scrollHeight;
    } else if (msg.type === "done") {
      result.className = "result";
      $("btn-translate").disabled = false;
    } else if (msg.type === "error") {
      result.className = "result error";
      result.textContent = msg.message;
      $("btn-translate").disabled = false;
      if (msg.needsSetup) $("setup-hint").classList.remove("hidden");
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    $("btn-translate").disabled = false;
  });
  port.postMessage({ type: "start", text, target: direction });
}

$("btn-translate").addEventListener("click", startTranslate);

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    startTranslate();
  }
});

$("btn-copy").addEventListener("click", async () => {
  const text = $("result").textContent;
  if (!text) return;
  await navigator.clipboard.writeText(text).catch(() => {});
  const btn = $("btn-copy");
  btn.classList.add("ok");
  setTimeout(() => btn.classList.remove("ok"), 1200);
});

/* ---------------- 整页翻译 ---------------- */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setPageButton(state) {
  const btn = $("btn-page");
  const desc = $("page-desc");
  btn.classList.remove("stop");
  btn.disabled = false;
  if (state === "translating") {
    btn.textContent = "停止";
    btn.classList.add("stop");
    desc.textContent = "正在翻译，可随时停止";
  } else if (state === "shown") {
    btn.textContent = "移除译文";
    btn.classList.add("stop");
    desc.textContent = "已显示双语对照";
  } else if (state === "unavailable") {
    btn.textContent = "翻译此页";
    btn.disabled = true;
    desc.textContent = "此页面不支持（浏览器内置页）";
  } else {
    btn.textContent = "翻译此页";
    desc.textContent = "译文显示在原文下方";
  }
}

async function refreshPageState() {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    setPageButton("unavailable");
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "lt:page-state" });
    setPageButton(res?.state || "idle");
  } catch (e) {
    /* content script 未注入（扩展刚安装/页面未刷新） */
    setPageButton("unavailable");
    $("page-desc").textContent = "请刷新页面后再试";
  }
}

$("btn-page").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  if (!(await checkSetup())) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "lt:toggle-page" });
    setPageButton(res?.state || "idle");
    if (res?.state === "translating") window.close();
  } catch (e) {
    setPageButton("unavailable");
    $("page-desc").textContent = "请刷新页面后再试";
  }
});

/* ---------------- PDF 翻译 ---------------- */

function looksLikePdf(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname) || /^https?:\/\/arxiv\.org\/pdf\//i.test(url);
  } catch (e) {
    return false;
  }
}

async function initPdfEntry() {
  const tab = await activeTab();
  const viewer = chrome.runtime.getURL("pdf/viewer.html");
  if (looksLikePdf(tab?.url)) {
    $("btn-pdf").textContent = "翻译此 PDF";
    $("pdf-desc").textContent = "在轻译阅读器中打开当前 PDF";
    $("btn-pdf").onclick = () => {
      chrome.tabs.create({ url: `${viewer}?file=${encodeURIComponent(tab.url)}` });
      window.close();
    };
  } else {
    $("btn-pdf").onclick = () => {
      chrome.tabs.create({ url: viewer });
      window.close();
    };
  }
}

/* ---------------- init ---------------- */

checkSetup();
refreshPageState();
initPdfEntry();
$("input").focus();
