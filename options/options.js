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

function fillModelList(models) {
  const list = $("model-list");
  list.textContent = "";
  for (const m of models.filter(Boolean)) {
    const opt = document.createElement("option");
    opt.value = m;
    list.appendChild(opt);
  }
}

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
  if (active) fillModelList(active.dataset.models.split(","));
}

/* ---------------- 预设 ---------------- */

$("presets").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-base]");
  if (!btn) return;
  $("baseUrl").value = btn.dataset.base;
  const models = btn.dataset.models.split(",").filter(Boolean);
  fillModelList(models);
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
      el.textContent = `连接成功 · ${res.ms} ms`;
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

$("btn-clear-cache").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("tc_"));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  $("cache-result").className = "test-result ok";
  $("cache-result").textContent = `已清空 ${keys.length} 条缓存`;
  setTimeout(() => { $("cache-result").textContent = ""; }, 2000);
});

load();
