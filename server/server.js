import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";

const PORT = Number(process.env.PORT || 8787);

let kbCache = { loaded: false, ok: false, index: null, error: "" };

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function resolveApiKey() {
  const candidates = [process.env.OPENAI_API_KEY, process.env.DEEPSEEK_API_KEY]
    .map((v) => sanitizeEnvValue(String(v || "")))
    .filter(Boolean);
  const key = candidates[0] || "";
  const invalid =
    !key ||
    key.includes("请替换") ||
    key.toLowerCase().includes("your_key_here");
  if (invalid) {
    throw new Error(
      "Missing env: OPENAI_API_KEY（请在 server/.env 填入真实 DeepSeek Key，或使用 DEEPSEEK_API_KEY）"
    );
  }
  return key;
}

function sanitizeEnvValue(v) {
  let s = String(v || "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

async function loadFlow() {
  const p = path.join(process.cwd(), "flows", "default.flow.json");
  const raw = await readFile(p, "utf-8");
  return JSON.parse(raw);
}

async function loadEnvIfExists() {
  const envPath = path.join(process.cwd(), ".env");
  try {
    await access(envPath, fsConstants.F_OK);
  } catch {
    return;
  }

  const raw = await readFile(envPath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i <= 0) continue;
    const k = trimmed.slice(0, i).trim();
    const v = sanitizeEnvValue(trimmed.slice(i + 1));
    if (!process.env[k]) process.env[k] = v;
  }
}

async function loadKnowledgeIndex() {
  if (kbCache.loaded) return kbCache;
  kbCache.loaded = true;
  const p = path.join(process.cwd(), "knowledge", "index.json");
  try {
    await access(p, fsConstants.F_OK);
  } catch {
    kbCache.ok = false;
    kbCache.index = null;
    kbCache.error =
      "未找到知识库索引（server/knowledge/index.json）。请先运行导入脚本把 data/ 下的 PDF 建库。";
    return kbCache;
  }

  try {
    const raw = await readFile(p, "utf-8");
    const index = JSON.parse(raw);
    kbCache.ok = true;
    kbCache.index = index;
    kbCache.error = "";
    return kbCache;
  } catch (e) {
    kbCache.ok = false;
    kbCache.index = null;
    kbCache.error = `知识库索引解析失败：${String(e?.message || e)}`;
    return kbCache;
  }
}

function normalizeText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForRecall(s) {
  const t = normalizeText(s).toLowerCase();
  const chars = Array.from(t).filter((c) => /[a-z0-9\u4e00-\u9fff]/i.test(c));
  // 中文用字符粒度更稳；英文/数字也可用字符召回
  const tokens = [];
  for (let i = 0; i < chars.length; i += 1) tokens.push(chars[i]);
  // 追加少量双字 token，提升短词命中
  for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(`${chars[i]}${chars[i + 1]}`);
  return tokens;
}

function scoreChunk({ queryTokens, queryText, chunk }) {
  const text = normalizeText(chunk.text || "").toLowerCase();
  if (!text) return 0;
  let hit = 0;
  for (const tok of queryTokens) {
    if (tok && text.includes(tok)) hit += 1;
  }
  // 直接短语加权
  const phraseBonus =
    queryText && queryText.length >= 2 && text.includes(queryText.toLowerCase()) ? 8 : 0;
  const priorityBonus = Number(chunk.priority || 0) >= 2 ? 6 : 0; // 教参优先
  return hit + phraseBonus + priorityBonus;
}

function retrieveCitations(index, question, topK = 3) {
  const chunks = Array.isArray(index?.chunks) ? index.chunks : [];
  const q = normalizeText(question || "");
  if (!q || chunks.length === 0) return [];

  const queryTokens = tokenizeForRecall(q).slice(0, 80);
  const scored = [];
  for (const chunk of chunks) {
    const s = scoreChunk({ queryTokens, queryText: q, chunk });
    if (s > 0) scored.push({ s, chunk });
  }
  scored.sort((a, b) => b.s - a.s);

  const picked = [];
  const seen = new Set();
  for (const item of scored) {
    const c = item.chunk;
    const key = `${c.source}#${c.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({
      sourceKind: c.sourceKind || "资料",
      source: c.source || "",
      page: Number(c.page || 0) || null,
      text: normalizeText(c.text || "").slice(0, 220),
    });
    if (picked.length >= topK) break;
  }
  return picked;
}

function safeJsonParse(text) {
  const trimmed = String(text || "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function llmJson({ system, user, model }) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1";
  const apiKey = resolveApiKey();
  const m = model || process.env.OPENAI_MODEL || "Qwen/Qwen3-14B";

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: m,
      temperature: 0.3,
      max_tokens: 420,
      messages: [
        system ? { role: "system", content: system } : null,
        { role: "user", content: user },
      ].filter(Boolean),
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`LLM error ${resp.status}: ${t}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const json = safeJsonParse(content);
  if (!json) {
    throw new Error(`LLM returned non-JSON: ${content.slice(0, 200)}`);
  }
  return json;
}

function providerInfo() {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1";
  const model = process.env.OPENAI_MODEL || "Qwen/Qwen3-14B";
  const key = (() => {
    try {
      return resolveApiKey();
    } catch {
      return "";
    }
  })();
  return {
    baseUrl,
    model,
    hasApiKey: Boolean(key),
    apiKeyLength: key.length,
    apiKeyMasked: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "",
  };
}

function friendlyError(msg) {
  const text = String(msg || "");
  if (text.includes("401")) return "认证失败：API Key 无效、已过期，或与当前平台不匹配。";
  if (text.includes("402")) return "余额/额度不足：请检查平台账户余额。";
  if (text.includes("429")) return "请求过于频繁：稍后再试。";
  if (text.includes("ENOTFOUND") || text.includes("fetch failed")) return "网络无法访问模型平台地址。";
  return `调用失败：${text}`;
}

function isReliableLink(link) {
  const s = String(link || "").trim();
  if (!s) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  // 只接受更可能直开的站点，避免模型编造或跳登录
  try {
    const u = new URL(s);
    const host = (u.hostname || "").toLowerCase();
    const allow = [
      "mp.weixin.qq.com",
      "nynct.gxzf.gov.cn",
      "www.hnagri.org.cn",
      "cansang.gxnongmu.com",
      "www.linan.gov.cn",
      "www.cnhnb.com",
      "cys.cdmc.edu.cn",
      "www.pandasilk.com",
    ];
    if (!allow.includes(host)) return false;
  } catch {
    return false;
  }
  const badTokens = ["example.com", "localhost", "127.0.0.1", "your_link", "test.com"];
  const lower = s.toLowerCase();
  if (badTokens.some((t) => lower.includes(t))) return false;
  return true;
}

function isWeChatMpLink(link) {
  const s = String(link || "").trim().toLowerCase();
  return /^https?:\/\/mp\.weixin\.qq\.com\//i.test(s);
}

function sanitizeResources(resources) {
  if (!Array.isArray(resources)) return [];
  return resources.slice(0, 4).map((item) => {
    const clean = { ...item };
    clean.title = String(clean.title || "").slice(0, 40);
    clean.summary = String(clean.summary || "").slice(0, 120);
    clean.script = String(clean.script || "").slice(0, 180);
    clean.content = String(clean.content || "").slice(0, 120);
    clean.link = isReliableLink(clean.link) ? clean.link : "";
    clean.needsVerify = clean.link ? isWeChatMpLink(clean.link) : false;
    return clean;
  });
}

function normalizeQuestionForMatch(q) {
  return String(q || "").trim().toLowerCase();
}

function buildFallbackResources(question) {
  const q = normalizeQuestionForMatch(question);
  const hits = [];
  const add = (item) => hits.push({ ...item, needsVerify: Boolean(item.link && isWeChatMpLink(item.link)) });

  // 通用兜底：公众号优先（按用户要求）
  add({
    type: "text",
    title: "养蚕科普与实践（公众号推文）",
    content: "公众号图文，可能需要微信内打开/验证。",
    link: "https://mp.weixin.qq.com/s/ZjyyV8lb8rcYQ2z1Ox9CeQ",
  });
  add({
    type: "text",
    title: "桑蚕饲养经验（公众号推文）",
    content: "公众号图文，可能需要微信内打开/验证。",
    link: "https://mp.weixin.qq.com/s/uARifexiWxkujPNZgfdB3g",
  });

  // 再补“更可能直开”的权威资料（公众号不够时再凑数）
  add({
    type: "text",
    title: "养蚕技术要点——温湿度调控（广西农业农村厅）",
    content: "权威温湿度控制要点与注意事项。",
    link: "http://nynct.gxzf.gov.cn/hdjl/znwd/njzsk/t13147877.shtml",
  });
  add({
    type: "text",
    title: "春蚕饲养关键技术要点（河南省农科院）",
    content: "从小蚕到大蚕的关键技术要点。",
    link: "https://www.hnagri.org.cn/article-105487.html",
  });

  // 养蚕温湿度
  if (/(温|湿|环境|通风|闷|发霉|潮)/.test(q)) {
    add({
      type: "text",
      title: "桑蚕饲养：温度湿度最佳控制（资料汇总）",
      content: "按龄期给出温湿度范围与管理建议。",
      link: "https://www.pandasilk.com/zh-hans/temperature-humidity-requirements-for-mulberry-silkworm-rearing/",
    });
  }

  // 消毒/石灰粉/蚕室蚕具
  if (/(消毒|石灰|漂白|蚕室|蚕具|清洁|病菌)/.test(q)) {
    add({
      type: "text",
      title: "使用石灰粉给蚕体、蚕座消毒注意事项（广西农业农村厅）",
      content: "石灰粉使用方法与常见坑。",
      link: "http://nynct.gxzf.gov.cn/hdjl/znwd/njzsk/t10104166.shtml",
    });
    add({
      type: "text",
      title: "蚕室、蚕具常用消毒药剂使用规范（文字版）",
      content: "常用消毒剂与使用规范参考。",
      link: "https://cys.cdmc.edu.cn/art/2019/10/25/art_607_48338.html",
    });
    add({
      type: "text",
      title: "石灰这样使用养蚕防病才有效（文字版）",
      content: "石灰使用要点与操作提醒。",
      link: "https://cys.cdmc.edu.cn/art/2019/10/25/art_607_48339.html",
    });
  }

  // 上蔟/结茧/吐丝
  if (/(上蔟|上簇|结茧|吐丝|簇具|熟蚕)/.test(q)) {
    add({
      type: "text",
      title: "蚕宝宝的重要上蔟期：上蔟方法与要点（广西农牧蚕桑网）",
      content: "上蔟时机与常用方法介绍。",
      link: "http://cansang.gxnongmu.com/Content.aspx?docId=37024",
    });
    add({
      type: "text",
      title: "规范簇中管理　促蚕茧优质高产（临安政府）",
      content: "簇中管理要点与质量控制。",
      link: "https://www.linan.gov.cn/art/2018/11/28/art_1367636_26131387.html",
    });
  }

  // 过滤+去重+限量
  const out = sanitizeResources(hits).filter((x) => x.link);
  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    if (seen.has(r.link)) continue;
    seen.add(r.link);
    uniq.push(r);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

async function providerCheck() {
  const info = providerInfo();
  if (!info.hasApiKey) {
    return { ok: false, reason: "未读取到 API Key", info };
  }

  const url = `${info.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolveApiKey()}`,
    },
    body: JSON.stringify({
      model: info.model,
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: "user", content: "回复：ok" }],
    }),
  });
  const body = await resp.text().catch(() => "");
  if (!resp.ok) {
    return {
      ok: false,
      reason: friendlyError(`HTTP ${resp.status} ${body}`),
      status: resp.status,
      raw: body.slice(0, 300),
      info,
    };
  }
  return { ok: true, reason: "连接成功，可调用模型。", info };
}

