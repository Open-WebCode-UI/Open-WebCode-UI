import express from 'express';
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { registry, HttpError, fail, validate, z } from '../http.js';
import { getSettings } from '../settings.js';
import { userPermissions, userRoleNames } from '../auth/rbac.js';
import { lookupKey, touchKey } from '../api/keys.js';
import { createAdapter } from '../llm/provider.js';
import { recordUsage } from '../usage.js';
import { hit } from '../ratelimit.js';
import { resolveModel } from './providers.js';

// The provider API: an OpenAI-compatible surface so existing clients and SDKs can use this server as a provider.
// Authenticated by API key (Authorization: Bearer owui_...), never by the browser session. Documented in openapi/openapi.yaml.
const apiError = (res, status, message, type = 'invalid_request_error', code = null) => res.status(status).json({ error: { message, type, code } });
const publicId = (providerName, modelId) => `${providerName}/${modelId}`;

function apiAuth(req, res, next) {
  const s = getSettings('api');
  if (!s.enabled) return apiError(res, 503, 'The API is turned off on this server.', 'api_disabled', 'api_disabled');
  const bad = () => (hit(`apiauth:${req.ip}`, 20, 60_000) ? apiError(res, 401, 'Invalid or missing API key.', 'authentication_error', 'invalid_api_key') : apiError(res, 429, 'Too many failed attempts.', 'rate_limit_error', 'rate_limited'));
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  const found = m && lookupKey(m[1]);
  if (!found) return bad();
  // Permission is read on every call, so taking api.use away from a role stops its members' keys at once.
  if (!userPermissions(found.user.id).has('api.use')) return apiError(res, 403, 'The key owner is not allowed to use the API.', 'permission_error', 'forbidden');
  if (!hit(`apikey:${found.key.id}`, s.rateLimitPerMin, 60_000)) { res.set('Retry-After', '60'); return apiError(res, 429, 'Rate limit exceeded for this key.', 'rate_limit_error', 'rate_limited'); }
  touchKey(found.key);
  req.apiKey = found.key; req.apiUser = found.user;
  next();
}

// Models this key may call: enabled connection + enabled model + the connection's role allow-list + the key's own restriction.
function usableModels(user, key) {
  const roles = userRoleNames(user.id), only = key.model_ids ? JSON.parse(key.model_ids) : null;
  return getDb().prepare(`SELECT m.id, m.model_id, p.name provider, p.allowed_roles ar FROM models m JOIN providers p ON p.id=m.provider_id
    WHERE m.enabled=1 AND p.enabled=1 ORDER BY p.position, p.id, m.position, m.id`).all()
    .filter((m) => (!only || only.includes(m.id)) && (() => { const ar = JSON.parse(m.ar); return !ar.length || ar.some((x) => roles.includes(x)); })());
}

const part = z.object({ type: z.string() }).loose();
const message = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(part), z.null()]).optional(),
  tool_calls: z.array(z.object({ id: z.string().max(200), function: z.object({ name: z.string().max(200), arguments: z.string().max(1_000_000).optional() }) })).max(128).optional(),
  tool_call_id: z.string().max(200).optional(),
});
const chatBody = z.object({
  model: z.string().min(1).max(400),
  messages: z.array(message).min(1).max(2000),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  n: z.number().int().optional(),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1).max(200), description: z.string().max(10_000).optional(), parameters: z.record(z.string(), z.any()).optional() }) })).max(128).optional(),
});

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (content.some((p) => p.type !== 'text')) fail(400, 'unsupported_content', { message: 'Only text content parts are supported.' });
  return content.map((p) => String(p.text ?? '')).join('');
}

// OpenAI chat messages -> the neutral format every adapter takes (see llm/provider.js).
export function toNeutral(msgs) {
  const system = [], out = [], names = new Map();
  for (const m of msgs) {
    if (m.role === 'system' || m.role === 'developer') system.push(textOf(m.content));
    else if (m.role === 'user') out.push({ role: 'user', content: textOf(m.content) });
    else if (m.role === 'assistant') {
      const toolCalls = (m.tool_calls || []).map((c) => {
        let args = {};
        try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { fail(400, 'invalid_tool_arguments', { message: `Arguments of tool call ${c.id} are not valid JSON.` }); }
        names.set(c.id, c.function.name);
        return { id: c.id, name: c.function.name, args };
      });
      out.push({ role: 'assistant', content: textOf(m.content), ...(toolCalls.length ? { toolCalls } : {}) });
    } else {
      if (!m.tool_call_id) fail(400, 'invalid_tool_message', { message: 'A tool message needs tool_call_id.' });
      out.push({ role: 'tool', toolCallId: m.tool_call_id, name: names.get(m.tool_call_id) || '', content: textOf(m.content) });
    }
  }
  if (!out.length) fail(400, 'no_messages', { message: 'At least one user or tool message is required.' });
  return { system: system.join('\n\n'), messages: out };
}

