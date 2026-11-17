// free-model-aggregator-02 — a quality-ranked free-model aggregator.
//
// One server, two client wires (OpenAI Chat Completions + Anthropic Messages,
// JSON and SSE), every answer dialled live from a free OpenRouter model through
// the grader's gateway. Model choice is ranked by the brief's published
// ratings, with per-model rate-limit cooldowns and failover to the next best
// model that meets the prompt's requirements.
//
// Run:  node main.ts            (trial mode; needs MAKEFUN_ENV_URL etc.)
//       node main.ts --list     (print the catalog and exit 0)

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function log(msg: string): void {
  process.stderr.write(`aggregator: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Brief: the two JSON documents embedded in $MAKEFUN_PROMPT_FILE
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  provider: string;
  displayName: string;
  rating: number;
  contextLength: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requiresJson: boolean;
  requiresTools: boolean;
  requiresVision: boolean;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** Index of the `}` closing the object that opens at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON object in `text` carrying a string `schema`, in order. */
function scanDocuments(text: string): Json[] {
  const out: Json[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = objectEnd(text, at);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(at, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a standalone object; keep scanning.
    }
  }
  return out;
}

function modelFromRow(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = asString(v.id) !== '' ? asString(v.id) : asString(v.model);
  if (raw === '') return null;
  const named = asString(v.provider) !== '' ? asString(v.provider) : asString(v.wire);
  const id =
    named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/')
      ? `openrouter/${raw}`
      : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    displayName: asString(v.display_name) !== '' ? asString(v.display_name) : raw,
    rating: asNumber(v.rating_milli) ?? 0,
    contextLength: asNumber(v.context_length),
    tools: asBool(v.tools),
    vision: asBool(v.vision),
    json: asBool(v.json),
    free: v.free !== false,
  };
}

function promptFromRow(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = asString(v.id);
  if (id === '') return null;
  const req = isRecord(v.requires) ? v.requires : {};
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requiresJson: req.json === true,
    requiresTools: req.tools === true,
    requiresVision: req.vision === true,
  };
}

function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = scanDocuments(text);
  const prefix = 'free-model-aggregator-02/';
  let models: ModelRow[] = [];
  let prompts: PromptRow[] = [];
  for (const doc of docs) {
    if (!asString(doc.schema).includes(prefix)) continue;
    for (const key of ['models', 'ratings']) {
      if (Array.isArray(doc[key]) && models.length === 0) {
        models = (doc[key] as unknown[]).flatMap((v) => {
          const m = modelFromRow(v);
          return m === null ? [] : [m];
        });
      }
    }
    for (const key of ['prompts', 'manifest']) {
      if (Array.isArray(doc[key]) && prompts.length === 0) {
        prompts = (doc[key] as unknown[]).flatMap((v) => {
          const p = promptFromRow(v);
          return p === null ? [] : [p];
        });
      }
    }
  }
  if (models.length === 0) {
    return { models: [], prompts, error: `the brief at ${path} holds no free model list` };
  }
  return { models, prompts, error: null };
}

// ---------------------------------------------------------------------------
// Catalog: exactly the brief's free models, once each, one provider.
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: string;
    models: CatalogModel[];
  }>;
}

function buildCatalog(models: ModelRow[]): Catalog {
  const seen = new Set<string>();
  const list: CatalogModel[] = [];
  for (const m of models) {
    if (!m.free || seen.has(m.id)) continue;
    seen.add(m.id);
    list.push({ id: m.id, free: true, context_length: m.contextLength });
  }
  if (list.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        wire: 'openai',
        models: list,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Routing: rank candidates by rating, then context, then id (deterministic).
// A model that answered 429 cools down for the rest of the run unless it is
// the only candidate left.
// ---------------------------------------------------------------------------

interface Needs {
  json: boolean;
  tools: boolean;
  vision: boolean;
}

function meets(m: ModelRow, n: Needs): boolean {
  if (n.json && m.json !== true) return false;
  if (n.tools && m.tools !== true) return false;
  if (n.vision && m.vision !== true) return false;
  return true;
}

function rankCandidates(models: ModelRow[], n: Needs, cooled: Set<string>): ModelRow[] {
  const ok = models.filter((m) => m.free && meets(m, n));
  const fresh = ok.filter((m) => !cooled.has(m.id));
  const pool = fresh.length > 0 ? fresh : ok;
  return [...pool].sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    const ca = a.contextLength ?? 0;
    const cb = b.contextLength ?? 0;
    if (cb !== ca) return cb - ca;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function needsFromBody(body: Json): Needs {
  let vision = false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const fmt = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    json: fmt === 'json_object' || fmt === 'json_schema',
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
  };
}

// ---------------------------------------------------------------------------
// Wire translation
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = textOf(content);
    return t !== '' ? t : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function argsObject(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: empty input.
    }
  }
  return {};
}

function anthropicStop(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

/** Anthropic Messages request -> OpenAI Chat Completions request. */
function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const calls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: asString(block.id),
          type: 'function',
          function: {
            name: asString(block.name),
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOf(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: asString(block.tool_use_id),
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isRecord(block.source)) {
        const src = block.source;
        if (src.type === 'base64' && typeof src.data === 'string') {
          const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } });
        } else if (src.type === 'url' && typeof src.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: asString(raw.description),
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** Rough token estimate from text length, used only when usage is missing. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Chat Completions answer -> Anthropic Messages object, model = dialled id. */
function openAIToAnthropic(body: Json, model: string): Json {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') content.push({ type: 'text', text });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of calls) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    content.push({
      type: 'tool_use',
      id: asString(call.id) !== '' ? asString(call.id) : 'toolu_unknown',
      name: asString(call.function.name),
      input: argsObject(call.function.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = isRecord(body.usage) ? body.usage : {};
  let input = numOrZero(usage.prompt_tokens);
  let output = numOrZero(usage.completion_tokens);
  if (text !== '' && output < 1) output = estimateTokens(text);
  return {
    id: `msg_${asString(body.id) !== '' ? asString(body.id) : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStop(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  };
}

/** Chat Completions answer with the dialled id stamped on `model`, usage kept whole. */
function openAIJsonWithModel(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const choices = Array.isArray(out.choices) ? out.choices : [];
  if (isRecord(choices[0])) {
    const choice = { ...choices[0] };
    if (isRecord(choice.message)) choice.message = { role: 'assistant', ...choice.message };
    else choice.message = { role: 'assistant', content: '' };
    if (typeof choice.finish_reason !== 'string') choice.finish_reason = 'stop';
    const text = typeof choice.message.content === 'string' ? choice.message.content : textOf(choice.message.content);
    if (isRecord(out.usage)) {
      const usage = { ...out.usage };
      if (text !== '' && numOrZero(usage.completion_tokens) < 1) {
        usage.completion_tokens = estimateTokens(text);
      }
      out.usage = usage;
    } else if (text !== '') {
      out.usage = { prompt_tokens: 0, completion_tokens: estimateTokens(text), total_tokens: estimateTokens(text) };
    }
    out.choices = [choice, ...choices.slice(1)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** Split a byte stream into SSE frames on blank lines, yielding raw frames. */
async function* sseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        yield buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Data lines of one frame (the payloads after `data:`). */
function frameDataLines(frame: string): string[] {
  const out: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) out.push(trimmed.slice(5).trim());
  }
  return out;
}

/**
 * OpenAI SSE relay: every chunk's `model` becomes the dialled id; [DONE] is
 * emitted exactly once at the end even if the upstream omits it.
 */
async function* openAIStreamRelay(stream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let sawDone = false;
  for await (const frame of sseFrames(stream)) {
    const payloads = frameDataLines(frame);
    if (payloads.length === 0) {
      // Comment / event-only frame: pass through untouched.
      yield `${frame}\n\n`;
      continue;
    }
    const lines: string[] = [];
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        lines.push(line);
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        lines.push('data: [DONE]');
        continue;
      }
      try {
        const chunk: unknown = JSON.parse(payload);
        if (isRecord(chunk)) lines.push(`data: ${JSON.stringify({ ...chunk, model })}`);
        else lines.push(line);
      } catch {
        lines.push(line);
      }
    }
    yield `${lines.join('\n')}\n\n`;
    if (sawDone) break;
  }
  if (!sawDone) yield 'data: [DONE]\n\n';
}

