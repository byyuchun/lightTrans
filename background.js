/* 轻译 LightTrans — background service worker
 * 职责：所有网络请求（OpenAI 兼容接口）、批量翻译引擎、缓存、上下文菜单。
 * API Key 只在此处读取，不进入页面上下文。
 */

const DEFAULT_SETTINGS = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
  temperature: 0.1,
  extraInstructions: "",
  pageBatchSize: 8,
  pageConcurrency: 3,
};

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

/* baseUrl 规范化：允许填 https://host、https://host/v1 或完整 /chat/completions */
function buildEndpoint(baseUrl) {
  let url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/\/chat\/completions$/.test(url)) url += "/chat/completions";
  return url;
}

const HAS_CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function detectTarget(text) {
  return HAS_CJK.test(text) ? "en" : "zh";
}

function langName(code) {
  return code === "en" ? "English" : "Simplified Chinese";
}

/* ---------------- 缓存（chrome.storage.local，带容量上限） ---------------- */

function hashKey(str) {
  /* FNV-1a 32bit，双轮降低碰撞 */
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 ^ ((c << 1) + 1)) * 0x01000193) >>> 0;
  }
  return "tc_" + h1.toString(36) + h2.toString(36);
}

function cacheKey(model, target, text) {
  return hashKey(model + "\u0001" + target + "\u0001" + text);
}

async function cacheGetMany(keys) {
  if (keys.length === 0) return {};
  return chrome.storage.local.get(keys);
}

async function cacheSetMany(entries) {
  const now = Date.now();
  const payload = {};
  for (const [k, t] of entries) payload[k] = { t, ts: now };
  if (Object.keys(payload).length > 0) await chrome.storage.local.set(payload);
}

const CACHE_MAX_ENTRIES = 4000;

async function pruneCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const items = Object.entries(all).filter(([k]) => k.startsWith("tc_"));
    if (items.length <= CACHE_MAX_ENTRIES) return;
    items.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const remove = items.slice(0, items.length - CACHE_MAX_ENTRIES + 500).map(([k]) => k);
    await chrome.storage.local.remove(remove);
  } catch (e) {
    /* 清理失败不影响功能 */
  }
}

chrome.runtime.onStartup?.addListener(() => { pruneCache(); });

/* ---------------- OpenAI 兼容请求 ---------------- */

async function chatOnce(settings, messages, { signal, maxTokens } = {}) {
  const endpoint = buildEndpoint(settings.baseUrl);
  const body = {
    model: settings.model,
    messages,
    temperature: Number(settings.temperature) || 0,
    stream: false,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const err = new Error(`HTTP ${res.status}${detail ? ": " + detail : ""}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("接口返回格式异常：缺少 choices[0].message.content");
  return content; /* 推理模型的 reasoning_content 有意忽略 */
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chatWithRetry(settings, messages, opts = {}) {
  const retries = opts.retries ?? 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatOnce(settings, messages, opts);
    } catch (e) {
      lastErr = e;
      if (e.name === "AbortError") throw e;
      /* 4xx（除 429）没有重试意义 */
      if (e.status && e.status !== 429 && e.status < 500) throw e;
      if (attempt < retries) await sleep(600 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

/* ---------------- 划词/弹窗：流式翻译 ---------------- */

function buildSingleSystemPrompt(settings, target) {
  const base =
    `You are a professional translation engine. Translate the user's text into ${langName(target)}. ` +
    `Preserve the original meaning, tone, numbers, URLs, code identifiers, line breaks and formatting. ` +
    `For a single word or short phrase, give the most natural and common translation. ` +
    `Output ONLY the translation — no explanations, no quotation marks, no pinyin.`;
  const extra = (settings.extraInstructions || "").trim();
  return extra ? base + "\n" + extra : base;
}

async function streamTranslate({ text, target }, port, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    port.postMessage({ type: "error", needsSetup: true, message: "尚未配置 API Key，请先在设置页填写。" });
    return;
  }
  const to = target && target !== "auto" ? target : detectTarget(text);
  port.postMessage({ type: "meta", target: to });

  /* 命中缓存直接返回，0 延迟 */
  const ck = cacheKey(settings.model, to, text);
  const hit = (await cacheGetMany([ck]))[ck];
  if (hit && typeof hit.t === "string") {
    port.postMessage({ type: "chunk", content: hit.t });
    port.postMessage({ type: "done", cached: true });
    return;
  }

  const endpoint = buildEndpoint(settings.baseUrl);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: Number(settings.temperature) || 0,
      stream: true,
      messages: [
        { role: "system", content: buildSingleSystemPrompt(settings, to) },
        { role: "user", content: text },
      ],
    }),
    signal,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    port.postMessage({ type: "error", message: `请求失败 HTTP ${res.status}${detail ? "：" + detail : ""}` });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            port.postMessage({ type: "chunk", content: delta });
          }
        } catch (e) {
          /* 忽略无法解析的 keep-alive 行 */
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (full) await cacheSetMany([[ck, full]]);
  port.postMessage({ type: "done" });
}

/* ---------------- 整页翻译：批量引擎（JSON 映射协议） ---------------- */

function buildBatchSystemPrompt(settings, target) {
  const base =
    `You are a professional translation engine. Translate each segment into ${langName(target)}. ` +
    `Preserve meaning, tone, numbers, URLs, and code identifiers. Do not add notes. ` +
    `Some segments contain <b>...</b> or <i>...</i> tags marking emphasized text — keep these tags in your ` +
    `translation around the corresponding words; do not introduce any other HTML tags.`;
  const extra = (settings.extraInstructions || "").trim();
  const format =
    `\nReturn ONLY a JSON object mapping each input "id" to its translated string, ` +
    `e.g. {"s0":"...","s1":"..."}.`;
  return base + (extra ? "\n" + extra : "") + format;
}

