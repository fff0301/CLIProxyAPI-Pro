import { useEffect, useState } from 'react';
import { proApiClient } from '@/pro/shared/proManagementTransport';
import { modelAuditItems, resolveModelAudit } from '../modelAudit';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { MonitoringStatusTone } from '../hooks/useMonitoringData';
import {
  buildRealtimeMetaText,
  buildRealtimeStatusLabel,
  compactRealtimeErrorMessage,
  formatRealtimeTokenBreakdown,
  translateRealtimeErrorCategory,
  translateRealtimeErrorText,
  type RealtimeLogRow,
} from '../realtimeLogPresentation';
import { maskSensitiveText } from '@/pro/shared/maskSensitiveText';
import { ProInformationDetails, type ProInformationDetailsTone } from '@/pro/shared/ProInformationDetails';
import styles from '../monitoring.module.scss';

export function StatusBadge({ tone, children }: { tone: MonitoringStatusTone; children: ReactNode }) {
  return <span className={`${styles.statusBadge} ${styles[`tone${tone}`]}`}>{children}</span>;
}

export function RealtimeRequestDetailsPanel({
  row,
  t,
  language,
}: {
  row: RealtimeLogRow;
  t: TFunction;
  language?: string;
}) {
  const audit = resolveModelAudit(row);
  const zh = language?.startsWith('zh') ?? true;
  const categoryText = translateRealtimeErrorCategory(row.errorCategoryKey, t, language);
  const statusText = row.failed
    ? buildRealtimeStatusLabel(row, t('monitoring.result_failed'))
    : t('monitoring.result_success');
  const summaryText = row.failed
    ? row.errorMessage
      ? compactRealtimeErrorMessage(row.errorMessage, 220)
      : row.errorSummary || row.diagnosticText || categoryText
    : buildRealtimeMetaText(row);
  const requestItems = [
    { label: translateRealtimeErrorText('client_ip', t, language), value: row.clientIP || '-' },
    { label: translateRealtimeErrorText('x_forwarded_for', t, language), value: row.xForwardedFor || '-' },
    { label: translateRealtimeErrorText('http_status', t, language), value: row.statusCode !== null ? String(row.statusCode) : '-' },
    { label: translateRealtimeErrorText('error_code', t, language), value: row.errorCode || '-' },
    { label: translateRealtimeErrorText('upstream_request_id', t, language), value: row.upstreamRequestId || '-' },
    { label: translateRealtimeErrorText('retry_after', t, language), value: row.retryAfter || '-' },
    { label: translateRealtimeErrorText('attempt_index', t, language), value: row.attemptIndex !== null ? String(row.attemptIndex) : '-' },
    { label: translateRealtimeErrorText('user_agent', t, language), value: row.userAgent || '-', wide: true, mono: false },
  ].filter((item) => item.value !== '-');
  const usageItems = [
    { label: translateRealtimeErrorText('accounting_version', t, language), value: row.accountingVersion !== null ? String(row.accountingVersion) : '-' },
    { label: translateRealtimeErrorText('accounting_quality', t, language), value: row.accountingQuality || '-' },
    { label: zh ? '输出速度（估算）' : 'Output throughput (estimated)', value: row.outputTPS == null ? '-' : `${row.outputTPS.toFixed(2)} tok/s` },
    { label: t('monitoring.cost_detail_requested_tier'), value: row.serviceTier || '-' },
    { label: t('monitoring.cost_detail_actual_tier'), value: row.effectiveServiceTier || '-' },
    { label: t('monitoring.cost_detail_requested_speed'), value: row.speed || '-' },
    { label: t('monitoring.cost_detail_actual_speed'), value: row.effectiveSpeed || '-' },
    { label: translateRealtimeErrorText('token_breakdown', t, language), value: formatRealtimeTokenBreakdown(row.tokenBreakdown) || '-', wide: true },
  ].filter((item) => item.value !== '-');
  const tone: ProInformationDetailsTone = row.failed ? 'danger' : 'good';

  return (
    <>
    <ProInformationDetails
      className={styles.informationDetailsTheme}
      tone={tone}
      layout="compact"
      status={(
        <div className={styles.realtimeErrorOverviewTop}>
          <StatusBadge tone={row.failed ? 'bad' : 'good'}>{statusText}</StatusBadge>
        </div>
      )}
      context={row.failed ? categoryText : undefined}
      summary={summaryText}
      groups={[
        { title: t('monitoring.model_audit_title'), items: modelAuditItems(row, t).map((item) => ({
          ...item, value: item.key === 'response' && audit.responseTone
            ? <span className={styles[`modelAudit${audit.responseTone}`]}>{item.value}</span> : item.value,
        })) },
        {
          title: translateRealtimeErrorText('request_context', t, language),
          items: requestItems.map((item) => ({ ...item, value: maskSensitiveText(item.value) })),
        },
        {
          title: translateRealtimeErrorText('usage_context', t, language),
          items: usageItems.map((item) => ({ ...item, value: maskSensitiveText(item.value) })),
        },
      ]}
      detailLabel={row.failed && row.errorMessage ? translateRealtimeErrorText('error_message', t, language) : undefined}
      detail={row.failed && row.errorMessage ? (
        <pre>{compactRealtimeErrorMessage(row.errorMessage, 1200)}</pre>
      ) : undefined}
    />
    <RequestPrompt key={row.requestId} requestId={row.requestId} zh={zh} />
    </>
  );
}