async function providerModels() {
  const info = providerInfo();
  if (!info.hasApiKey) {
    return { ok: false, reason: "未读取到 API Key", info, models: [] };
  }
  const url = `${info.baseUrl}/models`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${resolveApiKey()}` },
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    return {
      ok: false,
      reason: friendlyError(`HTTP ${resp.status} ${text}`),
      status: resp.status,
      raw: text.slice(0, 300),
      info,
      models: [],
    };
  }
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "模型列表返回非 JSON", info, models: [] };
  }
  const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
  return { ok: true, reason: "已获取模型列表", info, models };
}

async function runFlow({ flow, input }) {
  const state = { input, vars: {} };

  for (const node of flow.nodes) {
    if (node.type !== "llm") continue;

    const user = [
      `【用户问题】${input.question || ""}`,
      input.imageHint ? `【图片提示】${input.imageHint}` : "",
      input.kbHits && input.kbHits.length
        ? `【资料库命中（优先教参）】\n${input.kbHits
            .map(
              (h, i) =>
                `(${i + 1}) 来源=${h.sourceKind}/${h.source} 页=${h.page || "?"}\n片段：${h.text}`
            )
            .join("\n\n")}`
        : "",
      state.vars.compose ? `【上一步结果】${JSON.stringify(state.vars.compose)}` : "",
      "",
      `【任务】${node.prompt}`,
    ]
      .filter(Boolean)
      .join("\n");

    const out = await llmJson({
      system:
        "你是一个严谨的 JSON 输出助手。务必只输出有效 JSON，不要输出解释文字，不要使用 Markdown 代码块。",
      user,
    });

    state.vars[node.id] = out;
  }

  const classify = state.vars.classify || {};
  const answer = state.vars.answer || {};
  const resources = state.vars.resources || {};
  const quiz = state.vars.quiz || {};
  const compose = state.vars.compose || {};
  const answerText = compose.answer || answer.answer || "我先听懂你的问题啦。你可以再说详细一点点吗？";
  const cleanAnswer = String(answerText).replace(/\s+/g, " ").trim().slice(0, 200);
  const resourceListRaw = Array.isArray(compose.resources)
    ? compose.resources
    : Array.isArray(resources.resources)
      ? resources.resources
      : [];
  const resourceList = (() => {
    const cleaned = sanitizeResources(resourceListRaw).filter((x) => x.link);
    const fallback = buildFallbackResources(input?.question || "");
    const out = [];
    const seen = new Set();
    for (const r of cleaned) {
      if (!r?.link || seen.has(r.link)) continue;
      seen.add(r.link);
      out.push(r);
      if (out.length >= 3) return out;
    }
    for (const r of fallback) {
      if (!r?.link || seen.has(r.link)) continue;
      seen.add(r.link);
      out.push(r);
      if (out.length >= 3) break;
    }
    return out;
  })();
  const quizData = compose.quiz || quiz.quiz || null;
  const followup = compose.followup || classify.followup_questions || [];

  return {
    category: compose.category || classify.category || "其他",
    risk: compose.risk || classify.risk || "低",
    followup: Array.isArray(followup) ? followup : [],
    answer: cleanAnswer,
    resources: resourceList,
    quiz: quizData,
    citations: Array.isArray(input?.kbHits) ? input.kbHits : [],
  };
}

function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  withCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function main() {
  await loadEnvIfExists();
  // 启动时尝试加载一次知识库（失败也不影响服务启动）
  await loadKnowledgeIndex();

  const server = createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = req.url || "/";
    const u = new URL(url, `http://localhost:${PORT}`);

    if (method === "OPTIONS") {
      withCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === "GET" && url === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && url === "/api/provider-info") {
      sendJson(res, 200, { ok: true, result: providerInfo() });
      return;
    }

    if (method === "GET" && url === "/api/provider-check") {
      try {
        const result = await providerCheck();
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) });
      }
      return;
    }

    if (method === "GET" && url === "/api/provider-models") {
      try {
        const result = await providerModels();
        sendJson(res, 200, { ok: true, result });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) });
      }
      return;
    }

    if (method === "GET" && u.pathname === "/api/fallback-resources") {
      const q = u.searchParams.get("question") || "";
      const resources = buildFallbackResources(q);
      sendJson(res, 200, { ok: true, result: { question: q, resources } });
      return;
    }

    if (method === "POST" && url === "/api/ask") {
      try {
        const body = await readJsonBody(req);
        const { question, imageName } = body || {};
        const flow = await loadFlow();

        const kb = await loadKnowledgeIndex();
        const kbHits =
          kb.ok && kb.index
            ? retrieveCitations(kb.index, String(question || ""), 3)
            : [];

        try {
          const result = await runFlow({
            flow,
            input: {
              question: String(question || ""),
              imageHint: imageName ? `用户上传了图片文件名：${imageName}` : "",
              kbHits,
            },
          });
          sendJson(res, 200, { ok: true, result });
        } catch (e) {
          const msg = String(e?.message || e);
          // 没有 Key / 调用失败时，至少用资料库命中给出可用答案，避免整页“卡死”
          const fallbackAnswer = (() => {
            if (!kbHits.length) return "我还没在资料库里找到匹配原文。你可以换个说法再问一次。";
            // 按用户要求：通俗回答里不显示任何“引用原文片段”
            return "我在资料库里找到了相关内容，但当前模型服务不可用，所以先不给你贴原文。你可以把问题再说具体一点（比如哪一龄、温度/湿度/喂桑叶），我会尽量用通俗话总结给你。";
          })();
          sendJson(res, 200, {
            ok: true,
            result: {
              category: "其他",
              risk: "低",
              followup: [],
              answer: fallbackAnswer.replace(/\s+/g, " ").trim().slice(0, 200),
              resources: buildFallbackResources(String(question || "")),
              quiz: null,
              citations: kbHits,
              note: friendlyError(msg),
            },
          });
        }
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message || e) });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not Found" });
  });

  server.listen(PORT, () => {
    console.log(`server listening on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

