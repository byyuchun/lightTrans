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
  /* fluent：流畅意译；literal：忠实直译 */
  style: "fluent",
  pageBatchSize: 8,
  pageConcurrency: 3,
};

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function normalizeBase(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function baseHasPath(raw) {
  try {
    const u = new URL(raw);
    return !!u.pathname && u.pathname !== "/";
  } catch (e) {
    return true; /* 解析不了就按「已带路径」处理，原样使用 */
  }
}

/* 端点候选。裸主机（如 https://llmbox.bytedance.net）默认补 /v1 —— 内部网关与 OpenAI
 * 官方都只在 /v1 下暴露接口，缺了会 404；已带路径或完整端点的按用户填写原样使用。
 * 返回多个候选用于 404 回退（个别自建服务只挂在根路径）。 */
function endpointCandidates(baseUrl, kind) {
  const suffix = kind === "models" ? "/models" : "/chat/completions";
  const raw = normalizeBase(baseUrl);
  if (!raw) return [];
  if (raw.endsWith(suffix)) return [raw];
  const stripped = raw.replace(/\/(chat\/completions|models)$/, "");
  if (baseHasPath(stripped)) return [stripped + suffix];
  return [stripped + "/v1" + suffix, stripped + suffix];
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

/* 缓存键只含 prompt 版本、模型、目标语言、风格、附加指令和原文。
 * 文档简报、术语表、前文不进键：上下文变了不应让整篇缓存失效。 */
const PROMPT_VERSION = "v2";

function normalizeStyle(style) {
  return style === "literal" ? "literal" : "fluent";
}

function cacheKey(model, target, text, style, extra) {
  return hashKey([
    PROMPT_VERSION,
    model,
    target,
    normalizeStyle(style),
    String(extra || "").trim(),
    text,
  ].join("\u0001"));
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

if (typeof chrome !== "undefined" && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => { pruneCache(); });
}

/* ---------------- OpenAI 兼容请求 ---------------- */

function authHeaders(apiKey) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}

/* 依次尝试候选端点，仅对 404 回退（路径不对），其余状态原样返回 */
async function requestChat(settings, body, signal) {
  const candidates = endpointCandidates(settings.baseUrl, "chat");
  if (candidates.length === 0) throw new Error("未配置 Base URL");
  let res;
  for (let i = 0; i < candidates.length; i++) {
    res = await fetch(candidates[i], {
      method: "POST",
      headers: authHeaders(settings.apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (res.status !== 404 || i === candidates.length - 1) break;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const err = new Error(`HTTP ${res.status}${detail ? ": " + detail : ""}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function chatOnce(settings, messages, { signal, maxTokens, allowEmpty } = {}) {
  const body = {
    model: settings.model,
    messages,
    temperature: Number(settings.temperature) || 0,
    stream: false,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  const res = await requestChat(settings, body, signal);
  const data = await res.json();
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message || typeof message !== "object") {
    throw new Error("接口返回格式异常：缺少 choices[0].message");
  }
  const content = typeof message.content === "string" ? message.content : "";
  if (!content && !allowEmpty) {
    /* 内部网关上的推理模型常把 token 预算全花在思维链上，正文为空。
       区分「只出了思维链」与「彻底为空」，给出可操作的提示。 */
    const reasoning = typeof message.reasoning_content === "string"
      ? message.reasoning_content
      : typeof message.reasoning === "string" ? message.reasoning : "";
    const hint = choice.finish_reason === "length" ? "（输出被 max_tokens 截断，可调大或改用非推理模型）" : "";
    throw new Error(
      (reasoning ? "模型只返回了思维链、没有正文" : "接口返回空内容：choices[0].message.content 为空") + hint
    );
  }
  return content;
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

/* ---------------- Prompt（中文走科技编辑，其他语言保持通用） ---------------- */

const ZH_FLUENT =
  "你是资深中文科技译者兼编辑，读者是中国的大学生和工程师。请把英文技术内容译成地道的中文，读起来像人写的技术文章，而不是逐词对照。\n" +
  "原则：\n" +
  "1. 意译优先于直译。按中文习惯重组语序，把英文长句拆成短句。\n" +
  "2. 避免翻译腔：少用「被」字句，避免「的的的」堆叠，不要写「进行……的操作」这类空转说法。\n" +
  "3. 术语首次出现可以写成「中文（English）」。专有名词、产品名、模型名和代码标识符保留英文，例如 Claude Code、MCP、token、prompt。\n" +
  "4. 段落信息不增不减：不补充原文没有的背景，也不丢掉限定条件、数字、否定和比较关系。\n" +
  "5. 保留数字、URL 和换行。原文里的 <b>、<i> 标签要留在对应文字上，不要引入其他 HTML。\n" +
  "6. 只输出译文，不要解释，不要前言，不要拼音，不要用引号把译文包起来。";

const ZH_LITERAL =
  "你是资深中文科技译者，读者是中国的大学生和工程师。本次风格是忠实直译：尽量保持原文的句子结构和用词，不合并、不改写作者的论证顺序，同时保证中文通顺。\n" +
  "原则：\n" +
  "1. 不随意意译，不增删信息；数字、限定条件和否定必须保留。\n" +
  "2. 专有名词、产品名、模型名和代码标识符保留英文。术语首次出现可以写成「中文（English）」。\n" +
  "3. 保留数字、URL 和换行。原文里的 <b>、<i> 标签要留在对应文字上，不要引入其他 HTML。\n" +
  "4. 只输出译文，不要解释，不要前言，不要拼音。";

const ZH_BATCH_RULES =
  "同一篇文档里，术语译法必须与术语表一致，不要另起译名。\n" +
  "前文只供衔接，不要翻译前文，也不要把前文里才有的信息写进本段。";

const BATCH_FORMAT =
  "按输入顺序逐段翻译。每段译文以分隔符开头，分隔符独占一行，格式为 <<<id>>>，id 与输入一致。\n" +
  "分隔符之后只写该段译文，不要重复原文，不要输出 JSON，不要写任何解释。";

function stylePrompt(settings, target) {
  if (target !== "zh") {
    return (
      `You are a professional translator. Translate into ${langName(target)}. ` +
      "Preserve meaning, numbers, URLs, code identifiers, and line breaks. " +
      "Keep proper nouns and code identifiers unchanged. " +
      "Some text contains <b>...</b> or <i>...</i> tags — keep those tags around the corresponding words, and do not introduce any other HTML. " +
      "Output only the translation, with no explanations and no quotation marks."
    );
  }
  return normalizeStyle(settings.style) === "literal" ? ZH_LITERAL : ZH_FLUENT;
}

function withExtra(settings, base) {
  const extra = (settings.extraInstructions || "").trim();
  return extra ? base + "\n" + extra : base;
}

/* ---------------- 划词/弹窗：流式翻译 ---------------- */

function buildSingleSystemPrompt(settings, target) {
  let base = stylePrompt(settings, target);
  if (target === "zh") {
    base += "\n若输入是单词或短语，只给最常用的一个译法；若是完整句子或段落，按上面的风格翻译。";
    base += "\n若消息里提供了页面标题或所在段落，它们只用于消除歧义，不要翻译上下文本身。";
  } else {
    base += " For a single word or short phrase, give the most common translation.";
    base += " If a page title or surrounding paragraph is provided, use it only to disambiguate and do not translate it.";
  }
  return withExtra(settings, base);
}

async function streamTranslate({ text, target, context }, port, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    port.postMessage({ type: "error", needsSetup: true, message: "尚未配置 API Key，请先在设置页填写。" });
    return;
  }
  const to = target && target !== "auto" ? target : detectTarget(text);
  port.postMessage({ type: "meta", target: to });

  /* 命中缓存直接返回，0 延迟。上下文不参与键，避免同一句话因所在段落不同而整段失效。 */
  const ck = cacheKey(settings.model, to, text, settings.style, settings.extraInstructions);
  const hit = (await cacheGetMany([ck]))[ck];
  if (hit && typeof hit.t === "string") {
    port.postMessage({ type: "chunk", content: hit.t });
    port.postMessage({ type: "done", cached: true });
    return;
  }

  let res;
  try {
    res = await requestChat(settings, {
      model: settings.model,
      temperature: Number(settings.temperature) || 0,
      stream: true,
      messages: [
        { role: "system", content: buildSingleSystemPrompt(settings, to) },
        { role: "user", content: buildSingleUserContent(text, context) },
      ],
    }, signal);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    port.postMessage({ type: "error", message: `请求失败 ${e.message}` });
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
  if (full) {
    await cacheSetMany([[ck, full]]);
    port.postMessage({ type: "done" });
  } else {
    port.postMessage({
      type: "error",
      message: "模型只返回了思维链、没有正文：该接口疑似推理模型，请换用非推理模型（如 deepseek-chat 类）或调大输出预算。",
    });
  }
}

/* ---------------- 整页 / PDF：批量引擎 ---------------- */

function buildBatchSystemPrompt(settings, target) {
  let base = stylePrompt(settings, target);
  if (target === "zh") {
    base += "\n" + ZH_BATCH_RULES;
  } else {
    base += " If a glossary is provided, follow it exactly. Preceding paragraphs are context only — do not translate them.";
  }
  /* 附加指令放在风格之后、格式约束之前，避免用户指令冲掉分隔符协议 */
  return withExtra(settings, base) + "\n" + BATCH_FORMAT;
}

function clipText(s, max) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

function plainInline(s) {
  return String(s || "").replace(/<\/?[bi]>/gi, "");
}

function buildSingleUserContent(text, context) {
  const ctx = context || {};
  const blocks = [];
  const selected = String(text || "").trim();
  const title = clipText(ctx.title || "", 200);
  const paragraph = clipText(ctx.paragraph || "", 600);
  if (title) blocks.push("【页面标题】仅供消歧，不要翻译：\n" + title);
  /* 选区就是整段时不再重复贴上下文，否则模型会看到「不要翻译」和「请翻译」是同一段 */
  if (paragraph && paragraph !== clipText(selected, 600)) {
    blocks.push("【所在段落】仅供消歧，不要翻译这一段：\n" + paragraph);
  }
  const glossaryText = String(ctx.glossaryText || formatGlossary(ctx.glossary) || "").trim();
  if (glossaryText) blocks.push("【术语表】必须沿用：\n" + glossaryText);
  if (ctx.prev && ctx.prev.length) {
    blocks.push("【前文】仅供衔接，不要翻译：\n" + ctx.prev.join("\n\n"));
  }
  if (blocks.length === 0) return selected;
  blocks.push("【待译文本】只翻译下面的内容：\n" + selected);
  return blocks.join("\n\n");
}

function buildBatchUserContent(batch, docCtx) {
  const ctx = docCtx || {};
  const brief = ctx.brief || {};
  const blocks = [];
  const lines = [];
  if (brief.title) lines.push("标题：" + clipText(brief.title, 200));
  if (brief.site) lines.push("站点/领域：" + clipText(brief.site, 120));
  if (brief.description) lines.push("简介：" + clipText(brief.description, 500));
  if (lines.length) blocks.push("【文档】背景信息，不要翻译：\n" + lines.join("\n"));
  const glossaryText = String(ctx.glossaryText || formatGlossary(ctx.glossary) || "").trim();
  if (glossaryText) blocks.push("【术语表】全篇统一，必须沿用：\n" + glossaryText);
  if (ctx.prev && ctx.prev.length) {
    blocks.push("【前文】仅供衔接参考，不要翻译：\n" + ctx.prev.join("\n\n"));
  }
  const body = batch.map((s) => "<<<" + s.id + ">>>\n" + s.text).join("\n\n");
  blocks.push("【待译段落】按顺序翻译。每段以同样的分隔符独占一行开头，后面只写译文：\n\n" + body);
  return blocks.join("\n\n");
}

function buildGlossaryMessages(target, doc) {
  const d = doc || {};
  const into = target === "zh" ? "简体中文" : langName(target);
  const system = target === "zh"
    ? "你是科技翻译的术语编辑。阅读文档信息，列出 10 到 40 个关键术语的统一中文译法，供后文严格沿用。\n" +
      "规则：\n" +
      "- 每行一条，格式为「原文术语 => 译法」，不要编号，不要解释，不要翻译整段正文\n" +
      "- 专有名词、产品名、模型名、代码标识符保留英文，例如 Claude Code、MCP、token、prompt\n" +
      "- 同一个概念只给一种译法"
    : "You build a translation glossary into " + into + ". " +
      "Output 10 to 40 lines, each exactly \"source term => translation\". " +
      "No numbering, no explanations, no full-text translation. " +
      "Keep proper nouns, product names, model names, and code identifiers unchanged. One rendering per concept.";
  const parts = [];
  if (d.title) parts.push("标题：" + clipText(d.title, 200));
  if (d.site) parts.push("站点/领域：" + clipText(d.site, 120));
  if (d.description) parts.push("简介：\n" + clipText(d.description, 1000));
  if (d.sample) parts.push("正文摘录：\n" + clipText(d.sample, 1800));
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") || "（无文档信息）" },
  ];
}

function parseGlossary(text) {
  const cleaned = stripFences(text);
  const out = [];
  const seen = new Set();
  for (const raw of cleaned.split(/\n+/)) {
    const line = raw.trim().replace(/^[-*•]+\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    const m = line.match(/^(.{1,48}?)\s*(?:=>|->|→)\s*(.{1,40})$/);
    if (!m) continue;
    const src = m[1].trim().replace(/^["'「『]|["'」』]$/g, "");
    const dst = m[2].trim().replace(/^["'「『]|["'」』]$/g, "");
    if (!src || !dst) continue;
    if (/[。！？!?]/.test(src)) continue;
    const key = src.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src, dst });
    if (out.length >= 40) break;
  }
  return out;
}

function formatGlossary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return entries.map((e) => e.src + " => " + e.dst).join("\n");
}

/* 只剥掉整段回复外层的代码围栏，避免误伤译文里的代码块 */
function stripFences(text) {
  let t = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/＜＜＜/g, "<<<")
    .replace(/＞＞＞/g, ">>>")
    .trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*[ \t]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  return t;
}

function extractJsonObject(text) {
  const cleaned = stripFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) { /* 继续尝试大括号截取 */ }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (e) { /* 放弃 */ }
  }
  return {};
}

/* 分隔符协议优先；模型仍返回 JSON 时回退。只认本批 id，避免正文里偶然出现的括号被当成分段。
 * 同一 id 出现多次时取最后一段非空正文（模型先回显原文、再给译文的情况）。 */
function parseBatchOutput(text, ids) {
  const cleaned = stripFences(text);
  const idSet = new Set(ids);
  const re = /<<<\s*([A-Za-z0-9_-]+)\s*>>>/g;
  const marks = [];
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (!idSet.has(m[1])) continue;
    marks.push({ id: m[1], start: m.index, end: m.index + m[0].length });
  }
  const delimited = {};
  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? marks[i + 1].start : cleaned.length;
    const body = cleaned.slice(marks[i].end, to).trim();
    if (body) delimited[marks[i].id] = body;
  }
  const found = ids.filter((id) => delimited[id]);
  if (found.length > 0) {
    const result = {};
    for (const id of ids) result[id] = delimited[id] || "";
    return result;
  }
  const json = extractJsonObject(cleaned);
  const result = {};
  for (const id of ids) result[id] = typeof json[id] === "string" ? json[id].trim() : "";
  return result;
}

/* 约 2500–3500 字符一批。段数只做上限，阅读顺序不被打乱。
 * 单段超过预算时单独成批，避免把跨页缝合后的长段落再切开。 */
const BATCH_CHAR_BUDGET = 3200;

function chunkSegments(items, size, charBudget = BATCH_CHAR_BUDGET) {
  const out = [];
  let batch = [];
  let chars = 0;
  const limit = Math.max(1, Number(size) || 8);
  const budget = Math.max(500, Number(charBudget) || BATCH_CHAR_BUDGET);
  for (const item of items) {
    const len = String(item.text || "").length;
    if (batch.length > 0 && (batch.length >= limit || chars + len > budget)) {
      out.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += len;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/* 缓存命中会在连续段落中间挖洞。按洞切开，避免把互不相邻的段落塞进同一次请求。 */
function planBatches(segments, missIds, size, charBudget) {
  const miss = missIds instanceof Set ? missIds : new Set(missIds);
  const batches = [];
  for (const chunk of chunkSegments(segments, size, charBudget)) {
    let run = [];
    const flush = () => {
      if (run.length > 0) {
        batches.push(run);
        run = [];
      }
    };
    for (const seg of chunk) {
      if (miss.has(seg.id)) run.push(seg);
      else flush();
    }
    flush();
  }
  return batches;
}

function prevSourceTexts(segments, batch, count = 2, maxLen = 500) {
  if (!batch || batch.length === 0) return [];
  const idx = segments.findIndex((s) => s.id === batch[0].id);
  if (idx <= 0) return [];
  return segments
    .slice(Math.max(0, idx - count), idx)
    .map((s) => clipText(plainInline(s.text), maxLen));
}

/* 本页开头的批次没有前文。PDF 按页请求时，用上一页末尾 1–2 段补上。 */
function batchPrev(segments, batch, leading, count = 2, maxLen = 500) {
  const local = prevSourceTexts(segments, batch, count, maxLen);
  if (!batch || batch.length === 0) return local;
  const idx = segments.findIndex((s) => s.id === batch[0].id);
  if (idx > 0) return local;
  const head = (Array.isArray(leading) ? leading : [])
    .map((t) => clipText(plainInline(t), maxLen))
    .filter(Boolean);
  return head.slice(-(count - local.length)).concat(local).slice(-count);
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

async function translateBatchCall(settings, target, batch, signal, docCtx) {
  const messages = [
    { role: "system", content: buildBatchSystemPrompt(settings, target) },
    { role: "user", content: buildBatchUserContent(batch, docCtx) },
  ];
  const content = await chatWithRetry(settings, messages, { signal, retries: 2 });
  const parsed = parseBatchOutput(content, batch.map((s) => s.id));
  return batch.map((s) => ({
    id: s.id,
    translation: cleanTranslation(s.text, parsed[s.id]),
  }));
}

/* 整段原文被原样回显时视为没译出来，交给逐段兜底。短专名允许中英相同。 */
function cleanTranslation(src, out) {
  const t = String(out || "").trim();
  if (!t) return "";
  if (t === String(src || "").trim() && t.length > 80) return "";
  return t;
}

async function translateSingleFallback(settings, target, seg, signal, docCtx) {
  try {
    const messages = [
      { role: "system", content: buildSingleSystemPrompt(settings, target) },
      {
        role: "user",
        content: buildSingleUserContent(seg.text, {
          title: docCtx?.brief?.title,
          glossaryText: docCtx?.glossaryText,
          prev: docCtx?.prev,
        }),
      },
    ];
    const translation = await chatWithRetry(settings, messages, { signal, retries: 1 });
    return { id: seg.id, translation: translation.trim() };
  } catch (e) {
    return { id: seg.id, translation: "", error: e.message };
  }
}

/* 术语表跟文档走，不跟某一批走。同 docId 并发进来时共用一个请求；
 * 结果写入 storage.session，service worker 被回收后同一浏览器会话里还能复用。 */
const glossaryInflight = new Map();

function glossaryStorageKey(settings, target, docId) {
  return "tg_" + hashKey([
    PROMPT_VERSION,
    settings.model,
    target,
    normalizeStyle(settings.style),
    docId,
  ].join("\u0001")).slice(3);
}

function glossaryUsable(doc) {
  if (!doc || !doc.docId) return false;
  return Boolean(
    String(doc.title || "").trim() ||
    String(doc.description || "").trim() ||
    String(doc.sample || "").trim()
  );
}

async function storageSessionGet(key) {
  const area = typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
  if (!area) return null;
  try {
    const got = await area.get(key);
    return Object.prototype.hasOwnProperty.call(got, key) ? got[key] : null;
  } catch (e) {
    return null;
  }
}

async function storageSessionSet(key, value) {
  const area = typeof chrome !== "undefined" && chrome.storage && chrome.storage.session;
  if (!area) return;
  try {
    await area.set({ [key]: value });
  } catch (e) { /* 会话存储失败时只留在内存 */ }
}

function glossaryEntriesOk(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((e) => e && typeof e.src === "string" && typeof e.dst === "string");
}

async function ensureGlossary(settings, target, doc, signal) {
  if (signal?.aborted) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  if (!glossaryUsable(doc)) return [];
  const key = glossaryStorageKey(settings, target, doc.docId);
  const pending = glossaryInflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    const cached = await storageSessionGet(key);
    if (glossaryEntriesOk(cached)) return cached;
    /* 不绑定某一页的取消信号。PDF 每页一条连接，关掉其中一页不应让其他页的术语表一起失败。 */
    const content = await chatWithRetry(
      settings,
      buildGlossaryMessages(target, doc),
      { retries: 1, maxTokens: 900 }
    );
    const entries = parseGlossary(content);
    if (entries.length > 0) await storageSessionSet(key, entries);
    return entries;
  })();

  glossaryInflight.set(key, job);
  try {
    return await job;
  } catch (e) {
    glossaryInflight.delete(key);
    throw e;
  }
}

async function pageTranslate({ segments, target, doc }, port, signal) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    port.postMessage({ type: "error", needsSetup: true, message: "尚未配置 API Key，请先在设置页填写。" });
    return;
  }
  const list = Array.isArray(segments) ? segments : [];
  const total = list.length;
  let done = 0;

  /* 1. 批量查缓存。键不含文档上下文，已译过的句子直接复用。 */
  const keyBySeg = new Map(list.map((s) => [
    s.id,
    cacheKey(settings.model, target, s.text, settings.style, settings.extraInstructions),
  ]));
  const cachedValues = await cacheGetMany([...keyBySeg.values()]);
  const cachedResults = [];
  const missIds = new Set();
  for (const s of list) {
    const hit = cachedValues[keyBySeg.get(s.id)];
    if (hit && typeof hit.t === "string") cachedResults.push({ id: s.id, translation: hit.t });
    else missIds.add(s.id);
  }
  if (cachedResults.length > 0) {
    done += cachedResults.length;
    port.postMessage({ type: "results", results: cachedResults });
    port.postMessage({ type: "progress", done, total });
  }
  if (missIds.size === 0) {
    if (!signal.aborted) port.postMessage({ type: "done" });
    return;
  }

  /* 2. 整篇一份术语表，所有批次共用。失败不阻断翻译。 */
  let glossary = [];
  if (!signal.aborted) {
    try {
      glossary = await ensureGlossary(settings, target, doc || null, signal);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      glossary = [];
    }
  }
  if (signal.aborted) return;

  const docCtxBase = {
    brief: doc ? {
      title: doc.title || "",
      site: doc.site || "",
      description: doc.description || "",
    } : null,
    glossaryText: formatGlossary(glossary),
  };

  /* 3. 按字符预算切连续段落，再按缓存洞切开，并发保持不变 */
  const size = Math.max(1, Number(settings.pageBatchSize) || 8);
  const batches = planBatches(list, missIds, size, BATCH_CHAR_BUDGET);
  await runPool(batches, Math.max(1, Number(settings.pageConcurrency) || 3), async (batch) => {
    if (signal.aborted) return;
    const docCtx = { ...docCtxBase, prev: batchPrev(list, batch, doc && doc.leading, 2, 500) };
    let results;
    try {
      results = await translateBatchCall(settings, target, batch, signal, docCtx);
    } catch (e) {
      if (e.name === "AbortError") return;
      results = batch.map((s) => ({ id: s.id, translation: "", error: e.message }));
    }
    /* 批量协议漏掉的段落逐段兜底，兜底同样带上简报和术语表 */
    const missing = results.filter((r) => !r.translation && !r.error);
    if (missing.length > 0 && !signal.aborted) {
      const byId = new Map(batch.map((s) => [s.id, s]));
      const fixed = await Promise.all(
        missing.map((r) => translateSingleFallback(settings, target, byId.get(r.id), signal, docCtx))
      );
      const fixedById = new Map(fixed.map((r) => [r.id, r]));
      results = results.map((r) => fixedById.get(r.id) || r);
    }
    if (signal.aborted) return;
    const toCache = results
      .filter((r) => r.translation)
      .map((r) => {
        const seg = batch.find((s) => s.id === r.id);
        return [cacheKey(settings.model, target, seg.text, settings.style, settings.extraInstructions), r.translation];
      });
    await cacheSetMany(toCache);
    done += results.length;
    port.postMessage({ type: "results", results });
    port.postMessage({ type: "progress", done, total });
  });

  if (!signal.aborted) port.postMessage({ type: "done" });
}

/* ---------------- Port 分发 ---------------- */

if (typeof chrome !== "undefined" && chrome.runtime?.onConnect) chrome.runtime.onConnect.addListener((port) => {
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

/* ---------------- 设置页：测试连接 / 拉取模型列表 ---------------- */

async function listModels({ baseUrl, apiKey }) {
  const candidates = endpointCandidates(baseUrl, "models");
  if (candidates.length === 0) throw new Error("请先填写 Base URL");
  if (!apiKey) throw new Error("请先填写 API Key");
  let res;
  for (let i = 0; i < candidates.length; i++) {
    res = await fetch(candidates[i], { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status !== 404 || i === candidates.length - 1) break;
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${res.status}${detail ? "：" + detail : ""}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    /* 网关在错误路径上可能返回 SPA 首页 HTML，解析失败即视为未找到列表 */
    throw new Error("接口未返回模型列表（返回的不是 JSON，可能是页面而非 API）");
  }
  const arr = Array.isArray(data) ? data
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
    : [];
  const ids = arr
    .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model))
    .filter((x) => typeof x === "string" && x);
  if (ids.length === 0) throw new Error("接口未返回模型列表（可能需要不同的端点或权限）");
  return [...new Set(ids)];
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "lt:open-options") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg.type === "lt:list-models") {
    (async () => {
      try {
        sendResponse({ ok: true, models: await listModels(msg.settings || {}) });
      } catch (e) {
        sendResponse({ ok: false, message: e.message || String(e) });
      }
    })();
    return true;
  }
  if (msg.type !== "lt:test-connection") return false;
  (async () => {
    const started = Date.now();
    try {
      const settings = { ...DEFAULT_SETTINGS, ...msg.settings };
      if (!settings.apiKey) throw new Error("请先填写 API Key");
      /* 推理模型会先输出思维链，预算给小了正文就是空的 —— 这里给足并允许空正文，
         只要 HTTP 200 且响应结构合法就算连接可用。 */
      const content = await chatOnce(
        settings,
        [{ role: "user", content: "Reply with the single word: pong" }],
        { maxTokens: 512, allowEmpty: true }
      );
      sendResponse({
        ok: true,
        ms: Date.now() - started,
        reply: content.trim().slice(0, 40),
        empty: !content.trim(),
      });
    } catch (e) {
      sendResponse({ ok: false, ms: Date.now() - started, message: e.message || String(e) });
    }
  })();
  return true;
});

/* ---------------- 右键菜单 ---------------- */

if (typeof chrome !== "undefined" && chrome.runtime?.onInstalled) chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "lt-translate-selection",
    title: "轻译：翻译所选文本",
    contexts: ["selection"],
  });
  pruneCache();
});

if (typeof chrome !== "undefined" && chrome.contextMenus?.onClicked) chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "lt-translate-selection" && tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "lt:translate-selection" }).catch(() => {});
  }
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PROMPT_VERSION,
    BATCH_CHAR_BUDGET,
    normalizeStyle,
    cacheKey,
    hashKey,
    buildSingleSystemPrompt,
    buildBatchSystemPrompt,
    buildSingleUserContent,
    buildBatchUserContent,
    buildGlossaryMessages,
    parseGlossary,
    formatGlossary,
    parseBatchOutput,
    extractJsonObject,
    chunkSegments,
    planBatches,
    prevSourceTexts,
    batchPrev,
    clipText,
    cleanTranslation,
    stripFences,
  };
}
