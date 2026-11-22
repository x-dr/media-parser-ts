import type { KeyboardEvent } from 'react';
import { App as AntApp, Button, Input } from 'antd';
import {
  CloseOutlined,
  DeleteOutlined,
  LockOutlined,
  SnippetsOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

const { TextArea } = Input;

const MAX_LENGTH = 2000;

interface ParseFormProps {
  text: string;
  submitting: boolean;
  serviceReady: boolean;
  error: string | null;
  onTextChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function ParseForm(props: ParseFormProps) {
  const { message } = AntApp.useApp();
  const trimmed = props.text.trim();
  const canSubmit = props.serviceReady && trimmed.length > 0 && !props.submitting;
  const charCount = props.text.length;
  const countTone = charCount >= MAX_LENGTH ? 'is-limit' : charCount >= 1700 ? 'is-near' : '';

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSubmit) {
      event.preventDefault();
      props.onSubmit();
    }
  };

  const handlePaste = async () => {
    try {
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        void message.warning('剪贴板为空，请先复制分享文本');
        return;
      }
      props.onTextChange(value.slice(0, MAX_LENGTH));
      void message.success('已从剪贴板粘贴内容');
    } catch {
      void message.error('无法读取剪贴板，请手动粘贴');
    }
  };

  return (
    <section className="workspace-panel request-panel" aria-labelledby="request-title">
      <div className="request-header">
        <div className="request-title-group">
          <h2 className="panel-title" id="request-title">输入分享内容</h2>
          <label className="field-inline-label" htmlFor="share-text">分享文本或链接</label>
        </div>
        <span
          className={`char-counter ${countTone}`}
          aria-label={`已输入 ${charCount} 个字符，上限 ${MAX_LENGTH}`}
        >
          {charCount} / {MAX_LENGTH}
        </span>
      </div>

      <div className="field-group">
        <div
          className={`composer-shell${props.error ? ' is-error' : ''}${props.submitting ? ' is-readonly' : ''}`}
        >
          <TextArea
            id="share-text"
            variant="borderless"
            value={props.text}
            maxLength={MAX_LENGTH}
            autoSize={{ minRows: 5, maxRows: 10 }}
            readOnly={props.submitting}
            status={props.error ? 'error' : undefined}
            aria-describedby={`share-help${props.error ? ' share-error' : ''}`}
            placeholder="粘贴 App 中复制的完整分享文案，或输入支持平台的链接…"
            onChange={(event) => props.onTextChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="composer-footer" id="share-help">
            <span className="composer-tip">可直接粘贴整段分享文案，无需手工提取 URL</span>
            <span className="shortcut-keys" aria-hidden="true">
              <kbd>Ctrl</kbd>
              <span>/</span>
              <kbd>⌘</kbd>
              <span>+</span>
              <kbd>Enter</kbd>
              <em>提交</em>
            </span>
          </div>
        </div>
        {props.error && <p className="field-error" id="share-error" role="alert">{props.error}</p>}
      </div>

      <div className="submit-actions">
        <Button
          className="parse-submit"
          type="primary"
          size="large"
          icon={<ThunderboltOutlined />}
          loading={props.submitting}
          disabled={!canSubmit}
          onClick={props.onSubmit}
        >
          {props.submitting ? '正在解析…' : '开始解析'}
        </Button>
        {props.submitting ? (
          <Button
            className="parse-tool parse-cancel"
            size="large"
            danger
            icon={<CloseOutlined />}
            onClick={props.onCancel}
          >
            取消请求
          </Button>
        ) : (
          <>
            <Button
              className="parse-tool"
              size="large"
              icon={<SnippetsOutlined />}
              onClick={() => void handlePaste()}
            >
              粘贴链接
            </Button>
            <Button
              className="parse-tool"
              size="large"
              icon={<DeleteOutlined />}
              disabled={charCount === 0}
              onClick={() => props.onTextChange('')}
            >
              清除内容
            </Button>
          </>
        )}
      </div>

      <div className="retention-strip">
        <LockOutlined aria-hidden="true" />
        <span>
          提交内容、结果、IP 与 User-Agent 默认保留 30 天，用于提供解析与排查故障。
          <a href="#privacy">了解数据使用</a>
        </span>
      </div>
    </section>
  );
}
