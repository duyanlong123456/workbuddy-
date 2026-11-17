#!/usr/bin/env node
/**
 * WorkBuddy -> OpenAI-compatible bridge
 *
 * Reads WorkBuddy login state (plaintext JWT) fresh per request, then proxies
 * /v1/chat/completions to https://copilot.tencent.com/v2/chat/completions.
 * Upstream only supports streaming, so non-stream requests are aggregated here.
 *
 * Zero dependencies. Node >= 18 (global fetch).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.WB_BRIDGE_PORT || 17399);
const HOST = "127.0.0.1";
const UPSTREAM = "https://copilot.tencent.com/v2/chat/completions";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the WorkBuddy auth file for the current user (or WB_AUTH_FILE override). */
function defaultAuthFile() {
  const candidates = [];
  const fromEnv = process.env.WB_AUTH_FILE;
  if (fromEnv) return fromEnv;
  const local = process.env.LOCALAPPDATA;
  if (local) {
    candidates.push(
      path.join(local, "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
    );
  }
  const profile = process.env.USERPROFILE;
  if (profile) {
    candidates.push(
      path.join(profile, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"),
    );
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return candidates[0] || "";
}
const AUTH_FILE = defaultAuthFile();
const TOKEN_CACHE = path.join(HERE, "token-cache.json");
const REFRESH_PS1 = path.join(HERE, "refresh-token.ps1");

const MODELS = [
  "auto",
  "hy4-preview",
  "hy4-preview-x",
  "hy3",
  "hy3-x",
  "space-bunny",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "kimi-k2.7",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "minimax-m3",
  "step-5-preview",
];
const MODEL_SET = new Set(MODELS);
const FALLBACK_MODEL = process.env.WB_FALLBACK_MODEL || "auto";

/** Remap any model the upstream cannot serve (e.g. codex built-in gpt-*) to the fallback. */
function resolveModel(requested) {
  if (!requested || !MODEL_SET.has(requested)) {
    if (requested) console.warn(`[wb-bridge] model "${requested}" not supported -> "${FALLBACK_MODEL}"`);
    return FALLBACK_MODEL;
  }
  return requested;
}

function readTokenCache() {
  try {
    const c = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    if (typeof c.token === "string" && c.token.length > 500 && Number(c.exp) * 1000 > Date.now() + 30_000) {
      return c;
    }
  } catch {}
  return null;
}

let refreshSpawnedAt = 0;
function ensureRefresh(reason) {
  const now = Date.now();
  if (now - refreshSpawnedAt < 5 * 60_000) return;
  refreshSpawnedAt = now;
  try {
    const p = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", REFRESH_PS1],
      { detached: true, stdio: "ignore" },
    );
    p.unref();
    console.warn(`[wb-bridge] token refresh started in background (${reason})`);
  } catch (e) {
    console.warn(`[wb-bridge] refresh spawn failed: ${e.message}`);
  }
}

/**
 * WorkBuddy >= 2026-10 stores accessToken encrypted ($wbEncrypted envelope).
 * Fallback chain: plaintext auth file -> token-cache.json (from memory scan)
 * -> kick off background refresh and ask client to retry.
 */
function loadAuth() {
  if (!AUTH_FILE || !fs.existsSync(AUTH_FILE)) {
    const err = new Error(
      `找不到 WorkBuddy 登录文件：${AUTH_FILE || "(未解析到路径)"}。请先安装并登录 WorkBuddy 桌面版，或用环境变量 WB_AUTH_FILE 指定路径。`,
    );
    err.status = 503;
    throw err;
  }
  const raw = fs.readFileSync(AUTH_FILE, "utf8");
  const j = JSON.parse(raw);
  const uid = j?.account?.uid;
  if (!uid) throw new Error("auth file missing uid");
  const at = j?.auth?.accessToken;
  if (typeof at === "string" && at.length > 500) {
    return { token: at, uid, expiresAt: j.auth.expiresAt || 0 };
  }
  const cache = readTokenCache();
  if (cache) {
    if (Number(cache.exp) * 1000 < Date.now() + 3600_000) ensureRefresh("cache nearing expiry");
    return { token: cache.token, uid, expiresAt: Number(cache.exp) * 1000 };
  }
  ensureRefresh("no usable token");
  const err = new Error(
    "WorkBuddy token 缓存缺失，已启动后台刷新（扫 WorkBuddy 进程内存，约 1-3 分钟），请稍后重试；若持续失败请打开 WorkBuddy",
  );
  err.status = 503;
  throw err;
}

function jsonError(res, status, message, type = "invalid_request_error") {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse upstream SSE into events; supports chunk-split data lines. */
function createSseAccumulator() {
  let buf = "";
  return {
    push(text, onEvent) {
      buf += text;
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* ignore malformed chunk */
          }
        }
      }
    },
    flush(onEvent) {
      if (buf.trim()) this.push("\n\n", onEvent);
    },
  };
}