const finishReason = (stop, calls) => (calls ? 'tool_calls' : /length|max_tokens/.test(stop || '') ? 'length' : 'stop');
const roughTokens = (s) => Math.ceil(String(s).length / 4);

export function v1Router({ adapterFactory = createAdapter } = {}) {
  const r = express.Router();
  const route = (method, path, ...handlers) => {
    registry.push({ method: method.toUpperCase(), path: `/v1${path}`, access: 'api.use' });
    r[method](path, apiAuth, ...handlers);
  };

  route('get', '/models', (req, res) => {
    res.json({ object: 'list', data: usableModels(req.apiUser, req.apiKey).map((m) => ({ id: publicId(m.provider, m.model_id), object: 'model', created: 0, owned_by: m.provider })) });
  });

  route('post', '/chat/completions', express.json({ limit: '8mb' }), async (req, res) => {
    const b = validate(chatBody, req.body);
    if (b.n !== undefined && b.n !== 1) fail(400, 'unsupported_n', { message: 'Only n=1 is supported.' });
    const row = usableModels(req.apiUser, req.apiKey).find((m) => publicId(m.provider, m.model_id) === b.model);
    const rm = row && resolveModel(req.apiUser, row.id);
    if (!rm) fail(404, 'model_not_found', { message: `The model "${b.model}" does not exist or you do not have access to it.` });
    const { system, messages } = toNeutral(b.messages);
    const tools = (b.tools || []).map((t) => ({ name: t.function.name, description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } }));
    const cap = rm.model.max_tokens, maxTokens = Math.min(b.max_completion_tokens ?? b.max_tokens ?? cap, cap);
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`, created = Math.floor(Date.now() / 1000), label = b.model;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const text = [], calls = [];
    let reported = null, stop = 'stop', started = false;
    const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model: label, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const open = () => {
      if (started || !b.stream) return;
      started = true;
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }).flushHeaders();
      send(chunk({ role: 'assistant', content: '' }));
    };
    try {
      for await (const ev of adapterFactory(rm.provider).stream({ system, messages, tools, model: rm.model.model_id, maxTokens, temperature: b.temperature ?? rm.model.temperature ?? undefined, signal: abort.signal })) {
        if (ev.type === 'text') { text.push(ev.text); open(); if (b.stream) send(chunk({ content: ev.text })); }
        else if (ev.type === 'tool_call') {
          calls.push(ev); open();
          if (b.stream) send(chunk({ tool_calls: [{ index: calls.length - 1, id: ev.id, type: 'function', function: { name: ev.name, arguments: JSON.stringify(ev.args ?? {}) } }] }));
        }
        else if (ev.type === 'usage') reported = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
        else if (ev.type === 'done') stop = ev.stop;
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      console.error('api error', e?.message);
      if (started) { send({ error: { message: 'The model request failed.', type: 'api_error', code: 'upstream_error' } }); return res.end(); }
      return apiError(res, 502, 'The model request failed.', 'api_error', 'upstream_error');
    } finally {
      const out = text.join('');
      const usage = reported ?? { inputTokens: roughTokens(system + JSON.stringify(messages)), outputTokens: roughTokens(out + JSON.stringify(calls.map((c) => c.args ?? {}))), estimated: true };
      recordUsage({ userId: req.apiUser.id, model: rm.model, provider: rm.provider, kind: 'api', ...usage });
      req.apiUsage = usage;
    }
    const usage = { prompt_tokens: req.apiUsage.inputTokens, completion_tokens: req.apiUsage.outputTokens, total_tokens: req.apiUsage.inputTokens + req.apiUsage.outputTokens };
    const finish = finishReason(stop, calls.length);
    if (b.stream) {
      open();
      send(chunk({}, finish));
      if (b.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created, model: label, choices: [], usage });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.json({
      id, object: 'chat.completion', created, model: label,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: calls.length && !text.length ? null : text.join(''),
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}) } }],
      usage,
    });
  });

  r.use((_req, res) => apiError(res, 404, 'Unknown endpoint.', 'invalid_request_error', 'not_found'));
  // Everything under /v1 answers in the OpenAI error envelope, whatever went wrong.
  r.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      const detail = err.extra.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
      return apiError(res, err.status, err.extra.message || detail || err.message, 'invalid_request_error', err.message);
    }
    if (err?.name === 'ZodError') return apiError(res, 400, err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'invalid_request_error', 'validation_error');
    if (err?.type === 'entity.too.large') return apiError(res, 413, 'Request body too large.', 'invalid_request_error', 'too_large');
    if (err?.type?.startsWith('entity.parse')) return apiError(res, 400, 'Request body is not valid JSON.', 'invalid_request_error', 'invalid_json');
    console.error(err);
    apiError(res, 500, 'Internal error.', 'api_error', 'internal_error');
  });
  return r;
}