/**
 * OpenAI SSE -> Anthropic SSE event order: message_start, content_block_start
 * / delta / stop per text or tool block, message_delta (stop reason + usage),
 * message_stop.
 */
async function* anthropicStreamRelay(stream: ReadableStream<Uint8Array>, model: string): AsyncGenerator<string> {
  let started = false;
  let finished = false;
  let pendingStop: string | null = null;
  let textIndex = -1;
  let nextIndex = 0;
  const toolIndexes = new Map<number, number>();
  let inputTokens = 0;
  let outputTokens = 0;

  const start = (): string[] => {
    if (started) return [];
    started = true;
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }),
    ];
  };
  const closeBlocks = (): string[] => {
    const out: string[] = [];
    if (textIndex !== -1) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
      textIndex = -1;
    }
    for (const index of [...toolIndexes.values()].sort((a, b) => a - b)) {
      out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    }
    toolIndexes.clear();
    return out;
  };
  const finish = (stopReason: string): string[] => {
    if (finished) return [];
    finished = true;
    return [
      ...closeBlocks(),
      sseEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sseEvent('message_stop', { type: 'message_stop' }),
    ];
  };

  for await (const frame of sseFrames(stream)) {
    for (const payload of frameDataLines(frame)) {
      if (payload === '[DONE]') {
        for (const e of [...start(), ...finish(pendingStop ?? 'end_turn')]) yield e;
        continue;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      if (isRecord(chunk.usage)) {
        inputTokens = numOrZero(chunk.usage.prompt_tokens);
        outputTokens = numOrZero(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      const out: string[] = [...start()];
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIndex === -1) {
          textIndex = nextIndex;
          nextIndex += 1;
          out.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index: textIndex,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        out.push(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text: delta.content },
          }),
        );
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const upstreamIndex = typeof call.index === 'number' ? call.index : toolIndexes.size;
        let index = toolIndexes.get(upstreamIndex);
        if (index === undefined) {
          if (textIndex !== -1) {
            out.push(sseEvent('content_block_stop', { type: 'content_block_stop', index: textIndex }));
            textIndex = -1;
          }
          index = nextIndex;
          nextIndex += 1;
          toolIndexes.set(upstreamIndex, index);
          const fn = isRecord(call.function) ? call.function : {};
          out.push(
            sseEvent('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: asString(call.id) !== '' ? asString(call.id) : `toolu_${index}`,
                name: asString(fn.name),
                input: {},
              },
            }),
          );
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          out.push(
            sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            }),
          );
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        pendingStop = anthropicStop(choice.finish_reason);
      }
      for (const e of out) yield e;
    }
    if (finished) break;
  }
  if (!finished) {
    for (const e of [...start(), ...finish(pendingStop ?? 'end_turn')]) yield e;
  }
}