/** Merge streamed chunks into one ChatCompletion-shaped object. */
function makeAggregator(model, id, created) {
  const state = {
    id: id || "chatcmpl-wb",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "" }, finish_reason: null }],
    usage: null,
  };
  const toolMap = new Map();
  return {
    feed(ev) {
      if (ev.id) state.id = ev.id;
      if (ev.model) state.model = ev.model;
      if (ev.created) state.created = ev.created;
      if (ev.usage) state.usage = ev.usage;
      const c = ev.choices?.[0];
      if (!c) return;
      const msg = state.choices[0].message;
      const d = c.delta || {};
      if (d.role) msg.role = d.role;
      if (d.content) msg.content += d.content;
      if (d.reasoning_content) msg.reasoning_content = (msg.reasoning_content || "") + d.reasoning_content;
      if (d.reasoning) msg.reasoning = (msg.reasoning || "") + d.reasoning;
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        if (!toolMap.has(i)) {
          toolMap.set(i, {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const t = toolMap.get(i);
        if (tc.id) t.id = tc.id;
        if (tc.type) t.type = tc.type;
        if (tc.function?.name) t.function.name += tc.function.name;
        if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
      }
      if (c.finish_reason) state.choices[0].finish_reason = c.finish_reason;
    },
    done() {
      if (toolMap.size) {
        state.choices[0].message.tool_calls = [...toolMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, t]) => t);
        if (!state.choices[0].finish_reason) state.choices[0].finish_reason = "tool_calls";
      }
      if (!state.choices[0].finish_reason) state.choices[0].finish_reason = "stop";
      if (!state.usage) state.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      return state;
    },
  };
}