function extractJsonObject(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* 继续尝试大括号截取 */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch (e) { /* 放弃 */ }
  }
  return {};
}

/* 按段数与字符预算双重上限分批：论文长段落多，单批过大易超时/超上下文 */
function chunkSegments(items, size, charBudget = 3500) {
  const out = [];
  let batch = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length > 0 && (batch.length >= size || chars + item.text.length > charBudget)) {
      out.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += item.text.length;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function translateBatchCall(settings, target, batch, signal) {
  const messages = [
    { role: "system", content: buildBatchSystemPrompt(settings, target) },
    { role: "user", content: JSON.stringify(batch.map((s) => ({ id: s.id, text: s.text }))) },
  ];
  const content = await chatWithRetry(settings, messages, { signal, retries: 2 });
  const obj = extractJsonObject(content);
  return batch.map((s) => ({
    id: s.id,
    translation: typeof obj[s.id] === "string" ? obj[s.id] : "",
  }));
}

async function translateSingleFallback(settings, target, seg, signal) {
  try {
    const messages = [
      { role: "system", content: buildSingleSystemPrompt(settings, target) },
      { role: "user", content: seg.text },
    ];
    const translation = await chatWithRetry(settings, messages, { signal, retries: 1 });
    return { id: seg.id, translation: translation.trim() };
  } catch (e) {
    return { id: seg.id, translation: "", error: e.message };
  }
}

async function pageTranslate({ segments, target }, port, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    port.postMessage({ type: "error", needsSetup: true, message: "尚未配置 API Key，请先在设置页填写。" });
    return;
  }
  const total = segments.length;
  let done = 0;

  /* 1. 批量查缓存 */
  const keyBySeg = new Map(segments.map((s) => [s.id, cacheKey(settings.model, target, s.text)]));
  const cachedValues = await cacheGetMany([...keyBySeg.values()]);
  const cachedResults = [];
  const misses = [];
  for (const s of segments) {
    const hit = cachedValues[keyBySeg.get(s.id)];
    if (hit && typeof hit.t === "string") {
      cachedResults.push({ id: s.id, translation: hit.t });
    } else {
      misses.push(s);
    }
  }
  if (cachedResults.length > 0) {
    done += cachedResults.length;
    port.postMessage({ type: "results", results: cachedResults });
    port.postMessage({ type: "progress", done, total });
  }

  /* 2. 未命中的分批并发翻译 */
  const batches = chunkSegments(misses, Math.max(1, Number(settings.pageBatchSize) || 8));
  await runPool(batches, Math.max(1, Number(settings.pageConcurrency) || 3), async (batch) => {
    if (signal.aborted) return;
    let results;
    try {
      results = await translateBatchCall(settings, target, batch, signal);
    } catch (e) {
      if (e.name === "AbortError") return;
      results = batch.map((s) => ({ id: s.id, translation: "", error: e.message }));
    }
    /* 批量协议漏掉的段落逐段兜底 */
    const missing = results.filter((r) => !r.translation && !r.error);
    if (missing.length > 0 && !signal.aborted) {
      const byId = new Map(batch.map((s) => [s.id, s]));
      const fixed = await Promise.all(
        missing.map((r) => translateSingleFallback(settings, target, byId.get(r.id), signal))
      );
      const fixedById = new Map(fixed.map((r) => [r.id, r]));
      results = results.map((r) => fixedById.get(r.id) || r);
    }
    if (signal.aborted) return;
    const toCache = results
      .filter((r) => r.translation)
      .map((r) => {
        const seg = batch.find((s) => s.id === r.id);
        return [cacheKey(settings.model, target, seg.text), r.translation];
      });
    await cacheSetMany(toCache);
    done += results.length;
    port.postMessage({ type: "results", results });
    port.postMessage({ type: "progress", done, total });
  });

  if (!signal.aborted) port.postMessage({ type: "done" });
}

/* ---------------- Port 分发 ---------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate" && port.name !== "page-translate") return;
  const aborter = new AbortController();
  port.onDisconnect.addListener(() => aborter.abort());
  port.onMessage.addListener((msg) => {
    if (msg.type === "cancel") {
      aborter.abort();
      return;
    }
    if (msg.type !== "start") return;
    const task = port.name === "translate"
      ? streamTranslate(msg, port, aborter.signal)
      : pageTranslate(msg, port, aborter.signal);
    task.catch((err) => {
      if (err.name === "AbortError") return;
      try {
        port.postMessage({ type: "error", message: err.message || String(err) });
      } catch (e) { /* port 已断开 */ }
    });
  });
});

/* ---------------- 设置页：测试连接 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "lt:open-options") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg.type !== "lt:test-connection") return false;
  (async () => {
    const started = Date.now();
    try {
      const settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      if (!settings.apiKey) throw new Error("请先填写 API Key");
      const content = await chatOnce(
        settings,
        [{ role: "user", content: "Reply with the single word: pong" }],
        { maxTokens: 8 }
      );
      sendResponse({ ok: true, ms: Date.now() - started, reply: content.trim().slice(0, 40) });
    } catch (e) {
      sendResponse({ ok: false, ms: Date.now() - started, message: e.message || String(e) });
    }
  })();
  return true;
});

/* ---------------- 右键菜单 ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "lt-translate-selection",
    title: "轻译：翻译所选文本",
    contexts: ["selection"],
  });
  pruneCache();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "lt-translate-selection" && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "lt:translate-selection" }).catch(() => {});
  }
});
