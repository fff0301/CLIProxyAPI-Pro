export type SavedResponse = { response_content?: string; response_type?: string; response_status?: number; response_truncated?: boolean; response_state?: string };
export type ResponseMessage = { role: string; content?: unknown; tool_calls?: unknown[]; name?: string };
type Dict = Record<string, any>;
const obj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);

// Normalize only the captured response; never infer text from request history.
export function parseSavedResponse(saved: SavedResponse): ResponseMessage[] {
  const raw = saved.response_content;
  if (!raw) return [];
  const texts = new Map<string, string>();
  const tools = new Map<string, Dict>();
  let final: ResponseMessage[] | undefined;
  const append = (key: string, text: unknown, snapshot = false) => { if (typeof text === 'string') texts.set(key, snapshot ? text : (texts.get(key) || '') + text); };
  const tool = (key: string, value: Dict, snapshot = false) => {
    const old = tools.get(key) || { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (value.id) old.id = value.id;
    const fn = value.function || value;
    if (fn.name) old.function.name = fn.name;
    if (typeof fn.arguments === 'string') old.function.arguments = snapshot ? fn.arguments : old.function.arguments + fn.arguments;
    else if (fn.args || fn.input) old.function.arguments = JSON.stringify(fn.args || fn.input, null, 2);
    tools.set(key, old);
  };
  const outputItems = (items: unknown): ResponseMessage[] => {
    if (!Array.isArray(items)) return [];
    const out: ResponseMessage[] = [];
    for (const item of items) {
      if (!obj(item)) continue;
      if (item.type === 'function_call') out.push({ role: 'assistant', tool_calls: [{ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments } }] });
      else if (item.content) out.push({ role: 'assistant', content: item.content });
      else if (item.summary) out.push({ role: 'assistant', content: item.summary });
    }
    return out;
  };
  const consume = (data: Dict) => {
    if (data.error || data.type === 'error') { append('error', typeof data.error?.message === 'string' ? data.error.message : JSON.stringify(data.error || data)); return; }
    if (Array.isArray(data.choices)) for (const choice of data.choices) {
      const index = choice.index ?? 0;
      const part = choice.delta || choice.message || {};
      append(`thinking-${index}`, part.reasoning_content || part.reasoning, !!choice.message);
      if (typeof part.content === 'string') append(`text-${index}`, part.content, !!choice.message);
      else if (Array.isArray(part.content)) append(`text-${index}`, part.content.map((v: Dict) => v.text || (v.image_url ? '[img]' : JSON.stringify(v))).join('\n'), !!choice.message);
      if (Array.isArray(part.tool_calls)) for (const call of part.tool_calls) tool(`chat-${index}-${call.index ?? call.id ?? 0}`, call, !!choice.message);
      if (part.function_call) tool(`chat-${index}-legacy`, part.function_call, !!choice.message);
    }
    if (data.type === 'response.output_text.delta' || data.type === 'response.reasoning_summary_text.delta') append(`response-${data.output_index ?? 0}-${data.content_index ?? 0}-${data.type}`, data.delta);
    if (data.type === 'response.function_call_arguments.delta') tool(`responses-${data.output_index ?? 0}`, { arguments: data.delta });
    if (data.type === 'response.output_item.added' && data.item?.type === 'function_call') tool(`responses-${data.output_index ?? 0}`, { ...data.item, id: data.item.call_id || data.item.id });
    if (data.type === 'response.output_item.done' && data.item?.type === 'function_call') tool(`responses-${data.output_index ?? 0}`, { ...data.item, id: data.item.call_id || data.item.id }, true);
    if (data.type === 'response.output_item.done' && data.item?.content) for (const [i, part] of data.item.content.entries()) {
      if (part.text) append(`response-${data.output_index ?? 0}-${i}-response.output_text.delta`, part.text, true);
    }
    const response = data.response || data;
    if (Array.isArray(response.output)) { const items = outputItems(response.output); if (items.length) final = items; }
    if (data.type === 'content_block_start') {
      const block = data.content_block || {}; const key = `claude-${data.index ?? 0}`;
      append(key, block.text || block.thinking);
      if (block.type === 'tool_use') tool(key, { id: block.id, name: block.name, arguments: Object.keys(block.input || {}).length ? JSON.stringify(block.input) : '' });
    }
    if (data.type === 'content_block_delta') {
      const delta = data.delta || {}; const key = `claude-${data.index ?? 0}`;
      append(key, delta.text || delta.thinking);
      if (delta.partial_json) tool(key, { arguments: delta.partial_json });
    }
    if (data.type === 'message' && Array.isArray(data.content)) {
      for (const [index, block] of data.content.entries()) {
        append(`claude-${index}`, block.text || block.thinking, true);
        if (block.type === 'tool_use') tool(`claude-${index}`, { id: block.id, name: block.name, input: block.input }, true);
      }
    }
    if (Array.isArray(data.candidates)) for (const candidate of data.candidates) for (const [index, part] of (candidate.content?.parts || []).entries()) {
      const key = `gemini-${candidate.index ?? 0}-${index}`;
      append(key, part.text);
      if (part.functionCall) tool(key, part.functionCall, true);
      if (part.inlineData || part.inline_data) append(key, '[img]');
    }
  };
  if (saved.response_type?.includes('event-stream') || /^\s*(event:|data:)/.test(raw)) {
    for (const frame of raw.replace(/\r\n/g, '\n').split(/\n\n+/)) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { const value = JSON.parse(data); if (obj(value)) consume(value); } catch { /* Keep complete frames before interruption. */ }
    }
  } else {
    try { const data = JSON.parse(raw); if (obj(data)) consume(data); else if (Array.isArray(data)) data.filter(obj).forEach(consume); }
    catch { append('fallback', raw); }
  }
  if (final?.length) return final;
  const content = [...texts.values()].filter(Boolean).join('\n\n');
  const toolCalls = [...tools.values()];
  return content || toolCalls.length ? [{ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }] : [];
}
