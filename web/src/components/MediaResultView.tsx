import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Avatar, Button, Collapse, Image, Tag } from 'antd';
import {
  AudioOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CodeOutlined,
  CopyOutlined,
  ExportOutlined,
  FileImageOutlined,
  FileTextOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { CollapseProps } from 'antd';
import {
  platformFallbackColor,
  platformFallbackMark,
  platformIconUrl,
} from '@media-parser/platform-icons';
import type { ParseSuccess, PublicPlatform } from '../types';
import {
  formatSecondsDuration,
  formatSubtitleTime,
  normalizeImages,
  safeHttpUrl,
  videoUrls,
} from '../lib/media';

interface MediaResultViewProps {
  response: ParseSuccess;
  platforms?: PublicPlatform[];
}

export function MediaResultView({ response, platforms = [] }: MediaResultViewProps) {
  const { data } = response;
  const videos = useMemo(() => videoUrls(data), [data]);
  const images = useMemo(() => normalizeImages(data), [data]);
  const liveCount = useMemo(
    () => images.filter((item) => item.livePhotoUrl !== null).length,
    [images],
  );
  const audio = safeHttpUrl(data.audio_url);
  const cover = safeHttpUrl(data.cover_url);
  const previewCover = cover ?? images.find((item) => item.imageUrl !== null)?.imageUrl ?? null;
  const avatar = safeHttpUrl(data.author?.avatar);
  const subtitles = data.subtitles ?? [];
  const [activeVideo, setActiveVideo] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  const currentVideo = videos[activeVideo] ?? null;
  const trimmedTitle = data.title?.trim() || '未提供标题';
  const trimmedDesc = data.desc?.trim() || '';
  const showDesc = Boolean(trimmedDesc && trimmedDesc !== trimmedTitle);

  const matchedPlatform = useMemo(() => {
    const raw = data.platform?.trim().toLowerCase();
    if (!raw) return null;
    return platforms.find(
      (item) => item.name.toLowerCase() === raw || item.id.toLowerCase() === raw,
    ) ?? null;
  }, [data.platform, platforms]);

  const platformIcon = matchedPlatform ? platformIconUrl(matchedPlatform.id) : null;

  const defaultActiveKey = useMemo(() => {
    if (!currentVideo && images.length > 0) return ['images'];
    if (!currentVideo && images.length === 0 && audio) return ['audio'];
    return [];
  }, [audio, currentVideo, images.length]);

  const resourceStats = [
    ...(videos.length > 0 ? [{ key: 'video', icon: <VideoCameraOutlined />, label: `视频 ×${videos.length}` }] : []),
    ...(images.length > 0 ? [{ key: 'image', icon: <PictureOutlined />, label: `图片 ×${images.length}` }] : []),
    ...(liveCount > 0 ? [{ key: 'live', icon: <PlayCircleOutlined />, label: `实况 ×${liveCount}` }] : []),
    ...(audio ? [{ key: 'audio', icon: <AudioOutlined />, label: '音频' }] : []),
    ...(subtitles.length > 0 ? [{ key: 'subtitle', icon: <FileTextOutlined />, label: `字幕 ×${subtitles.length}` }] : []),
  ];

  const items: CollapseProps['items'] = [
    ...(images.length > 0 ? [{
      key: 'images',
      label: <ResourceLabel icon={<PictureOutlined />} label="图集与实况" count={images.length} unit="张" />,
      children: <ImageGallery images={images} />,
    }] : []),
    ...(audio ? [{
      key: 'audio',
      label: <ResourceLabel icon={<AudioOutlined />} label="音频资源" count={1} unit="段" />,
      children: <AudioResource url={audio} />,
    }] : []),
    ...(subtitles.length > 0 ? [{
      key: 'subtitles',
      label: <ResourceLabel icon={<FileTextOutlined />} label="字幕文本" count={subtitles.length} unit="条" />,
      children: <SubtitleList subtitles={subtitles} />,
    }] : []),
    {
      key: 'raw-response',
      label: <ResourceLabel icon={<CodeOutlined />} label="原始响应 JSON" />,
      children: <RawResponse response={response} />,
    },
  ];

  return (
    <article className="media-result">
      <div className="media-layout">
        <div className="media-stage-col">
          <div className="media-preview" aria-label="媒体预览">
            {currentVideo ? (
              <video
                key={currentVideo}
                controls
                preload="metadata"
                poster={cover ?? undefined}
                src={currentVideo}
                onError={() => setPreviewFailed(true)}
                onLoadedMetadata={() => setPreviewFailed(false)}
              >
                你的浏览器不支持视频播放。
              </video>
            ) : previewCover ? (
              <Image src={previewCover} alt="媒体封面" fallback="" />
            ) : (
              <div className="media-preview-empty">
                {audio ? <AudioOutlined /> : <FileImageOutlined />}
                <span>{audio ? '音频资源' : '暂无封面预览'}</span>
              </div>
            )}
            {currentVideo && videos.length > 1 && (
              <span className="media-count-badge">
                <VideoCameraOutlined />
                视频 {activeVideo + 1} / {videos.length}
              </span>
            )}
            {!currentVideo && images.length > 0 && (
              <span className="media-count-badge">
                <PictureOutlined />
                {images.length} 张图文
              </span>
            )}
          </div>

          {videos.length > 1 && (
            <div className="video-switcher" role="tablist" aria-label="切换视频资源">
              {videos.map((url, index) => (
                <button
                  key={url}
                  type="button"
                  role="tab"
                  aria-selected={index === activeVideo}
                  className={`video-tab${index === activeVideo ? ' is-active' : ''}`}
                  onClick={() => {
                    setActiveVideo(index);
                    setPreviewFailed(false);
                  }}
                >
                  视频 {index + 1}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="media-info">
          <div className="media-tags">
            <span className="result-platform-pill">
              {matchedPlatform && (
                <span
                  className="result-platform-icon"
                  style={platformIcon ? undefined : { background: platformFallbackColor(matchedPlatform.id) }}
                  aria-hidden="true"
                >
                  {platformIcon
                    ? <img src={platformIcon} alt="" decoding="async" />
                    : platformFallbackMark(matchedPlatform.name)}
                </span>
              )}
              <span>{data.platform || '未知平台'}</span>
            </span>
            <Tag color="success"><CheckCircleFilled />解析成功</Tag>
            {data.is_preview && (
              <Tag color="warning">
                试听片段{data.full_duration ? `（完整 ${formatSecondsDuration(data.full_duration)}）` : ''}
              </Tag>
            )}
          </div>

          {data.author && (data.author.nickname || avatar) && (
            <div className="author-row">
              <Avatar
                size={38}
                src={avatar ?? undefined}
                icon={<UserOutlined />}
                alt={data.author.nickname || '作者头像'}
              />
              <div className="author-meta">
                <strong>{data.author.nickname || '未提供作者名'}</strong>
                <div className="author-sub">
                  {data.author.guild_name && <span>{data.author.guild_name}</span>}
                  {data.author.author_id && <span>ID: {data.author.author_id}</span>}
                </div>
              </div>
            </div>
          )}

          <h3 className="media-title">{trimmedTitle}</h3>
          {showDesc && <p className="media-desc">{trimmedDesc}</p>}

          {resourceStats.length > 0 && (
            <div className="resource-summary" aria-label="已提取资源概览">
              {resourceStats.map((stat) => (
                <span className="resource-chip" key={stat.key}>
                  <i aria-hidden="true">{stat.icon}</i>
                  <span>{stat.label}</span>
                </span>
              ))}
            </div>
          )}

          <div className="media-actions">
            {currentVideo && (
              <>
                <Button
                  className="media-primary-btn"
                  type="primary"
                  size="large"
                  icon={<VideoCameraOutlined />}
                  href={currentVideo}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看 / 下载无水印视频
                </Button>
                <CopyLinkButton
                  key={currentVideo}
                  url={currentVideo}
                  idleLabel="复制视频链接"
                  copiedLabel="已复制视频链接"
                />
              </>
            )}
            {!currentVideo && audio && (
              <>
                <Button
                  className="media-primary-btn"
                  type="primary"
                  size="large"
                  icon={<AudioOutlined />}
                  href={audio}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  查看 / 下载音频资源
                </Button>
                <CopyLinkButton
                  key={audio}
                  url={audio}
                  idleLabel="复制音频链接"
                  copiedLabel="已复制音频链接"
                />
              </>
            )}
            {cover && (
              <Button
                size="large"
                icon={<FileImageOutlined />}
                href={cover}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 / 下载高清封面
              </Button>
            )}
          </div>
        </div>
      </div>

      {currentVideo && previewFailed && (
        <Alert
          className="media-preview-fail"
          type="warning"
          showIcon
          title="解析已经成功，但浏览器无法直接预览此资源。"
          description="部分平台会限制跨域播放或校验 Referer，请点击上方按钮在新窗口打开或复制链接下载。"
        />
      )}

      <Collapse
        className="resource-collapse"
        defaultActiveKey={defaultActiveKey}
        items={items}
        expandIconPlacement="end"
        destroyOnHidden
      />
    </article>
  );
}

export default MediaResultView;

function ResourceLabel({
  icon,
  label,
  count,
  unit = '个',
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  unit?: string;
}) {
  return (
    <span className="resource-label">
      <span className="resource-label-main">
        <span className="resource-label-icon" aria-hidden="true">{icon}</span>
        <strong>{label}</strong>
      </span>
      {count !== undefined && <em className="resource-label-count">{count} {unit}</em>}
    </span>
  );
}

function ImageGallery({ images }: { images: ReturnType<typeof normalizeImages> }) {
  const previewUrls = images.flatMap((item) => item.imageUrl ? [item.imageUrl] : []);
  return (
    <div className="image-gallery-wrap">
      <Image.PreviewGroup items={previewUrls}>
        <div className="image-grid">
          {images.map((item, index) => {
            const serial = String(index + 1).padStart(2, '0');
            return item.imageUrl ? (
              <div className="image-card" key={`${item.imageUrl}-${index}`}>
                <div className="image-thumb-wrap">
                  <Image src={item.imageUrl} alt={`解析图片 ${index + 1}`} loading="lazy" fallback="" />
                  <span className="image-index-badge">#{serial}</span>
                  {item.livePhotoUrl && <span className="image-live-badge">LIVE</span>}
                </div>
                <div className="image-card-actions">
                  <ExternalResource url={item.imageUrl} label="原图" icon={<ExportOutlined />} />
                  {item.livePhotoUrl && (
                    <ExternalResource url={item.livePhotoUrl} label="实况" icon={<PlayCircleOutlined />} />
                  )}
                </div>
              </div>
            ) : item.livePhotoUrl ? (
              <div className="live-only" key={`${item.livePhotoUrl}-${index}`}>
                <span className="image-index-badge">#{serial}</span>
                <PlayCircleOutlined className="live-only-icon" />
                <span>仅包含实况视频</span>
                <ExternalResource url={item.livePhotoUrl} label="打开实况" icon={<ExportOutlined />} />
              </div>
            ) : null;
          })}
        </div>
      </Image.PreviewGroup>
    </div>
  );
}

function AudioResource({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="audio-resource">
      <div className="audio-player-shell">
        <audio
          controls
          preload="metadata"
          src={url}
          onError={() => setFailed(true)}
          onLoadedMetadata={() => setFailed(false)}
        >
          你的浏览器不支持音频播放。
        </audio>
      </div>
      {failed && <p className="audio-fail-note">浏览器无法直接预览，可通过下方外链打开或下载。</p>}
      <div className="audio-actions">
        <ExternalResource url={url} label="新窗口打开音频" icon={<ExportOutlined />} />
        <CopyLinkButton url={url} idleLabel="复制音频链接" copiedLabel="已复制音频链接" size="small" />
      </div>
    </div>
  );
}

function SubtitleList({ subtitles }: { subtitles: NonNullable<ParseSuccess['data']['subtitles']> }) {
  const { message } = AntApp.useApp();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const visible = expanded ? subtitles : subtitles.slice(0, 8);

  const copyAll = async () => {
    const plainText = subtitles
      .map((item) => {
        const time = formatSubtitleTime(item);
        return time ? `[${time}] ${item.text}` : item.text;
      })
      .join('\n');
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      void message.success('全部字幕已复制');
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      void message.error('无法写入剪贴板');
    }
  };

  return (
    <div className="subtitle-list">
      <div className="subtitle-toolbar">
        <span>共 {subtitles.length} 条字幕记录</span>
        <Button size="small" icon={copied ? <CheckOutlined /> : <CopyOutlined />} onClick={() => void copyAll()}>
          {copied ? '已复制字幕' : '复制全部字幕'}
        </Button>
      </div>
      <ol>
        {visible.map((subtitle, index) => {
          const time = formatSubtitleTime(subtitle);
          return (
            <li key={`${subtitle.start_ms ?? subtitle.start ?? 'x'}-${index}`} className={time ? '' : 'no-time'}>
              {time && <time>{time}</time>}
              <span>{subtitle.text}</span>
            </li>
          );
        })}
      </ol>
      {subtitles.length > 8 && (
        <div className="subtitle-expand-row">
          <Button type="link" onClick={() => setExpanded((value) => !value)}>
            {expanded ? '收起字幕' : `展开全部 ${subtitles.length} 条字幕`}
          </Button>
        </div>
      )}
    </div>
  );
}

function CopyLinkButton({
  url,
  idleLabel,
  copiedLabel,
  size = 'large',
}: {
  url: string;
  idleLabel: string;
  copiedLabel: string;
  size?: 'small' | 'middle' | 'large';
}) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      void message.success(copiedLabel);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      void message.error('无法写入剪贴板');
    }
  };
  return (
    <Button
      size={size}
      className={copied ? 'is-copied-btn' : undefined}
      icon={copied ? <CheckOutlined /> : <CopyOutlined />}
      onClick={() => void copy()}
    >
      {copied ? copiedLabel : idleLabel}
    </Button>
  );
}

function RawResponse({ response }: { response: ParseSuccess }) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const raw = useMemo(() => JSON.stringify(response, null, 2), [response]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      void message.success('JSON 已复制');
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      void message.error('无法写入剪贴板');
    }
  };
  return (
    <div className="technical-details">
      <div className="technical-toolbar">
        <span>JSON Payload</span>
        <Button size="small" icon={copied ? <CheckOutlined /> : <CopyOutlined />} onClick={() => void copy()}>
          {copied ? '已复制' : '复制 JSON'}
        </Button>
      </div>
      <pre>{raw}</pre>
    </div>
  );
}

function ExternalResource({
  url,
  label,
  icon,
}: {
  url: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <a className="external-resource" href={url} target="_blank" rel="noopener noreferrer">
      {icon}
      <span>{label}</span>
    </a>
  );
}