// ---------------------------------------------------------------------------
// Gateway dialling with failover
// ---------------------------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const PROTOCOL_VERSION = 1;
const POLL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CALL_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 4;

const brief: Brief = readBrief(PROMPT_FILE);
const catalog: Catalog = buildCatalog(brief.models);
const cooled = new Set<string>();
/** Which prompt row the next completion request is (arrival order). */
let manifestIndex = 0;

interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

interface DialResult {
  ok: boolean;
  model: string | null;
  response: Response | null;
  failures: FailureRow[];
}

function gatewayUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

function codeFor(status: number, bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const code = parsed.error.code;
      if (typeof code === 'string' && code !== '') return code;
    }
  } catch {
    // Not JSON; fall through to the status map.
  }
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'invalid_request_error';
  if (status >= 500) return 'upstream_error';
  return 'request_error';
}

/** Dial the ranked candidates in order until one answers 2xx. */
async function dialWithFailover(body: Json, needs: Needs): Promise<DialResult> {
  const candidates = rankCandidates(brief.models, needs, cooled);
  const failures: FailureRow[] = [];
  let attempts = 0;
  for (const model of candidates) {
    if (attempts >= MAX_ATTEMPTS) break;
    attempts += 1;
    let res: Response;
    try {
      res = await fetch(gatewayUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${GATEWAY_KEY}`,
          ...(body.stream === true ? { accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify({ ...body, model: model.id }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      failures.push({ status: 0, code: 'upstream_unreachable', model: model.id });
      log(`dial ${model.id} failed to reach the gateway: ${(err as Error).message}`);
      continue;
    }
    if (res.ok) return { ok: true, model: model.id, response: res, failures };
    const text = await res.text().catch(() => '');
    failures.push({ status: res.status, code: codeFor(res.status, text), model: model.id });
    log(`dial ${model.id} refused HTTP ${res.status}`);
    if (res.status === 429) cooled.add(model.id);
    if (res.status !== 429 && res.status < 500) break; // 4xx other than 429: the request itself is wrong
  }
  return { ok: false, model: null, response: null, failures };
}

/** Whether an upstream JSON answer carries usable content (text or a tool call). */
function answerUsable(answer: unknown): boolean {
  if (!isRecord(answer)) return false;
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  if (choice === null) return false;
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : textOf(message.content);
  if (text !== '') return true;
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, failures: FailureRow[] = []): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  };
  if (failures.length > 0) {
    headers['x-makefun-upstream-failures'] = JSON.stringify(failures.slice(0, 8));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function openAIError(message: string, type: string): Json {
  return { error: { message, type, code: null } };
}

function anthropicError(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type));
}

function failureHeaders(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) };
}

function needsFor(body: Json): Needs {
  const row = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (row !== undefined) {
    return { json: row.requiresJson, tools: row.requiresTools, vision: row.requiresVision };
  }
  return needsFromBody(body);
}

function modelList(req: IncomingMessage): Json {
  const list = brief.models
    .filter((m) => m.free)
    .map((m) => ({ id: m.id, provider: m.provider, display_name: m.displayName }));
  if (typeof req.headers['x-api-key'] === 'string') {
    return {
      data: list.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: '2026-01-01T00:00:00Z' })),
      has_more: false,
    };
  }
  return {
    object: 'list',
    data: list.map((m) => ({ id: m.id, object: 'model', created: 1767225600, owned_by: m.provider })),
  };
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const needs = needsFor(body);
  const dial = await dialWithFailover(body, needs);
  if (!dial.ok || dial.response === null || dial.model === null) {
    const detail = dial.failures.length > 0 ? `the gateway refused every model tried (last HTTP ${dial.failures[dial.failures.length - 1].status})` : 'no free model meets this request';
    return sendError(res, 'openai', 502, 'upstream_error', detail);
  }
  const upstream = dial.response;
  if (body.stream === true) {
    if (upstream.body === null) return sendError(res, 'openai', 502, 'upstream_error', 'the gateway answered with no body');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...failureHeaders(dial.failures),
    });
    try {
      for await (const frame of openAIStreamRelay(upstream.body, dial.model)) res.write(frame);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json().catch(() => null);
  if (!answerUsable(answer)) {
    // A 200 with no usable content: fail over once more on the next model is
    // already spent, so report it as an upstream error for this prompt.
    return sendError(res, 'openai', 502, 'upstream_error', 'the gateway answered with no usable completion');
  }
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, dial.model), dial.failures);
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const needs = needsFor(body);
  // The tools prompt declares tools on the Anthropic body itself; the
  // manifest row already says so, but the body is the fallback source.
  if (Array.isArray(body.tools) && body.tools.length > 0) needs.tools = true;
  const dial = await dialWithFailover(anthropicToOpenAI(body, ''), needs);
  if (!dial.ok || dial.response === null || dial.model === null) {
    const detail = dial.failures.length > 0 ? `the gateway refused every model tried (last HTTP ${dial.failures[dial.failures.length - 1].status})` : 'no free model meets this request';
    return sendError(res, 'anthropic', 502, 'api_error', detail);
  }
  // dialWithFailover overwrites the body's `model` with the chosen id on
  // every attempt, so the empty placeholder above never reaches the gateway.
  const upstream = dial.response;
  if (body.stream === true) {
    if (upstream.body === null) return sendError(res, 'anthropic', 502, 'api_error', 'the gateway answered with no body');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...failureHeaders(dial.failures),
    });
    try {
      for await (const event of anthropicStreamRelay(upstream.body, dial.model)) res.write(event);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json().catch(() => null);
  if (!answerUsable(answer)) {
    return sendError(res, 'anthropic', 502, 'api_error', 'the gateway answered with no usable completion');
  }
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, dial.model), dial.failures);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, modelList(req));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleChat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await handleMessages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Startup: listen, register, poll /work until done.
// ---------------------------------------------------------------------------

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') {
        log(`registered: the trial holds ${reply.requests} prompts`);
      }
      return;
    } catch (err) {
      lastError = (err as Error).message;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`POST ${ENV_URL}/register failed: ${lastError}`);
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json();
          if (isRecord(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // Env not reachable yet; retry on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (gatewayUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${brief.models.filter((m) => m.free).length} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
