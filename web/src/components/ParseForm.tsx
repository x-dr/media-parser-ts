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
      props.onTextChange(value.slice(0, 2000));
    } catch {
      void message.error('无法读取剪贴板，请手动粘贴');
    }
  };

  return (
    <section className="workspace-panel request-panel" aria-labelledby="request-title">
      <h2 className="panel-title" id="request-title">输入分享内容</h2>
      <div className="field-group">
        <label htmlFor="share-text">分享文本或链接</label>
        <TextArea
          id="share-text"
          value={props.text}
          maxLength={2000}
          rows={6}
          readOnly={props.submitting}
          status={props.error ? 'error' : undefined}
          aria-describedby={`share-help${props.error ? ' share-error' : ''}`}
          placeholder="粘贴带链接的文本"
          onChange={(event) => props.onTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="field-meta" id="share-help">
          <span>完整分享文案更容易识别</span>
          <span aria-label={`已输入 ${props.text.length} 个字符`}>{props.text.length} / 2000</span>
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
          {props.submitting ? '正在解析' : '开始解析'}
        </Button>
        {props.submitting ? (
          <Button className="parse-tool" size="large" icon={<CloseOutlined />} onClick={props.onCancel}>
            取消请求
          </Button>
        ) : (
          <>
            <Button className="parse-tool" size="large" icon={<SnippetsOutlined />} onClick={() => void handlePaste()}>
              粘贴链接
            </Button>
            <Button
              className="parse-tool"
              size="large"
              icon={<DeleteOutlined />}
              disabled={props.text.length === 0}
              onClick={() => props.onTextChange('')}
            >
              清除内容
            </Button>
          </>
        )}
      </div>
      <p className="retention-note">
        <LockOutlined />
        <span>提交内容、结果、IP 与 User-Agent 默认保留 30 天。<a href="#privacy">了解数据使用</a></span>
      </p>
      <p className="shortcut-hint">输入合法后，可按 Ctrl / Command + Enter 提交</p>
    </section>
  );
}
