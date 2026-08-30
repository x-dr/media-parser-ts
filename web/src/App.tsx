import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrandHeader, type ServiceState } from './components/BrandHeader';
import { Hero } from './components/Hero';
import { ParseForm } from './components/ParseForm';
import { ResultPanel } from './components/ResultPanel';
import { PlatformGrid } from './components/PlatformGrid';
import { PrivacySection } from './components/PrivacySection';
import { getPlatforms, getStatus, networkFailure, parseMedia } from './lib/api';
import type { PublicPlatform, ResultState, ServiceStatus } from './types';

export function App() {
  const [serviceState, setServiceState] = useState<ServiceState>('checking');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [platforms, setPlatforms] = useState<PublicPlatform[]>([]);
  const [platformsLoading, setPlatformsLoading] = useState(true);
  const [text, setText] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultState>({ kind: 'empty' });
  const requestController = useRef<AbortController | null>(null);
  const longWaitTimer = useRef<number | null>(null);

  const checkStatus = useCallback(async () => {
    setServiceState('checking');
    try {
      const next = await getStatus();
      setStatus(next);
      setServiceState(next.ready ? 'ready' : 'unready');
    } catch {
      setStatus(null);
      setServiceState('unreachable');
    }
  }, []);

  useEffect(() => {
    void checkStatus();
    const controller = new AbortController();
    void getPlatforms(controller.signal)
      .then((response) => setPlatforms(response.data.items))
      .catch(() => setPlatforms([]))
      .finally(() => setPlatformsLoading(false));
    return () => controller.abort();
  }, [checkStatus]);

  useEffect(() => () => {
    requestController.current?.abort();
    if (longWaitTimer.current !== null) window.clearTimeout(longWaitTimer.current);
  }, []);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setInputError('请输入分享文本或链接');
      return;
    }
    if (!status?.ready || requestController.current) return;
    setInputError(null);
    setResult({ kind: 'loading', longWait: false });
    const controller = new AbortController();
    requestController.current = controller;
    longWaitTimer.current = window.setTimeout(() => {
      setResult((current) => current.kind === 'loading' ? { kind: 'loading', longWait: true } : current);
    }, 10_000);
    try {
      const output = await parseMedia(trimmed, controller.signal);
      setResult(output.response.succ
        ? { kind: 'success', response: output.response }
        : { kind: 'error', response: output.response, retryAfter: output.retryAfter });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setResult({ kind: 'cancelled' });
      } else {
        setResult({ kind: 'error', response: networkFailure(), retryAfter: null });
      }
    } finally {
      if (longWaitTimer.current !== null) window.clearTimeout(longWaitTimer.current);
      longWaitTimer.current = null;
      requestController.current = null;
    }
  };

  const handleCancel = () => requestController.current?.abort();
  const handleRetry = () => {
    document.getElementById('share-text')?.focus();
    document.getElementById('request-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleTextChange = (value: string) => {
    setText(value);
    if (inputError) setInputError(null);
  };

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#6c4de6',
          colorInfo: '#6c4de6',
          colorLink: '#6c4de6',
          colorSuccess: '#1ba97c',
          colorWarning: '#b87503',
          colorError: '#d93026',
          colorText: '#1d2129',
          colorTextSecondary: '#4e5562',
          colorTextTertiary: '#8a919e',
          colorBorder: '#e5e8ec',
          colorBorderSecondary: '#eef0f3',
          colorBgLayout: '#f7f8fa',
          borderRadius: 8,
          controlHeightLG: 46,
          fontFamily: '"PingFang SC", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
        },
        components: {
          Button: { primaryShadow: '0 6px 16px rgb(108 77 230 / 30%)', fontWeight: 500 },
          Input: { activeShadow: '0 0 0 3px rgb(108 77 230 / 14%)', borderRadius: 10 },
          Collapse: { headerBg: '#fff', contentBg: '#fff' },
          Tag: { borderRadiusSM: 6 },
          Alert: { borderRadiusLG: 10 },
        },
      }}
    >
      <AntApp>
        <div className="public-app" id="top">
          <BrandHeader
            serviceState={serviceState}
            platformCount={platforms.filter((platform) => platform.enabled).length}
            onRefresh={() => void checkStatus()}
          />
          <main>
            <Hero />
            <div className="workspace">
              <ParseForm
                text={text}
                submitting={result.kind === 'loading'}
                serviceReady={status?.ready ?? false}
                error={inputError}
                onTextChange={handleTextChange}
                onSubmit={() => void handleSubmit()}
                onCancel={handleCancel}
              />
              {result.kind !== 'empty' && <ResultPanel state={result} onRetry={handleRetry} />}
            </div>
            <PlatformGrid platforms={platforms} loading={platformsLoading} />
            <PrivacySection />
          </main>
          <footer>
            <span><strong>Media Parser</strong> · 匿名媒体解析工具</span>
            <span>支持平台与媒体能力会随上游变化</span>
            <a href="#privacy">隐私说明</a>
          </footer>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}
