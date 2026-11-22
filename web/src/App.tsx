import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  const enabledPlatformCount = useMemo(
    () => platforms.filter((platform) => platform.enabled).length,
    [platforms],
  );

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
          colorPrimaryHover: '#5b3cd9',
          colorPrimaryActive: '#4d30c4',
          colorInfo: '#6c4de6',
          colorLink: '#6c4de6',
          colorLinkHover: '#5b3cd9',
          colorSuccess: '#10b981',
          colorWarning: '#d97706',
          colorError: '#dc2626',
          colorText: '#0f172a',
          colorTextSecondary: '#475569',
          colorTextTertiary: '#64748b',
          colorBorder: '#e2e8f0',
          colorBorderSecondary: '#eef2f6',
          colorBgLayout: '#f6f7fb',
          borderRadius: 10,
          controlHeightLG: 42,
          fontFamily: '"PingFang SC", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        },
        components: {
          Button: {
            primaryShadow: '0 8px 20px -4px rgb(108 77 230 / 38%)',
            defaultBorderColor: '#e2e8f0',
            fontWeight: 500,
            borderRadiusLG: 12,
          },
          Input: {
            activeShadow: '0 0 0 4px rgb(108 77 230 / 12%)',
            borderRadius: 12,
          },
          Collapse: {
            headerBg: '#ffffff',
            contentBg: '#ffffff',
            headerPadding: '14px 18px',
            contentPadding: '16px 18px',
          },
          Tag: { borderRadiusSM: 999 },
          Alert: { borderRadiusLG: 12 },
        },
      }}
    >
      <AntApp>
        <div className="public-app" id="top">
          <div className="ambient-bg" aria-hidden="true">
            <div className="ambient-orb ambient-orb-primary" />
            <div className="ambient-orb ambient-orb-accent" />
            <div className="ambient-grid" />
          </div>
          <BrandHeader
            serviceState={serviceState}
            platformCount={enabledPlatformCount}
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
              {result.kind !== 'empty' && (
                <ResultPanel state={result} platforms={platforms} onRetry={handleRetry} />
              )}
            </div>
            <PlatformGrid platforms={platforms} loading={platformsLoading} />
            <PrivacySection />
          </main>
          <footer className="site-footer">
            <div className="site-footer-inner">
              <div className="footer-brand">
                <span className="footer-dot" aria-hidden="true" />
                <strong>Media Parser</strong>
                <span className="footer-sep" aria-hidden="true">·</span>
                <span>匿名媒体解析工具</span>
              </div>
              <p className="footer-note">支持平台与媒体能力会随上游策略实时变化</p>
              <div className="footer-links">
                <a href="#top">返回顶部</a>
                <a href="#platforms">支持平台</a>
                <a href="#privacy">隐私说明</a>
              </div>
            </div>
          </footer>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}
