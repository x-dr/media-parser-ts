import { lazy, Suspense } from 'react';
import { Alert, Button, Tag } from 'antd';
import {
  CopyOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ParseFailure, ResultState } from '../types';

const MediaResultView = lazy(() => import('./MediaResultView'));

interface ResultPanelProps {
  state: ResultState;
  onRetry: () => void;
}

export function ResultPanel({ state, onRetry }: ResultPanelProps) {
  return (
    <section className="workspace-panel result-panel" aria-labelledby="result-title">
      <div className="result-heading">
        <h2 className="panel-title" id="result-title">解析结果</h2>
        {state.kind === 'success' && (
          <div className="result-metrics">
            <Tag color="success">HTTP {state.response.retcode}</Tag>
            {state.response.duration_ms !== undefined && <Tag>{formatDuration(state.response.duration_ms)}</Tag>}
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
            <MediaResultView response={state.response} />
          </Suspense>
        )}
      </div>
    </section>
  );
}

function LoadingResult({ longWait }: { longWait: boolean }) {
  return (
    <div className="loading-result" role="status">
      <div className="pulse-loader" aria-hidden="true"><i /><i /><i /></div>
      <strong>正在识别并请求上游平台</strong>
      <p>部分短链需要多次跳转，通常需要几秒到几十秒。</p>
      {longWait && <p className="long-wait">仍在处理中，你可以继续等待或取消请求。</p>}
    </div>
  );
}

function CancelledResult({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert
      type="info"
      showIcon
      title="请求已取消"
      description="你可以修改分享文本后重新发起。"
      action={<Button icon={<ReloadOutlined />} onClick={onRetry}>重新解析</Button>}
    />
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
  const copy = errorCopy(response, retryAfter);
  const copyRequestId = () => {
    if (response.request_id) void navigator.clipboard.writeText(response.request_id);
  };
  return (
    <div className="error-result" role="alert">
      <Alert
        type={response.error_code === 'RATE_LIMITED' ? 'warning' : 'error'}
        showIcon
        title={copy.title}
        description={<><span>{response.retdesc}</span><small>{copy.suggestion}</small></>}
      />
      <div className="error-actions">
        <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>重新尝试</Button>
        {response.request_id && (
          <Button icon={<CopyOutlined />} onClick={copyRequestId}>复制 Request ID</Button>
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
  if (code === 'PLATFORM_NOT_SUPPORTED') return { title: '暂不支持这个平台', suggestion: '检查链接来源，或查看下方支持平台。' };
  if (code === 'PLATFORM_DISABLED') return { title: '平台正在维护', suggestion: '稍后再试或选择其他平台。' };
  if (code === 'PUBLIC_WEB_UNAVAILABLE' || response.retcode === 503) return { title: '服务暂未就绪', suggestion: '输入已保留，请稍后重试。' };
  if (code === 'NETWORK_ERROR') return { title: '无法连接服务', suggestion: '检查网络后重新尝试。' };
  if (['INVALID_TEXT', 'TEXT_TOO_LONG', 'INVALID_REQUEST', 'URL_NOT_FOUND'].includes(code)) {
    return { title: '分享文本不符合要求', suggestion: '检查内容是否为空、过长，或是否包含有效链接。' };
  }
  return { title: '暂时无法完成解析', suggestion: '请稍后重试；若持续失败，可记录 Request ID。' };
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}