export function RecentPattern({
  pattern,
  variant = 'default',
  label,
}: {
  pattern: boolean[];
  variant?: 'default' | 'plain';
  label?: string;
}) {
  const normalized = pattern.length > 0 ? pattern : Array.from({ length: 10 }, () => true);
  const successCount = normalized.filter(Boolean).length;
  const failureCount = normalized.length - successCount;
  const ariaLabel = label ?? `Recent ${normalized.length} requests: ${successCount} succeeded, ${failureCount} failed`;
  const containerClassName = [
    styles.patternBars,
    variant === 'plain' ? styles.patternBarsPlain : '',
  ]
    .filter(Boolean)
    .join(' ');
  const barClassName = [styles.patternBar, variant === 'plain' ? styles.patternBarPlain : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={containerClassName} role="img" aria-label={ariaLabel}>
      {normalized.map((item, index) => (
        <span
          key={index}
          className={`${barClassName} ${item ? styles.patternSuccess : styles.patternFailed}`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

function RequestPrompt({ requestId, zh }: { requestId?: string; zh: boolean }) {
  const [state, setState] = useState<{ content?: string; truncated?: boolean; error?: string; loading?: boolean }>({});
  useEffect(() => { setState({}); }, [requestId]);
  const load = async () => {
    const revision = proApiClient.getConnectionRevision();
    setState({ loading: true });
    try {
      const result = await proApiClient.get<{ content: string; truncated: boolean }>('/usage/prompt', { params: { request_id: requestId } });
      proApiClient.assertConnectionRevision(revision);
      setState(result);
    } catch {
      setState({ error: zh ? '内容已淘汰、尚未采集或读取失败。仅保留最新 50 条请求。' : 'Prompt expired, not captured, or unavailable. Only the newest 50 requests are retained.' });
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([state.content || ''], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `prompt-${requestId}.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <section style={{ marginTop: 16 }}>
    <strong>{zh ? '请求 Prompt' : 'Request prompt'}</strong>
    <p>{zh ? '保留最新 50 条，每条最多 1 MiB；图片、音频和文件内容以占位符显示。' : 'Newest 50 requests, up to 1 MiB each. Media is replaced with placeholders.'}</p>
    <button type="button" onClick={load} disabled={!requestId || state.loading}>{state.loading ? (zh ? '读取中…' : 'Loading…') : (zh ? '查看 Prompt' : 'View prompt')}</button>
    {state.content && <>
      <button type="button" onClick={() => navigator.clipboard.writeText(state.content || '')}>{zh ? '复制' : 'Copy'}</button>
      <button type="button" onClick={download}>{zh ? '下载' : 'Download'}</button>
      {state.truncated && <p role="status">{zh ? '超过 1 MiB，内容已截断。' : 'Content truncated at 1 MiB.'}</p>}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto', padding: 12, background: 'var(--bg-tertiary, #eee)', color: 'var(--text-primary, #222)' }}>{state.content}</pre>
    </>}
    {state.error && <p role="status">{state.error}</p>}
  </section>;
}