async function handleChat(req, res) {
  let auth;
  try {
    auth = loadAuth();
  } catch (e) {
    return jsonError(
      res,
      e.status || 503,
      `无法读取 WorkBuddy 登录态（${AUTH_FILE}）: ${e.message}。`,
      "authentication_error",
    );
  }
  if (auth.expiresAt && auth.expiresAt < Date.now()) {
    console.warn(`[wb-bridge] token expired at ${new Date(auth.expiresAt).toISOString()}, trying anyway`);
  }

  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return jsonError(res, 400, "invalid JSON body");
  }
  const wantStream = payload.stream !== false;
  payload.stream = true;
  delete payload.stream_options;
  payload.model = resolveModel(payload.model);

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        "x-codebuddy-request": "1",
        "X-User-Id": auth.uid,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return jsonError(res, 502, `upstream request failed: ${e.message}`, "api_error");
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    let msg = text.slice(0, 800);
    try {
      const j = JSON.parse(text);
      msg = j.msg || j.error?.message || msg;
      if (upstream.status === 401 || upstream.status === 403) {
        msg = `WorkBuddy 登录态失效（HTTP ${upstream.status}）。请打开 WorkBuddy 重新登录。上游: ${msg}`;
      }
    } catch {}
    console.error(`[wb-bridge] upstream ${upstream.status}: ${msg}`);
    return jsonError(res, upstream.status, msg, upstream.status === 401 ? "authentication_error" : "api_error");
  }

  const upstreamModel = payload.model;
  const acc = createSseAccumulator();
  const first = { id: null, created: null };
  const agg = makeAggregator(upstreamModel, null, null);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  /** Decode one chunk -> {text, sawDone}. Feeds both SSE accumulator and (if non-stream) aggregator. */
  const forward = chunk => {
    const t = decoder.decode(chunk, { stream: true });
    acc.push(t, ev => {
      if (!first.id && ev.id) {
        first.id = ev.id;
        first.created = ev.created;
      }
      agg.feed(ev);
    });
    if (t.includes("[DONE]")) return { text: t, sawDone: true };
    return { text: t, sawDone: false };
  };
  const drainRest = async () => {
    let sawDone = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const r = forward(value);
        if (r.sawDone) sawDone = true;
      }
    } catch (e) {
      console.error(`[wb-bridge] stream read error: ${e.message}`);
    }
    const tail = decoder.decode();
    if (tail) acc.push(tail, ev => agg.feed(ev));
    acc.flush(ev => agg.feed(ev));
    return sawDone;
  };

  if (wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let sawDone = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const r = forward(value);
        if (r.text) res.write(r.text);
        if (r.sawDone) {
          sawDone = true;
          break;
        }
      }
    } catch (e) {
      console.error(`[wb-bridge] stream error: ${e.message}`);
    }
    if (!sawDone) res.write("\n\ndata: [DONE]\n\n");
    res.end();
    return;
  }

  await drainRest();
  const result = agg.done();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

/* ================= OpenAI Responses API (codex) =================
 * codex 0.150 only supports wire_api="responses". We translate
 * /v1/responses <-> upstream chat completions both directions.
 */
const LOG_FILE = path.join(HERE, "requests.log");
const LOG_MAX_BYTES = Number(process.env.WB_LOG_MAX_BYTES || 8 * 1024 * 1024);
const LOG_ENABLED = process.env.WB_LOG !== "0";

function dbgLog(line) {
  if (!LOG_ENABLED) return;
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, "");
    } catch {}
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + line + "\n");
  } catch {}
}

function mapResponsesToolChoice(tc) {
  if (tc == null) return undefined;
  if (typeof tc === "string") return tc;
  if (typeof tc === "object") {
    if (tc.type === "function" && tc.name) return { type: "function", function: { name: tc.name } };
    if (tc.type === "custom_tool" && tc.name) return { type: "function", function: { name: tc.name } };
  }
  return undefined;
}

function responsesToChatTools(tools) {
  const chatTools = [];
  const customNames = new Set();
  let localShell = false;
  for (const t of tools || []) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "function" || t.function) {
      const f = t.function || t;
      if (!f.name) continue;
      chatTools.push({
        type: "function",
        function: {
          name: f.name,
          description: f.description ?? "",
          parameters: f.parameters ?? { type: "object", properties: {} },
          ...(f.strict !== undefined ? { strict: f.strict } : {}),
        },
      });
    } else if (t.type === "custom_tool" && t.name) {
      customNames.add(t.name);
      chatTools.push({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "Raw input for this custom tool." } },
            required: ["input"],
          },
        },
      });
    } else if (t.type === "local_shell") {
      localShell = true;
      chatTools.push({
        type: "function",
        function: {
          name: "local_shell",
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: { action: { type: "object", description: "Shell action, e.g. {type:'exec', command:[...]}" } },
            required: ["action"],
          },
        },
      });
    }
    // hosted tools (web_search etc.) are skipped: upstream cannot run them
  }
  return { chatTools, customNames, localShell };
}

function toChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  let hasImage = false;
  for (const p of content) {
    if (typeof p === "string") {
      parts.push({ type: "text", text: p });
      continue;
    }
    if (!p || typeof p !== "object") continue;
    if (p.type === "input_image") {
      hasImage = true;
      const url = typeof p.image_url === "string" ? p.image_url : (p.image_url?.url ?? "");
      parts.push({ type: "image_url", image_url: { url } });
    } else if (p.type === "input_file") {
      parts.push({ type: "text", text: `[file: ${p.filename ?? "attachment"}]` });
    } else {
      const text = p.text ?? p.refusal ?? "";
      if (text) parts.push({ type: "text", text });
    }
  }
  if (!hasImage) return parts.map(p => p.text).join("");
  return parts;
}

