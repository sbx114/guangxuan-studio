import { performance } from 'node:perf_hooks';
import { AppError, boundedString, requireObject } from './errors.mjs';
import { buildPrompt, normalizeModelData, PROMPT_VERSION } from './prompts.mjs';

export function normalizeSettings(input, { requireModel = true } = {}) {
  const settings = requireObject(input, 'AI 设置');
  const rawUrl = boundedString(settings.baseUrl, '接口地址', 2000);
  let url;
  try { url = new URL(rawUrl); } catch { throw new AppError(400, '接口地址需要是完整的 http:// 或 https:// 地址。', 'INVALID_BASE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, '接口地址仅支持 HTTP(S)，请移除用户名、密码、查询参数和片段。', 'INVALID_BASE_URL');
  }
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/i, '');
  if (!pathname || pathname === '/') pathname = '/v1';
  else if (!/\/v\d+(?:[a-z]+\d*)?(?:\/|$)/i.test(pathname)) pathname += '/v1';
  url.pathname = pathname;
  const model = boundedString(settings.model, '模型名称', 300, { optional: !requireModel });
  if (/\r|\n/.test(model)) throw new AppError(400, '模型名称不能包含换行。', 'INVALID_MODEL');
  const apiKey = boundedString(settings.apiKey, 'API 密钥', 4096);
  if (/\r|\n/.test(apiKey)) throw new AppError(400, 'API 密钥不能包含换行。', 'INVALID_API_KEY');
  const timeoutSeconds = Math.min(180, Math.max(10, Number(settings.timeoutSeconds) || 90));
  return { baseUrl: url.href.replace(/\/$/, ''), model, apiKey, apiStyle: settings.apiStyle === 'responses' ? 'responses' : 'chat', jsonMode: settings.jsonMode === true, timeoutMs: timeoutSeconds * 1000, providerOrigin: url.origin };
}

