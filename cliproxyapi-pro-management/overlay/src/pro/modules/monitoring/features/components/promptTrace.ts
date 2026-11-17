export type TraceKind = 'input' | 'context' | 'model' | 'call' | 'result' | 'other';
export type TraceEvent = { id: string; kind: TraceKind; role: string; text: string; name?: string; callId?: string; linkedId?: string; turn: number; current?: boolean };
export type Trace = { events: TraceEvent[]; parsed: boolean; model: string; toolCount: number };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2);
const readText = (v: unknown): string => {
  if (Array.isArray(v)) return v.map(readText).filter(Boolean).join('\n\n');
  if (!record(v)) return show(v);
  if (v.text != null) return show(v.text);
  if (v.thinking != null) return show(v.thinking);
  if (v.image_url || v.inline_data || v.inlineData || /image/.test(String(v.type || ''))) return '[img]';
  if (/audio/.test(String(v.type || ''))) return '[audio]';
  if (/file/.test(String(v.type || ''))) return '[file]';
  return show(v);
};

export function buildPromptTrace(content: string, responseMessages: unknown[] = []): Trace {
  let data: unknown;
  try { data = JSON.parse(content); } catch { return { events: [], parsed: false, model: '', toolCount: 0 }; }
  if (!record(data)) return { events: [], parsed: false, model: '', toolCount: 0 };
  const events: TraceEvent[] = [];
  let turn = 0;
  const add = (kind: TraceKind, role: string, text: string, name?: unknown, callId?: unknown) => {
    events.push({ id: `trace-${events.length}`, kind, role, text, name: typeof name === 'string' ? name : undefined, callId: typeof callId === 'string' && callId ? callId : undefined, turn });
  };
  for (const value of [data.instructions, data.system, data.systemInstruction, data.system_instruction]) {
    if (value) add('context', 'system', readText(record(value) && value.parts ? value.parts : value));
  }
  const walkItem = (item: unknown) => {
    if (typeof item === 'string') { turn++; add('input', 'user', item); return; }
    if (!record(item)) return;
    const type = String(item.type || '');
    const role = String(item.role || (type === 'function_call_output' ? 'tool' : type === 'function_call' || type === 'reasoning' ? 'assistant' : 'unknown'));
    if (type === 'function_call') { add('call', role, show(item.arguments), item.name, item.call_id || item.id); return; }
    if (type === 'function_call_output') { add('result', role, readText(item.output), item.name, item.call_id); return; }
    if (type === 'reasoning') { add('model', role, readText(item.summary || item.content || '[reasoning content not included]')); return; }
    const payload = item.content ?? item.parts ?? item.text;
    const blocks = Array.isArray(payload) ? payload : [payload];
    const toolOnly = blocks.every(block => record(block) && (block.type === 'tool_result' || block.functionResponse || block.function_response));
    const isContext = ['system', 'developer'].includes(role) || role === 'user' && typeof payload === 'string' && /^\s*<(?:system-reminder|environment_context|context)\b/.test(payload);
    if (role === 'user' && !isContext && !toolOnly) turn++;
    if (role === 'tool' || role === 'function') { add('result', role, readText(payload), item.name, item.tool_call_id || item.call_id); return; }
    let text: unknown[] = [];
    const flush = () => {
      if (!text.length) return;
      add(isContext ? 'context' : role === 'user' ? 'input' : ['assistant', 'model'].includes(role) ? 'model' : 'other', role, readText(text));
      text = [];
    };
    for (const block of blocks) {
      if (record(block) && block.type === 'tool_use') { flush(); add('call', role, show(block.input), block.name, block.id); }
      else if (record(block) && block.type === 'tool_result') { flush(); add('result', role, readText(block.content), undefined, block.tool_use_id); }
      else if (record(block) && (block.functionCall || block.function_call)) {
        flush(); const call = block.functionCall || block.function_call;
        if (record(call)) add('call', role, show(call.args || call.arguments), call.name, call.id);
      } else if (record(block) && (block.functionResponse || block.function_response)) {
        flush(); const result = block.functionResponse || block.function_response;
        if (record(result)) add('result', role, readText(result.response), result.name, result.id);
      } else if (block != null) text.push(block);
    }
    flush();
    if (Array.isArray(item.tool_calls)) for (const call of item.tool_calls) {
      if (!record(call)) continue;
      const fn = record(call.function) ? call.function : call;
      add('call', role, show(fn.arguments ?? fn.input), fn.name, call.id);
    }
    if (record(item.function_call)) add('call', role, show(item.function_call.arguments), item.function_call.name);
  };
  const messages = data.messages ?? data.contents ?? data.input ?? data.prompt;
  if (Array.isArray(messages)) messages.forEach(walkItem); else if (typeof messages === 'string') walkItem(messages);
  const historyLength = events.length;
  responseMessages.forEach(walkItem);
  events.slice(historyLength).forEach(event => { event.current = true; });
  // Only IDs establish a link: parallel same-name calls must never be paired by guesswork.
  const calls = new Map<string, TraceEvent>();
  for (const event of events) {
    if (event.kind === 'call' && event.callId) calls.set(event.callId, event);
    if (event.kind === 'result' && event.callId) {
      const call = calls.get(event.callId);
      if (call) { event.linkedId = call.id; call.linkedId = event.id; event.name ||= call.name; }
    }
  }
  return { events, parsed: events.length > 0, model: String(data.model || ''), toolCount: Array.isArray(data.tools) ? data.tools.length : 0 };
}