function responsesInputToMessages(payload) {
  const messages = [];
  if (typeof payload.instructions === "string" && payload.instructions.trim()) {
    messages.push({ role: "system", content: payload.instructions });
  }
  const input = payload.input;
  const items =
    typeof input === "string"
      ? [{ type: "message", role: "user", content: input }]
      : Array.isArray(input)
        ? input
        : [];
  // Parallel tool calls arrive as consecutive `function_call` items. The upstream
  // chat-completions API requires ONE assistant message carrying every tool_call,
  // immediately followed by the matching role:"tool" results. Emitting a separate
  // assistant message per call breaks that invariant ("tool calls and tool results
  // do not match"). So consecutive calls get merged into the same assistant message.
  let pendingToolCallMsg = null;

  const toolCallId = it => it.call_id || it.id || `call_${crypto.randomBytes(6).toString("hex")}`;

  const pushToolCall = tc => {
    if (pendingToolCallMsg) {
      pendingToolCallMsg.tool_calls.push(tc);
      return;
    }
    // If the model just emitted a text message before calling tools, keep them in one
    // assistant turn (chat-completions style) instead of two adjacent assistant messages.
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && !Array.isArray(last.tool_calls)) {
      last.tool_calls = [tc];
      if (last.content === undefined) last.content = null;
      pendingToolCallMsg = last;
      return;
    }
    pendingToolCallMsg = { role: "assistant", content: null, tool_calls: [tc] };
    messages.push(pendingToolCallMsg);
  };

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    switch (it.type) {
      case "message": {
        pendingToolCallMsg = null;
        const role = it.role === "developer" ? "system" : it.role || "user";
        messages.push({ role, content: toChatContent(it.content) });
        break;
      }
      case "function_call": {
        pushToolCall({
          id: toolCallId(it),
          type: "function",
          function: { name: it.name || "", arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) },
        });
        break;
      }
      case "custom_tool_call": {
        pushToolCall({
          id: toolCallId(it),
          type: "function",
          function: { name: it.name || "", arguments: JSON.stringify({ input: typeof it.input === "string" ? it.input : JSON.stringify(it.input ?? "") }) },
        });
        break;
      }
      case "local_shell_call": {
        pushToolCall({
          id: toolCallId(it),
          type: "function",
          function: { name: "local_shell", arguments: JSON.stringify(it.action ?? it.arguments ?? {}) },
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        pendingToolCallMsg = null;
        let out = it.output;
        if (out == null) out = "";
        else if (typeof out !== "string") out = JSON.stringify(out);
        messages.push({ role: "tool", tool_call_id: it.call_id || it.id || "", content: out });
        break;
      }
      case "reasoning":
        break; // upstream cannot consume reasoning items; drop
      default:
        break;
    }
  }
  // Final pass: rebuild the assistant/tool sequence from the tool_calls side so that
  // interrupted turns (call without output, or orphan output without call) cannot poison
  // the conversation. Missing results are backfilled, orphans are dropped.
  const normalized = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    normalized.push(m);
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const next = new Map();
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        next.set(messages[j].tool_call_id, messages[j]);
        j++;
      }
      for (const tc of m.tool_calls) {
        normalized.push(next.get(tc.id) || { role: "tool", tool_call_id: tc.id, content: "[no output was recorded for this call]" });
      }
      i = j - 1;
    }
  }

  if (normalized.length === 0) normalized.push({ role: "user", content: "" });
  return normalized;
}

