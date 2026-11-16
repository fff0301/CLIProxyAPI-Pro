import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { proApiClient } from '@/pro/shared/proManagementTransport';
import styles from './RequestPrompt.module.scss';

type Prompt = { content: string; truncated: boolean; size_bytes?: number };
type Section = { role: string; text: string; meta?: string };
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
      let text = contentText(item.content ?? item.parts ?? item.text ?? item);
      if (item.tool_calls) text += '\n\n' + pretty(item.tool_calls);
      sections.push({ role, text, meta: typeof item.name === 'string' ? item.name : undefined });
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

export function RequestPrompt({ requestId, zh }: { requestId?: string; zh: boolean }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPrompt(undefined); setOpen(false); setError(''); setLoading(false); setRaw(false); return () => { generation.current++; }; }, [requestId]);
  const view = useMemo(() => parsePrompt(prompt?.content || ''), [prompt?.content]);
  const labels: Record<string, string> = { system: zh ? '系统提示词' : 'System', developer: zh ? '开发者指令' : 'Developer', user: zh ? '用户消息' : 'User', assistant: zh ? '助手消息' : 'Assistant', model: zh ? '助手消息' : 'Assistant', tool: zh ? '工具结果' : 'Tool result', tools: zh ? '工具定义' : 'Tool definitions', text: zh ? '提示词正文' : 'Prompt text' };
  const readable = view.sections.map((section, index) => `[${index + 1} · ${labels[section.role] || section.role}]\n${section.text}`).join('\n\n');
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
    <Modal open={open} onClose={() => setOpen(false)} width={1080} className={styles.dialog} title={zh ? 'Prompt 阅读器' : 'Prompt reader'} footer={<div className={styles.footer}>
      <span>{prompt ? `${((prompt.size_bytes ?? new TextEncoder().encode(prompt.content).length) / 1024).toFixed(1)} KiB` : ''}</span>
      <Button variant="secondary" size="sm" disabled={!prompt} onClick={copy}>{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制当前视图' : 'Copy view')}</Button>
      <Button variant="secondary" size="sm" disabled={!prompt} onClick={download}>{zh ? '下载' : 'Download'}</Button>
      <Button size="sm" onClick={() => setOpen(false)}>{zh ? '关闭' : 'Close'}</Button>
    </div>}>
      {loading && <p role="status">{zh ? '正在读取提示词…' : 'Loading prompt…'}</p>}
      {error && <p role="status" className={styles.notice}>{error}</p>}
      {prompt && <>
        <div className={styles.toolbar}>
          <div className={styles.tabs}><Button size="sm" variant={raw ? 'ghost' : 'primary'} onClick={() => { setRaw(false); setCopied(false); }}>{zh ? '分段阅读' : 'Readable'}</Button><Button size="sm" variant={raw ? 'primary' : 'ghost'} onClick={() => { setRaw(true); setCopied(false); }}>{zh ? '原始 JSON' : 'Raw JSON'}</Button></div>
          <span className={styles.meta}>{view.model} {view.sections.length ? `· ${view.sections.length} ${zh ? '个区块' : 'sections'}` : ''}</span>
        </div>
        {prompt.truncated && <p className={styles.notice}>{zh ? '内容超过 1 MiB，已截断。当前显示已保存的部分。' : 'Truncated at 1 MiB. Showing the retained portion.'}</p>}
        {!raw && !view.parsed && <p className={styles.meta}>{zh ? '无法完整解析结构，已尽可能还原换行显示正文。' : 'Could not parse the complete structure. Showing text with decoded line breaks.'}</p>}
        <div className={styles.reader}>
          {raw ? <pre className={styles.raw}>{view.raw}</pre> : <>
            {view.sections.map((section, index) => <article className={styles.card} key={index} data-role={section.role}>
              <header><span className={styles.number}>{String(index + 1).padStart(2, '0')}</span><strong>{labels[section.role] || section.role}</strong>{section.meta && <span>{section.meta}</span>}</header>
              {section.role === 'tools' ? <details><summary>{zh ? '展开工具定义' : 'Expand tool definitions'}</summary><pre>{section.text}</pre></details> : <pre>{section.text}</pre>}
            </article>)}
            {view.parameters && <details className={styles.parameters}><summary>{zh ? '请求参数' : 'Request parameters'}</summary><pre>{view.parameters}</pre></details>}
          </>}
        </div>
      </>}
    </Modal>
  </section>;
}
