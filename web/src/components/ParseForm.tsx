import type { KeyboardEvent } from 'react';
import { Button, Input } from 'antd';
import {
  ArrowRightOutlined,
  CloseOutlined,
  LockOutlined,
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
  const trimmed = props.text.trim();
  const canSubmit = props.serviceReady && trimmed.length > 0 && !props.submitting;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSubmit) {
      event.preventDefault();
      props.onSubmit();
    }
  };

  return (
    <section className="workspace-panel request-panel" aria-labelledby="request-title">
      <div className="section-number"><span>01 /</span><h2 id="request-title">输入分享内容</h2></div>
      <div className="field-group">
        <label htmlFor="share-text">分享文本或链接</label>
        <TextArea
          id="share-text"
          value={props.text}
          maxLength={2000}
          rows={7}
          readOnly={props.submitting}
          status={props.error ? 'error' : undefined}
          aria-describedby={`share-help${props.error ? ' share-error' : ''}`}
          placeholder="粘贴 App 中复制的完整分享文案，或输入支持平台的链接"
          onChange={(event) => props.onTextChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="field-meta" id="share-help">
          <span>完整分享文案更容易识别</span>
          <span aria-label={`已输入 ${props.text.length} 个字符`}>{props.text.length} / 2000</span>
        </div>
        {props.error && <p className="field-error" id="share-error" role="alert">{props.error}</p>}
      </div>

      <p className="retention-note">
        <LockOutlined />
        <span>提交内容、结果、IP 与 User-Agent 默认保留 30 天。<a href="#privacy">了解数据使用</a></span>
      </p>
      <div className="submit-actions">
        <Button
          type="primary"
          size="large"
          block
          icon={<ArrowRightOutlined />}
          loading={props.submitting}
          disabled={!canSubmit}
          onClick={props.onSubmit}
        >
          {props.submitting ? '正在解析' : '开始解析'}
        </Button>
        {props.submitting && (
          <Button size="large" block icon={<CloseOutlined />} onClick={props.onCancel}>
            取消请求
          </Button>
        )}
      </div>
      <p className="shortcut-hint">输入合法后，可按 Ctrl / Command + Enter 提交</p>
    </section>
  );
}
