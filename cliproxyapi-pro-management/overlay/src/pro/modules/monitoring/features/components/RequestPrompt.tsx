import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { proApiClient } from '@/pro/shared/proManagementTransport';
import styles from './RequestPrompt.module.scss';
import { buildPromptTrace, type TraceKind } from './promptTrace';

type Prompt = { content: string; truncated: boolean; size_bytes?: number };
type Section = { role: string; text: string; meta?: string; toolCalls?: string };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pretty = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n\n');
  if (!object(value)) return value == null ? '' : String(value);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string' || Array.isArray(value.content)) return contentText(value.content);
  if (value.image_url || value.inline_data || value.inlineData || value.type === 'image' || value.type === 'input_image') return '[img]';
  if (value.input_audio || String(value.type || '').includes('audio')) return '[audio]';
  if (value.file || String(value.type || '').includes('file')) return '[file]';
  return pretty(value);
}

function parsePrompt(content: string): { sections: Section[]; model: string; parameters: string; raw: string; parsed: boolean } {
  try {
    const data: unknown = JSON.parse(content);
    if (!object(data)) throw new Error('Not an object');
    const sections: Section[] = [];
    if (data.instructions) sections.push({ role: 'system', text: contentText(data.instructions) });
    if (data.system) sections.push({ role: 'system', text: contentText(data.system) });
    const system = data.systemInstruction || data.system_instruction;
    if (system) sections.push({ role: 'system', text: contentText(object(system) ? system.parts : system) });
    const messages = data.messages || data.contents || data.input;
    if (typeof messages === 'string') sections.push({ role: 'user', text: messages });
    if (Array.isArray(messages)) for (const item of messages) {
      if (typeof item === 'string') { sections.push({ role: 'user', text: item }); continue; }
      if (!object(item)) continue;
      const role = String(item.role || item.type || 'message');
      const text = contentText(item.content ?? item.parts ?? item.text ?? (item.tool_calls ? '' : item));
      sections.push({ role, text, meta: typeof item.name === 'string' ? item.name : undefined, toolCalls: item.tool_calls ? pretty(item.tool_calls) : undefined });
    }
    if (data.tools) sections.push({ role: 'tools', text: pretty(data.tools) });
    const excluded = new Set(['messages', 'contents', 'input', 'instructions', 'system', 'systemInstruction', 'system_instruction', 'tools', 'model']);
    const parameters = Object.fromEntries(Object.entries(data).filter(([key]) => !excluded.has(key)));
    return { sections, model: String(data.model || ''), parameters: Object.keys(parameters).length ? pretty(parameters) : '', raw: pretty(data), parsed: sections.length > 0 };
  } catch {
    // Truncated requests may no longer be valid JSON. Decode string literals
    // independently so their escaped newlines are still readable.
    const readable = content.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
      try { return JSON.parse(token) as string; } catch { return token; }
    });
    return { sections: [{ role: 'text', text: readable }], model: '', parameters: '', raw: content, parsed: false };
  }
}

type TextBlock = { text: string; code: boolean; language?: string };

function splitCodeBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) blocks.push({ text: prose.join('\n'), code: false });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence) { prose.push(lines[i]); continue; }
    flush();
    const code: string[] = [];
    const closing = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
    for (i++; i < lines.length && !closing.test(lines[i]); i++) code.push(lines[i]);
    blocks.push({ code: true, language: fence[2].trim().slice(0, 40), text: code.join('\n') });
  }
  flush();
  if (blocks.length === 1 && !blocks[0].code && /^[\s]*[{[]/.test(text)) {
    try { JSON.parse(text); return [{ code: true, language: 'JSON', text }]; } catch { /* Keep ordinary prose visible. */ }
  }
  return blocks;
}

function FoldedCode({ text, label, zh }: { text: string; label?: string; zh: boolean }) {
  return <details className={styles.codeFold}>
    <summary><span>{label || (zh ? '代码' : 'Code')}</span><small>{text.split('\n').length} {zh ? '行 · 点击展开 / 收起' : 'lines · Expand / collapse'}</small></summary>
    <pre>{text}</pre>
  </details>;
}

function ReadableContent({ text, zh }: { text: string; zh: boolean }) {
  const blocks = useMemo(() => splitCodeBlocks(text), [text]);
  return <div className={styles.messageContent}>{blocks.map((block, index) => block.code
    ? <FoldedCode key={index} text={block.text} zh={zh} label={block.language ? `${zh ? '代码' : 'Code'} · ${block.language}` : undefined} />
    : block.text.trim() ? <pre key={index}>{block.text}</pre> : null)}</div>;
}

function PromptTrace({ content, zh }: { content: string; zh: boolean }) {
  const trace = useMemo(() => buildPromptTrace(content), [content]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const labels: Record<TraceKind, string> = { input: zh ? '用户输入' : 'User input', context: zh ? '上下文' : 'Context', model: zh ? 'LLM 输出' : 'LLM output', call: zh ? '工具调用' : 'Tool call', result: zh ? '工具输出' : 'Tool output', other: zh ? '其他消息' : 'Other' };
  const query = search.trim().toLowerCase();
  const visible = trace.events.filter(event => (filter === 'all' || event.kind === filter || filter === 'tools' && ['call', 'result'].includes(event.kind)) && (!query || `${event.name || ''} ${event.text}`.toLowerCase().includes(query)));
  if (!trace.parsed) return <p className={styles.notice}>{zh ? '当前内容不完整或不含可识别的消息结构，请使用分段阅读查看已保存的文字。' : 'No complete message structure available. Use Readable to inspect the retained text.'}</p>;
  const focusEvent = (id: string) => { const element = document.getElementById(id); element?.scrollIntoView({ behavior: 'smooth', block: 'center' }); element?.focus({ preventScroll: true }); };
  return <div className={styles.trace}>
    <p className={styles.traceScope}>{zh ? '按本次请求携带的历史消息排列；不含本次请求的新回复，也不代表实际耗时。' : 'Ordered history included in this request. Excludes the new response and does not represent timing.'}</p>
    <div className={styles.traceOverview} aria-label={zh ? '消息顺序概览' : 'Message sequence'}>{trace.events.map((event, index) => <button key={event.id} type="button" data-kind={event.kind} aria-label={`${index + 1} · ${labels[event.kind]}`} title={`${index + 1} · ${labels[event.kind]} ${event.name || ''}`} onClick={() => { setFilter('all'); setSearch(''); window.setTimeout(() => focusEvent(event.id), 0); }} />)}</div>
    <div className={styles.traceControls}>
      <div className={styles.traceFilters}>{[['all', zh ? '全部' : 'All'], ['input', zh ? '输入' : 'Input'], ['model', 'LLM'], ['tools', zh ? '工具' : 'Tools'], ['context', zh ? '上下文' : 'Context']].map(([key, title]) => <Button key={key} size="sm" variant={filter === key ? 'primary' : 'ghost'} onClick={() => setFilter(key)}>{title}</Button>)}</div>
      <input className={styles.traceSearch} aria-label={zh ? '搜索轨迹' : 'Search trace'} placeholder={zh ? '搜索消息、工具名…' : 'Search messages, tools…'} value={search} onChange={event => setSearch(event.target.value)} />
    </div>
    <div className={styles.traceCounts}>{zh ? `共 ${trace.events.length} 个事件 · ${trace.events.filter(e => e.kind === 'input').length} 次输入 · ${trace.events.filter(e => e.kind === 'call').length} 次工具调用` : `${trace.events.length} events · ${trace.events.filter(e => e.kind === 'input').length} inputs · ${trace.events.filter(e => e.kind === 'call').length} tool calls`}</div>
    <div className={styles.traceRows}>
      {visible.map(event => <div className={styles.traceRow} data-kind={event.kind} id={event.id} tabIndex={-1} key={event.id}>
        <span className={styles.traceIndex}>{Number(event.id.slice(6)) + 1}</span>
        <details>
          <summary><span className={styles.traceBadge}>{labels[event.kind]}</span><span className={styles.traceTurn}>{event.turn ? `${zh ? '轮次' : 'Turn'} ${event.turn}` : '—'}</span>{event.name && <strong>{event.name}</strong>}<span className={styles.tracePreview}>{event.text.replace(/\s+/g, ' ').slice(0, 220) || (zh ? '仅工具调用' : 'Tool call only')}</span></summary>
          <div className={styles.traceDetail}>
            {event.callId && <div className={styles.meta}>Call ID: {event.callId}</div>}
            {event.linkedId && <Button size="sm" variant="ghost" onClick={() => { setFilter('all'); setSearch(''); window.setTimeout(() => focusEvent(event.linkedId!), 0); }}>{event.kind === 'call' ? (zh ? '定位工具输出' : 'Find result') : (zh ? '定位工具调用' : 'Find call')}</Button>}
            {!event.linkedId && ['call', 'result'].includes(event.kind) && <p className={styles.meta}>{zh ? '本段历史中没有可用调用 ID 对应的另一端。' : 'No matching call ID in this history.'}</p>}
            <ReadableContent text={event.text} zh={zh} />
          </div>
        </details>
      </div>)}
      {!visible.length && <p className={styles.meta}>{zh ? '没有符合条件的消息。' : 'No matching messages.'}</p>}
    </div>
  </div>;
}

export function RequestPrompt({ requestId, zh }: { requestId?: string; zh: boolean }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(false);
  const [traceMode, setTraceMode] = useState(true);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPrompt(undefined); setOpen(false); setError(''); setLoading(false); setRaw(false); return () => { generation.current++; }; }, [requestId]);
  const view = useMemo(() => parsePrompt(prompt?.content || ''), [prompt?.content]);
  const labels: Record<string, string> = { system: zh ? '系统提示词' : 'System', developer: zh ? '开发者指令' : 'Developer', user: zh ? '用户消息' : 'User', assistant: zh ? '助手消息' : 'Assistant', model: zh ? '助手消息' : 'Assistant', tool: zh ? '工具结果' : 'Tool result', tools: zh ? '工具定义' : 'Tool definitions', text: zh ? '提示词正文' : 'Prompt text' };
  const readable = view.sections.map((section, index) => `[${index + 1} · ${labels[section.role] || section.role}]\n${section.text}${section.toolCalls ? `\n\n${section.toolCalls}` : ''}`).join('\n\n');
  const load = async () => {
    setOpen(true);
    if (prompt || loading) return;
    const current = ++generation.current;
    const revision = proApiClient.getConnectionRevision();
    setLoading(true); setError('');
    try {
      const result = await proApiClient.get<Prompt>('/usage/prompt', { params: { request_id: requestId } });
      proApiClient.assertConnectionRevision(revision);
      if (current === generation.current) setPrompt(result);
    } catch {
      if (current === generation.current) setError(zh ? '内容已淘汰、尚未采集或读取失败。仅保留最新 50 条请求。' : 'Prompt expired, not captured, or unavailable. Only the newest 50 requests are retained.');
    } finally { if (current === generation.current) setLoading(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(raw ? view.raw : readable); setCopied(true); } catch { setError(zh ? '复制失败，请使用下载。' : 'Copy failed. Please download instead.'); } };
  const download = () => {
    const url = URL.createObjectURL(new Blob([raw ? view.raw : readable], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `prompt-${requestId}.${raw ? 'json' : 'txt'}`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className={styles.entry}>
    <div><strong>{zh ? '请求 Prompt' : 'Request prompt'}</strong><p>{zh ? '保留最新 50 条 · 图片和文件以占位符显示' : 'Newest 50 requests · Media shown as placeholders'}</p></div>
    <Button variant="secondary" size="sm" onClick={load} disabled={!requestId}>{zh ? '打开阅读窗口' : 'Open prompt reader'}</Button>
    <Modal open={open} onClose={() => setOpen(false)} width={1280} className={styles.dialog} title={zh ? 'Prompt 阅读器' : 'Prompt reader'} footer={<div className={styles.footer}>
      <span>{prompt ? `${((prompt.size_bytes ?? new TextEncoder().encode(prompt.content).length) / 1024).toFixed(1)} KiB` : ''}</span>
      <Button variant="secondary" size="sm" disabled={!prompt} onClick={copy}>{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制当前视图' : 'Copy view')}</Button>
      <Button variant="secondary" size="sm" disabled={!prompt} onClick={download}>{zh ? '下载' : 'Download'}</Button>
      <Button size="sm" onClick={() => setOpen(false)}>{zh ? '关闭' : 'Close'}</Button>
    </div>}>
      {loading && <p role="status">{zh ? '正在读取提示词…' : 'Loading prompt…'}</p>}
      {error && <p role="status" className={styles.notice}>{error}</p>}
      {prompt && <>
        <div className={styles.toolbar}>
          <div className={styles.tabs}><Button size="sm" variant={traceMode && !raw ? 'primary' : 'ghost'} onClick={() => { setTraceMode(true); setRaw(false); setCopied(false); }}>{zh ? '轨迹' : 'Trace'}</Button><Button size="sm" variant={!raw && !traceMode ? 'primary' : 'ghost'} onClick={() => { setTraceMode(false); setRaw(false); setCopied(false); }}>{zh ? '分段阅读' : 'Readable'}</Button><Button size="sm" variant={raw ? 'primary' : 'ghost'} onClick={() => { setRaw(true); setCopied(false); }}>{zh ? '原始 JSON' : 'Raw JSON'}</Button></div>
          <span className={styles.meta}>{view.model} {view.sections.length ? `· ${view.sections.length} ${zh ? '个区块' : 'sections'}` : ''}</span>
        </div>
        {prompt.truncated && <p className={styles.notice}>{zh ? '内容超过 1 MiB，已截断。当前显示已保存的部分。' : 'Truncated at 1 MiB. Showing the retained portion.'}</p>}
        {!raw && !view.parsed && <p className={styles.meta}>{zh ? '无法完整解析结构，已尽可能还原换行显示正文。' : 'Could not parse the complete structure. Showing text with decoded line breaks.'}</p>}
        <div className={styles.reader}>
          {raw ? <pre className={styles.raw}>{view.raw}</pre> : traceMode ? <PromptTrace content={prompt.content} zh={zh} /> : <>
            {view.sections.map((section, index) => <article className={styles.card} key={index} data-role={section.role}>
              <header><span className={styles.number}>{String(index + 1).padStart(2, '0')}</span><strong>{labels[section.role] || section.role}</strong>{section.meta && <span>{section.meta}</span>}</header>
              {section.role === 'tools' ? <FoldedCode text={section.text} zh={zh} label={zh ? '工具定义' : 'Tool definitions'} />
                : ['tool', 'function_call', 'function_call_output'].includes(section.role) ? <FoldedCode text={section.text} zh={zh} label={zh ? '工具调用 / 结果' : 'Tool call / result'} />
                  : <ReadableContent text={section.text} zh={zh} />}
              {section.toolCalls && <FoldedCode text={section.toolCalls} zh={zh} label={zh ? '工具调用参数' : 'Tool call arguments'} />}
            </article>)}
            {view.parameters && <details className={styles.parameters}><summary>{zh ? '请求参数' : 'Request parameters'}</summary><pre>{view.parameters}</pre></details>}
          </>}
        </div>
      </>}
    </Modal>
  </section>;
}
