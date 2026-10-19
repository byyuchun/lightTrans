/* 轻译 LightTrans — 设置页 */

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.1,
  extraInstructions: "",
  pageBatchSize: 8,
  pageConcurrency: 3,
};

/* ---------------- 加载 ---------------- */

/* ---------------- 模型下拉（可自由输入 + 候选列表） ---------------- */

let modelOptions = [];

function setModelOptions(models) {
  modelOptions = [...new Set((models || []).map((m) => String(m).trim()).filter(Boolean))];
  closeMenu();
}

function closeMenu() {
  $("model-menu").classList.add("hidden");
}

/* filter 为空时列出全部候选 —— 聚焦即展开全量，避免已有值时看不到列表 */
function openMenu(filter) {
  const menu = $("model-menu");
  const q = String(filter || "").trim().toLowerCase();
  const cur = $("model").value.trim();
  const items = q ? modelOptions.filter((m) => m.toLowerCase().includes(q)) : modelOptions;
  menu.textContent = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = modelOptions.length ? "无匹配模型" : "暂无候选，点「拉取模型」获取";
    menu.appendChild(li);
  } else {
    for (const m of items) {
      const li = document.createElement("li");
      li.textContent = m;
      li.dataset.model = m;
      if (m === cur) li.classList.add("current");
      menu.appendChild(li);
    }
  }
  menu.classList.remove("hidden");
}

$("model").addEventListener("focus", () => openMenu(""));
$("model").addEventListener("input", () => openMenu($("model").value));

/* mousedown 阻止默认，避免点选项时输入框先失焦 */
$("model-menu").addEventListener("mousedown", (e) => e.preventDefault());
$("model-menu").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-model]");
  if (!li) return;
  $("model").value = li.dataset.model;
  closeMenu();
});
$("model").addEventListener("blur", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".combo")) closeMenu();
});

function highlightPreset() {
  const base = $("baseUrl").value.trim().replace(/\/+$/, "");
  document.querySelectorAll("#presets button").forEach((b) => {
    b.classList.toggle("on", b.dataset.base.replace(/\/+$/, "") === base);
  });
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  $("baseUrl").value = s.baseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("temperature").value = s.temperature;
  $("temp-val").textContent = s.temperature;
  $("pageBatchSize").value = s.pageBatchSize;
  $("pageConcurrency").value = s.pageConcurrency;
  $("extraInstructions").value = s.extraInstructions;
  highlightPreset();
  const active = document.querySelector("#presets button.on");
  if (active) setModelOptions(active.dataset.models.split(","));
}

/* ---------------- 预设 ---------------- */

$("presets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-base]");
  if (!btn) return;
  $("baseUrl").value = btn.dataset.base;
  const models = btn.dataset.models.split(",").filter(Boolean);
  setModelOptions(models);
  if (models.length > 0) $("model").value = models[0];
  else $("model").value = "";
  highlightPreset();
});

$("baseUrl").addEventListener("input", highlightPreset);

/* ---------------- 表单读取 ---------------- */

function readForm() {
  return {
    baseUrl: $("baseUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    temperature: Number($("temperature").value),
    extraInstructions: $("extraInstructions").value.trim(),
    pageBatchSize: Math.max(1, Math.min(30, Number($("pageBatchSize").value) || 8)),
    pageConcurrency: Math.max(1, Math.min(10, Number($("pageConcurrency").value) || 3)),
  };
}

$("temperature").addEventListener("input", () => {
  $("temp-val").textContent = $("temperature").value;
});

$("btn-eye").addEventListener("click", () => {
  const input = $("apiKey");
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  $("btn-eye").textContent = hidden ? "隐藏" : "显示";
});

/* ---------------- 保存 / 测试 / 缓存 ---------------- */

let toastTimer = null;

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
}

$("btn-save").addEventListener("click", async () => {
  const s = readForm();
  if (!s.baseUrl) { toast("请填写 Base URL"); return; }
  if (!s.model) { toast("请填写模型名称"); return; }
  await chrome.storage.local.set({ settings: s });
  toast("已保存");
});

$("btn-test").addEventListener("click", async () => {
  const el = $("test-result");
  const btn = $("btn-test");
  el.className = "test-result";
  el.textContent = "测试中…";
  btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "lt:test-connection", settings: readForm() });
    if (res?.ok) {
      el.className = "test-result ok";
      el.textContent = res.empty
        ? `连接成功 · ${res.ms} ms（模型返回空正文，多为推理模型，翻译可能不理想）`
        : `连接成功 · ${res.ms} ms`;
    } else {
      el.className = "test-result err";
      el.textContent = res?.message || "连接失败";
    }
  } catch (e) {
    el.className = "test-result err";
    el.textContent = e.message || "连接失败";
  } finally {
    btn.disabled = false;
  }
});

$("btn-models").addEventListener("click", async () => {
  const btn = $("btn-models");
  const el = $("test-result");
  const { baseUrl, apiKey } = readForm();
  if (!baseUrl) { toast("请先填写 Base URL"); return; }
  if (!apiKey) { toast("请先填写 API Key"); return; }
  btn.disabled = true;
  el.className = "test-result";
  el.textContent = "获取中…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "lt:list-models", settings: { baseUrl, apiKey } });
    if (!res?.ok) throw new Error(res?.message || "获取失败");
    setModelOptions(res.models);
    if (!$("model").value.trim()) $("model").value = res.models[0];
    openMenu("");
    el.className = "test-result ok";
    el.textContent = `已获取 ${res.models.length} 个模型，从下方列表选择`;
  } catch (e) {
    el.className = "test-result err";
    el.textContent = e.message || "获取失败";
  } finally {
    btn.disabled = false;
  }
});

$("btn-clear-cache").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("tc_"));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  $("cache-result").className = "test-result ok";
  $("cache-result").textContent = `已清空 ${keys.length} 条缓存`;
  setTimeout(() => { $("cache-result").textContent = ""; }, 2000);
});

load();