/** Translate upstream chat-completion SSE events into Responses SSE events. */
function createResponsesTranslator(res, meta) {
  const { model, customNames, localShell } = meta;
  const createdAt = Math.floor(Date.now() / 1000);
  const id = "resp_" + crypto.randomBytes(8).toString("hex");
  let seq = 0;
  let msg = null; // {id, index, text}
  let usage = null;
  const outputItems = []; // final items, index === output_index
  const openFcs = new Map(); // chat index -> {id, callId, name, args, index, kind}

  const send = (type, fields) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  };
  const respSkeleton = status => ({ id, object: "response", created_at: createdAt, status, model, output: [] });

  send("response.created", { response: respSkeleton("in_progress") });
  send("response.in_progress", { response: respSkeleton("in_progress") });

  function ensureMessage() {
    if (msg) return;
    const index = outputItems.length;
    const item = { type: "message", id: `msg_${++seq}_${id}`, status: "in_progress", role: "assistant", content: [] };
    outputItems.push(item);
    msg = { id: item.id, index, text: "" };
    send("response.output_item.added", { output_index: index, item });
    send("response.content_part.added", { item_id: msg.id, output_index: index, content_index: 0, part: { type: "output_text", text: "" } });
  }

  function finishMessage() {
    if (!msg) return;
    const item = outputItems[msg.index];
    send("response.output_text.done", { item_id: msg.id, output_index: msg.index, content_index: 0, text: msg.text });
    send("response.content_part.done", {
      item_id: msg.id,
      output_index: msg.index,
      content_index: 0,
      part: { type: "output_text", text: msg.text, annotations: [] },
    });
    item.status = "completed";
    item.content = [{ type: "output_text", text: msg.text, annotations: [] }];
    send("response.output_item.done", { output_index: msg.index, item });
    msg = null;
  }

  function ensureFc(chatIndex, callId, name) {
    let e = openFcs.get(chatIndex);
    if (e) {
      if (name && !e.name) e.name = name;
      if (callId && !e.callId) e.callId = callId;
      return e;
    }
    const index = outputItems.length;
    const kind = name && customNames.has(name) ? "custom" : name === "local_shell" && localShell ? "local_shell" : "function";
    const itemId = (kind === "custom" ? "ctc_" : kind === "local_shell" ? "ls_" : "fc_") + `${++seq}_${id}`;
    const item =
      kind === "custom"
        ? { type: "custom_tool_call", id: itemId, status: "in_progress", call_id: callId || "", name: name || "", input: "" }
        : kind === "local_shell"
          ? { type: "local_shell_call", id: itemId, status: "in_progress", call_id: callId || "", action: null }
          : { type: "function_call", id: itemId, status: "in_progress", call_id: callId || "", name: name || "", arguments: "" };
    outputItems.push(item);
    e = { id: itemId, callId: callId || "", name: name || "", args: "", index, kind };
    openFcs.set(chatIndex, e);
    send("response.output_item.added", { output_index: index, item });
    return e;
  }

  function onArgsDelta(e, frag) {
    if (!frag) return;
    e.args += frag;
    if (e.kind === "custom") send("response.custom_tool_call_input.delta", { item_id: e.id, output_index: e.index, delta: frag });
    else if (e.kind === "local_shell") return; // local_shell has no arg deltas in protocol; accumulate only
    else send("response.function_call_arguments.delta", { item_id: e.id, output_index: e.index, delta: frag });
  }

  function finishFc(e) {
    const item = outputItems[e.index];
    if (e.kind === "custom") {
      let input = e.args;
      try {
        const parsed = JSON.parse(e.args);
        if (parsed && typeof parsed.input === "string") input = parsed.input;
      } catch {}
      item.input = input;
      item.status = "completed";
      send("response.custom_tool_call_input.done", { item_id: e.id, output_index: e.index, input });
    } else if (e.kind === "local_shell") {
      let action = {};
      try {
        action = JSON.parse(e.args);
      } catch {
        action = { type: "exec", command: [] };
      }
      item.action = action;
      item.status = "completed";
    } else {
      item.arguments = e.args;
      item.status = "completed";
      send("response.function_call_arguments.done", { item_id: e.id, output_index: e.index, arguments: e.args });
    }
    send("response.output_item.done", { output_index: e.index, item });
  }

  function feed(ev) {
    if (ev.usage) usage = ev.usage;
    const c = ev.choices?.[0];
    if (!c) return;
    const d = c.delta || {};
    if (typeof d.content === "string" && d.content) {
      ensureMessage();
      msg.text += d.content;
      send("response.output_text.delta", { item_id: msg.id, output_index: msg.index, content_index: 0, delta: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? 0;
      const e = ensureFc(i, tc.id, tc.function?.name);
      onArgsDelta(e, tc.function?.arguments);
    }
    if (c.finish_reason) done();
  }

  function done() {
    finishMessage();
    for (const e of openFcs.values()) finishFc(e);
    openFcs.clear();
    const usageOut = usage
      ? {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          total_tokens: usage.total_tokens || 0,
          input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
          output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 },
        }
      : { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
    send("response.completed", {
      response: { ...respSkeleton("completed"), output: outputItems, usage: usageOut },
    });
    finished = true;
  }

  let finished = false;
  return {
    feed,
    done,
    isFinished: () => finished,
    /** non-stream path: build final Response JSON from an aggregated chat result */
    buildJson(result) {
      const items = [];
      const m = result.choices?.[0]?.message;
      if (m) {
        if (m.content) items.push({ type: "message", id: `msg_${++seq}_${id}`, status: "completed", role: "assistant", content: [{ type: "output_text", text: m.content, annotations: [] }] });
        for (const tc of m.tool_calls || []) {
          const name = tc.function?.name || "";
          if (customNames.has(name)) {
            let input = tc.function?.arguments ?? "";
            try {
              const parsed = JSON.parse(input);
              if (parsed && typeof parsed.input === "string") input = parsed.input;
            } catch {}
            items.push({ type: "custom_tool_call", id: `ctc_${++seq}_${id}`, status: "completed", call_id: tc.id || "", name, input });
          } else if (name === "local_shell" && localShell) {
            let action = {};
            try {
              action = JSON.parse(tc.function?.arguments ?? "{}");
            } catch {}
            items.push({ type: "local_shell_call", id: `ls_${++seq}_${id}`, status: "completed", call_id: tc.id || "", action });
          } else {
            items.push({ type: "function_call", id: `fc_${++seq}_${id}`, status: "completed", call_id: tc.id || "", name, arguments: tc.function?.arguments ?? "" });
          }
        }
      }
      const usage = result.usage;
      return {
        ...respSkeleton("completed"),
        output: items,
        usage: usage
          ? {
              input_tokens: usage.prompt_tokens || 0,
              output_tokens: usage.completion_tokens || 0,
              total_tokens: usage.total_tokens || 0,
              input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
              output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 },
            }
          : { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      };
    },
  };
}

async function handleResponses(req, res) {
  let auth;
  try {
    auth = loadAuth();
  } catch (e) {
    return jsonError(res, e.status || 503, `无法读取 WorkBuddy 登录态: ${e.message}`, "authentication_error");
  }
  const body = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return jsonError(res, 400, "invalid JSON body");
  }
  const wantStream = payload.stream !== false;
  const { chatTools, customNames, localShell } = responsesToChatTools(payload.tools);
  const messages = responsesInputToMessages(payload);

  const chatPayload = { model: resolveModel(payload.model), messages, stream: true };
  if (chatTools.length) chatPayload.tools = chatTools;
  const tc = mapResponsesToolChoice(payload.tool_choice);
  if (tc) chatPayload.tool_choice = tc;
  if (typeof payload.temperature === "number") chatPayload.temperature = payload.temperature;
  if (typeof payload.top_p === "number") chatPayload.top_p = payload.top_p;
  if (typeof payload.max_output_tokens === "number") chatPayload.max_tokens = payload.max_output_tokens;
  if (typeof payload.parallel_tool_calls === "boolean") chatPayload.parallel_tool_calls = payload.parallel_tool_calls;

  dbgLog(
    JSON.stringify({
      ep: "/v1/responses",
      model: chatPayload.model,
      stream: wantStream,
      tools: (payload.tools || []).map(t => t.type + ":" + (t.name || t.function?.name || "")),
      tool_choice: payload.tool_choice,
      inputTypes: (Array.isArray(payload.input) ? payload.input : []).map(i => i.type || "str"),
      reasoning: payload.reasoning,
      include: payload.include,
      text: payload.text,
      nMessages: messages.length,
    }),
  );
  dbgLog("CHAT_PAYLOAD " + JSON.stringify({ ...chatPayload, messages: chatPayload.messages }));

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + auth.token,
        "x-codebuddy-request": "1",
        "X-User-Id": auth.uid,
      },
      body: JSON.stringify(chatPayload),
    });
  } catch (e) {
    return jsonError(res, 502, `upstream request failed: ${e.message}`, "api_error");
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    let msg = text.slice(0, 800);
    try {
      const j = JSON.parse(text);
      msg = j.msg || j.error?.message || msg;
      if (upstream.status === 401 || upstream.status === 403) msg = `WorkBuddy 登录态失效（HTTP ${upstream.status}）。上游: ${msg}`;
    } catch {}
    console.error(`[wb-bridge] responses upstream ${upstream.status}: ${msg}`);
    dbgLog(`UPSTREAM_ERR ${upstream.status} body=${text.slice(0, 1500)}`);
    return jsonError(res, upstream.status, msg, upstream.status === 401 ? "authentication_error" : "api_error");
  }

  const meta = { model: chatPayload.model, customNames, localShell };

  if (wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const translator = createResponsesTranslator(res, meta);
    const acc = createSseAccumulator();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const t = decoder.decode(value, { stream: true });
        acc.push(t, ev => translator.feed(ev));
        if (translator.isFinished()) break;
      }
    } catch (e) {
      console.error(`[wb-bridge] responses stream error: ${e.message}`);
    }
    const tail = decoder.decode();
    if (tail) acc.push(tail, ev => translator.feed(ev));
    acc.flush(ev => translator.feed(ev));
    if (!translator.isFinished()) translator.done();
    res.end();
    return;
  }

  // non-stream: aggregate upstream chat stream, return Response JSON
  const acc = createSseAccumulator();
  const agg = makeAggregator(chatPayload.model, null, null);
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc.push(decoder.decode(value, { stream: true }), ev => agg.feed(ev));
    }
  } catch (e) {
    console.error(`[wb-bridge] responses drain error: ${e.message}`);
  }
  const tail = decoder.decode();
  if (tail) acc.push(tail, ev => agg.feed(ev));
  acc.flush(ev => agg.feed(ev));
  const result = agg.done();
  const translator = createResponsesTranslator({ write() {} }, meta);
  const json = translator.buildJson(result);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
}

function handleModels(req, res) {
  let auth = null;
  try {
    auth = loadAuth();
  } catch {}
  const data = {
    object: "list",
    data: MODELS.map(id => ({
      id,
      object: "model",
      created: 1791400000,
      owned_by: "workbuddy",
      ...(auth ? {} : {}),
    })),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
  try {
    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return handleModels(req, res);
    }
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      return await handleChat(req, res);
    }
    if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
      return await handleResponses(req, res);
    }
    if (req.method === "GET" && path === "/health") {
      let authed = false;
      try {
        loadAuth();
        authed = true;
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, auth: authed, models: MODELS.length }));
    }
    jsonError(res, 404, `not found: ${path}`, "invalid_request_error");
  } catch (e) {
    console.error(`[wb-bridge] unhandled: ${e.stack || e}`);
    if (!res.headersSent) jsonError(res, 500, String(e.message || e), "api_error");
    else res.end();
  }
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[wb-bridge] port ${PORT} already in use, exiting`);
    process.exit(0);
  }
  console.error(`[wb-bridge] server error: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[wb-bridge] listening on http://${HOST}:${PORT} -> ${UPSTREAM}`);
});