async function readLimitedText(response, max = 4 * 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new AppError(502, '模型响应过大，请缩短素材或输出要求。', 'UPSTREAM_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

function upstreamError(status, kind = '模型调用') {
  const descriptions = {
    400: '接口拒绝了请求，请确认模型名称、接口类型及 JSON 模式是否受支持。',
    401: '接口未通过身份验证，请检查 API 密钥。',
    403: '接口拒绝访问，请检查密钥权限或该模型的使用权限。',
    404: '接口或模型不存在，请检查接口地址、接口类型和模型名称。',
    408: '接口等待超时，请重试。',
    413: '接口认为输入过长，请缩短素材。',
    429: '接口请求过于频繁或可用额度不足，请稍后重试或检查余额。',
  };
  const message = descriptions[status] || `${kind}失败，上游接口返回 HTTP ${status}。请稍后重试。`;
  return new AppError(status === 429 ? 429 : 502, message, `UPSTREAM_HTTP_${status}`);
}

async function providerRequest(settings, endpoint, { body, signal, allowTokenRetry = true } = {}) {
  const timed = AbortSignal.timeout(settings.timeoutMs);
  const combined = signal ? AbortSignal.any([timed, signal]) : timed;
  try {
    const response = await fetch(`${settings.baseUrl}/${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: combined,
      redirect: 'error',
    });
    const text = await readLimitedText(response);
    // Some newer compatible models use max_completion_tokens. Retry only this
    // documented parameter incompatibility, once, and never expose provider text.
    if (!response.ok && response.status === 400 && allowTokenRetry && body?.max_tokens !== undefined && /max_tokens/i.test(text) && /max_completion_tokens|unsupported|not supported/i.test(text)) {
      const replacement = { ...body, max_completion_tokens: body.max_tokens };
      delete replacement.max_tokens;
      return providerRequest(settings, endpoint, { body: replacement, signal, allowTokenRetry: false });
    }
    if (!response.ok) throw upstreamError(response.status);
    let data;
    try { data = JSON.parse(text); } catch { throw new AppError(502, '接口没有返回有效 JSON。请确认地址指向 API，而不是中转站网页。', 'UPSTREAM_INVALID_JSON'); }
    if (data?.error) throw new AppError(502, '接口返回了错误结果。请检查模型权限、额度和接口配置。', 'UPSTREAM_ERROR');
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal?.aborted) throw new AppError(499, '操作已取消。', 'REQUEST_CANCELLED');
    if (timed.aborted || error?.name === 'TimeoutError') throw new AppError(504, '模型响应超时。可以重试或在设置中延长超时时间。', 'UPSTREAM_TIMEOUT');
    // Network exception strings can include configured URLs; return a fixed
    // message instead of logging or forwarding an exception/remote response.
    throw new AppError(502, '无法连接中转接口。请检查接口地址、网络连接以及中转站服务状态。', 'UPSTREAM_NETWORK_ERROR');
  }
}

function makeBody(settings, system, user, { connect = false } = {}) {
  if (settings.apiStyle === 'responses') {
    return { model: settings.model, instructions: system, input: user, max_output_tokens: connect ? 24 : 8192, ...(settings.jsonMode && !connect ? { text: { format: { type: 'json_object' } } } : {}) };
  }
  return {
    model: settings.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    stream: false,
    max_tokens: connect ? 24 : 8192,
    ...(settings.jsonMode && !connect ? { response_format: { type: 'json_object' } } : {}),
  };
}

function extractText(data, apiStyle) {
  if (apiStyle === 'responses') {
    if (typeof data.output_text === 'string') return data.output_text;
    return (Array.isArray(data.output) ? data.output : []).flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string').map(part => part.text).join('\n');
  }
  const message = data.choices?.[0]?.message;
  if (message?.refusal) throw new AppError(502, '模型未能完成这次内容请求，请检查素材并重试。', 'MODEL_REFUSAL');
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) return message.content.filter(part => typeof part.text === 'string').map(part => part.text).join('\n');
  return '';
}

export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AppError(502, '模型返回了空内容，请重试或更换模型。', 'MODEL_EMPTY_OUTPUT');
  let candidate = text.replace(/^\uFEFF/, '').trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1];
  try { return JSON.parse(candidate); } catch { /* Recover a single JSON object below. */ }
  const start = candidate.indexOf('{');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; start >= 0 && index < candidate.length; index++) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(candidate.slice(start, index + 1)); } catch { break; }
    }
  }
  throw new AppError(502, '模型未返回完整、有效的 JSON。请重试，或开启兼容的 JSON 模式。', 'MODEL_INVALID_JSON');
}

function numericUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const result = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  return Object.keys(result).length ? result : null;
}

export async function runAi(task, payloadInput, settingsInput, { signal } = {}) {
  const settings = normalizeSettings(settingsInput);
  const { system, user, payload } = buildPrompt(task, payloadInput);
  const started = performance.now();
  const response = await providerRequest(settings, settings.apiStyle === 'responses' ? 'responses' : 'chat/completions', { body: makeBody(settings, system, user), signal });
  if (response.choices?.[0]?.finish_reason === 'length' || response.status === 'incomplete') {
    throw new AppError(502, '模型输出因长度限制而中断。请缩短素材或减少输出要求后重试。', 'MODEL_OUTPUT_TRUNCATED');
  }
  const text = extractText(response, settings.apiStyle);
  const data = normalizeModelData(task, parseModelJson(text), payload);
  return { data, meta: { model: settings.model, durationMs: Math.round(performance.now() - started), usage: numericUsage(response.usage), promptVersion: PROMPT_VERSION, providerOrigin: settings.providerOrigin }, prompt: { system, user } };
}

export async function connectProvider(settingsInput, { signal } = {}) {
  const settings = normalizeSettings(settingsInput);
  const started = performance.now();
  const response = await providerRequest(settings, settings.apiStyle === 'responses' ? 'responses' : 'chat/completions', {
    body: makeBody(settings, '你是连接测试助手。请简短回复。', '仅回复 OK。', { connect: true }), signal,
  });
  if (!extractText(response, settings.apiStyle).trim()) throw new AppError(502, '接口已响应，但没有收到模型文本。请确认模型支持当前接口类型。', 'MODEL_EMPTY_OUTPUT');
  const durationMs = Math.round(performance.now() - started);
  return { ok: true, model: settings.model, apiStyle: settings.apiStyle, durationMs, latencyMs: durationMs, providerOrigin: settings.providerOrigin, usage: numericUsage(response.usage), message: '模型连接成功。' };
}

export async function listProviderModels(settingsInput, { signal } = {}) {
  const settings = normalizeSettings(settingsInput, { requireModel: false });
  let response;
  try { response = await providerRequest(settings, 'models', { signal }); }
  catch (error) {
    if (error.code === 'UPSTREAM_HTTP_404' || error.code === 'UPSTREAM_HTTP_400') throw new AppError(502, '该接口未提供兼容的模型列表。可以在设置中手动填写模型名称。', 'MODELS_UNAVAILABLE');
    throw error;
  }
  const candidates = Array.isArray(response.data) ? response.data : Array.isArray(response.models) ? response.models : Array.isArray(response) ? response : null;
  if (!candidates) throw new AppError(502, '模型列表格式不兼容，可以手动填写模型名称。', 'MODELS_UNAVAILABLE');
  const ids = [...new Set(candidates.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 300 && !/[\r\n]/.test(id)))].slice(0, 2000);
  if (!ids.length) throw new AppError(502, '接口没有返回可用模型，可以手动填写模型名称。', 'MODELS_UNAVAILABLE');
  return { models: ids.map(id => ({ id })), providerOrigin: settings.providerOrigin };
}
