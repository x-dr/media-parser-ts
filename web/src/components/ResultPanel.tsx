import { lazy, Suspense, useState } from 'react';
import { App as AntApp, Button, Tag } from 'antd';
import {
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CopyOutlined,
  ExclamationCircleFilled,
  InfoCircleFilled,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ParseFailure, PublicPlatform, ResultState } from '../types';

const MediaResultView = lazy(() => import('./MediaResultView'));

interface ResultPanelProps {
  state: ResultState;
  platforms: PublicPlatform[];
  onRetry: () => void;
}

export function ResultPanel({ state, platforms, onRetry }: ResultPanelProps) {
  const { message } = AntApp.useApp();
  const [copiedId, setCopiedId] = useState(false);

  const requestId = state.kind === 'success'
    ? state.response.request_id
    : state.kind === 'error'
      ? state.response.request_id
      : undefined;

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(true);
      void message.success('已复制 Request ID');
      window.setTimeout(() => setCopiedId(false), 1_600);
    } catch {
      void message.error('无法写入剪贴板');
    }
  };

  return (
    <section className={`workspace-panel result-panel state-${state.kind}`} aria-labelledby="result-title">
      <div className="result-heading">
        <div className="result-title-wrap">
          <span className={`result-badge badge-${state.kind}`} aria-hidden="true">
            {state.kind === 'success' && <CheckCircleFilled />}
            {state.kind === 'error' && <CloseCircleFilled />}
            {state.kind === 'cancelled' && <InfoCircleFilled />}
            {state.kind === 'loading' && <ClockCircleOutlined />}
          </span>
          <h2 className="panel-title" id="result-title">解析结果</h2>
        </div>
        {state.kind === 'success' && (
          <div className="result-metrics">
            <Tag color="success">HTTP {state.response.retcode}</Tag>
            {state.response.duration_ms !== undefined && (
              <Tag className="metric-duration">{formatDuration(state.response.duration_ms)}</Tag>
            )}
            {requestId && (
              <button
                type="button"
                className="metric-id-btn"
                onClick={() => void handleCopyId(requestId)}
                title={`点击复制 Request ID: ${requestId}`}
              >
                {copiedId ? <CheckOutlined /> : <CopyOutlined />}
                <span>{copiedId ? '已复制 ID' : shortRequestId(requestId)}</span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="result-content" aria-live="polite">
        {state.kind === 'loading' && <LoadingResult longWait={state.longWait} />}
        {state.kind === 'cancelled' && <CancelledResult onRetry={onRetry} />}
        {state.kind === 'error' && (
          <ErrorResult response={state.response} retryAfter={state.retryAfter} onRetry={onRetry} />
        )}
        {state.kind === 'success' && (
          <Suspense fallback={<div className="media-loading">正在整理媒体结果…</div>}>
            <MediaResultView
              key={state.response.request_id || state.response.data.video_id || 'result'}
              response={state.response}
              platforms={platforms}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}

function LoadingResult({ longWait }: { longWait: boolean }) {
  return (
    <div className="loading-result" role="status">
      <div className="loading-visual" aria-hidden="true">
        <span className="loading-ring" />
        <div className="pulse-loader"><i /><i /><i /></div>
      </div>
      <strong>正在识别并请求上游平台</strong>
      <p>部分短链需要多次跳转与资源提取，通常需要几秒到几十秒。</p>
      {longWait && (
        <div className="long-wait-banner">
          <ClockCircleOutlined aria-hidden="true" />
          <span>仍在处理中，你可以继续等待或随时取消请求。</span>
        </div>
      )}
      <div className="loading-skeleton" aria-hidden="true">
        <span className="skel-media" />
        <div className="skel-lines">
          <span className="skel-pill" />
          <span className="skel-title" />
          <span className="skel-line" />
          <span className="skel-btn" />
        </div>
      </div>
    </div>
  );
}

function CancelledResult({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="status-card is-info">
      <div className="status-card-icon" aria-hidden="true">
        <InfoCircleFilled />
      </div>
      <div className="status-card-body">
        <strong>请求已取消</strong>
        <p>已保留你的原始输入，你可以修改分享文本后重新发起解析。</p>
      </div>
      <Button icon={<ReloadOutlined />} onClick={onRetry}>重新解析</Button>
    </div>
  );
}

function ErrorResult({
  response,
  retryAfter,
  onRetry,
}: {
  response: ParseFailure;
  retryAfter: number | null;
  onRetry: () => void;
}) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const copy = errorCopy(response, retryAfter);
  const isWarning = response.error_code === 'RATE_LIMITED' || response.error_code === 'CONCURRENCY_LIMITED';

  const copyRequestId = async () => {
    if (!response.request_id) return;
    try {
      await navigator.clipboard.writeText(response.request_id);
      setCopied(true);
      void message.success('Request ID 已复制');
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      void message.error('无法写入剪贴板');
    }
  };

  return (
    <div className="error-result" role="alert">
      <div className={`status-card ${isWarning ? 'is-warning' : 'is-error'}`}>
        <div className="status-card-icon" aria-hidden="true">
          {isWarning ? <ExclamationCircleFilled /> : <CloseCircleFilled />}
        </div>
        <div className="status-card-body">
          <div className="status-card-head">
            <strong>{copy.title}</strong>
            {response.retcode > 0 && <span className="error-code-pill">HTTP {response.retcode}</span>}
          </div>
          <p className="error-desc">{response.retdesc}</p>
          <p className="error-suggestion">{copy.suggestion}</p>
        </div>
      </div>

      <div className="error-actions">
        <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>重新尝试</Button>
        {response.request_id && (
          <Button
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={() => void copyRequestId()}
          >
            {copied ? '已复制 Request ID' : '复制 Request ID'}
          </Button>
        )}
      </div>

      <details className="technical-error">
        <summary>原始响应</summary>
        <pre>{JSON.stringify(response, null, 2)}</pre>
      </details>
    </div>
  );
}

function errorCopy(response: ParseFailure, retryAfter: number | null) {
  const code = response.error_code;
  if (code === 'RATE_LIMITED' || code === 'CONCURRENCY_LIMITED') {
    return {
      title: '请求过于频繁',
      suggestion: retryAfter ? `请在 ${retryAfter} 秒后重试。` : '请稍后重试。',
    };
  }
  if (code === 'PLATFORM_NOT_SUPPORTED') return { title: '暂不支持这个平台', suggestion: '检查链接来源，或查看下方支持平台目录。' };
  if (code === 'PLATFORM_DISABLED') return { title: '平台正在维护', suggestion: '该平台当前暂不可用，请稍后再试或尝试其他平台。' };
  if (code === 'PUBLIC_WEB_UNAVAILABLE' || response.retcode === 503) return { title: '服务暂未就绪', suggestion: '你的输入已保留，请稍后重新尝试。' };
  if (code === 'NETWORK_ERROR') return { title: '无法连接服务', suggestion: '请检查网络连接后重新尝试。' };
  if (['INVALID_TEXT', 'TEXT_TOO_LONG', 'INVALID_REQUEST', 'URL_NOT_FOUND'].includes(code)) {
    return { title: '分享文本不符合要求', suggestion: '请检查内容是否为空、超过 2000 字符，或是否包含有效链接。' };
  }
  return { title: '暂时无法完成解析', suggestion: '请稍后重试；若持续失败，可复制 Request ID 便于排查。' };
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function shortRequestId(id: string): string {
  return id.length > 12 ? `ID ${id.slice(0, 8)}…` : `ID ${id}`;
}
