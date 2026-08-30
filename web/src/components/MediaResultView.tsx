import { useMemo, useState } from 'react';
import { Alert, Avatar, Button, Collapse, Image, Tag } from 'antd';
import {
  AudioOutlined,
  CheckCircleFilled,
  CodeOutlined,
  CopyOutlined,
  FileImageOutlined,
  LinkOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  UserOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { CollapseProps } from 'antd';
import type { ParseSuccess } from '../types';
import {
  formatSubtitleTime,
  normalizeImages,
  safeHttpUrl,
  videoUrls,
} from '../lib/media';

interface MediaResultViewProps {
  response: ParseSuccess;
}

export function MediaResultView({ response }: MediaResultViewProps) {
  const { data } = response;
  const videos = useMemo(() => videoUrls(data), [data]);
  const images = useMemo(() => normalizeImages(data), [data]);
  const audio = safeHttpUrl(data.audio_url);
  const cover = safeHttpUrl(data.cover_url);
  const avatar = safeHttpUrl(data.author?.avatar);
  const [activeVideo, setActiveVideo] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  const currentVideo = videos[activeVideo] ?? null;

  const items: CollapseProps['items'] = [
    ...(images.length > 0 ? [{
      key: 'images',
      label: <ResourceLabel icon={<PictureOutlined />} label="图片" count={images.length} />,
      children: <ImageGallery images={images} />,
    }] : []),
    ...(audio ? [{
      key: 'audio',
      label: <ResourceLabel icon={<AudioOutlined />} label="音频" count={1} />,
      children: <AudioResource url={audio} />,
    }] : []),
    ...((data.subtitles?.length ?? 0) > 0 ? [{
      key: 'subtitles',
      label: <ResourceLabel icon={<CodeOutlined />} label="字幕" count={data.subtitles?.length ?? 0} />,
      children: <SubtitleList subtitles={data.subtitles ?? []} />,
    }] : []),
    {
      key: 'technical',
      label: <ResourceLabel icon={<CodeOutlined />} label="技术详情" />,
      children: <TechnicalDetails response={response} />,
    },
  ];

  return (
    <article className="media-result">
      <div className="media-layout">
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
          ) : cover ? (
            <Image src={cover} alt="媒体封面" fallback="" />
          ) : (
            <div className="media-preview-empty"><FileImageOutlined /></div>
          )}
          {!currentVideo && images.length > 0 && (
            <span className="media-count-badge"><PictureOutlined />{images.length} 张图文</span>
          )}
        </div>
        <div className="media-info">
          <div className="media-tags">
            <Tag color="purple">{data.platform || '未知平台'}</Tag>
            <Tag color="success"><CheckCircleFilled />解析成功</Tag>
          </div>
          {data.author && (data.author.nickname || avatar) && (
            <div className="author-row">
              <Avatar size={36} src={avatar ?? undefined} icon={<UserOutlined />} alt={data.author.nickname || '作者头像'} />
              <div>
                <strong>{data.author.nickname || '未提供作者名'}</strong>
                {data.author.author_id && <span>ID: {data.author.author_id}</span>}
              </div>
            </div>
          )}
          <h3>{data.title?.trim() || '未提供标题'}</h3>
          <div className="media-actions">
            {currentVideo && (
              <Button
                type="primary"
                size="large"
                icon={<VideoCameraOutlined />}
                href={currentVideo}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看 / 下载无水印视频
              </Button>
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
        />
      )}
      {videos.length > 1 && (
        <div className="video-switcher" aria-label="切换视频资源">
          {videos.map((url, index) => (
            <Button
              key={url}
              size="small"
              type={index === activeVideo ? 'primary' : 'default'}
              onClick={() => {
                setActiveVideo(index);
                setPreviewFailed(false);
              }}
            >
              视频 {index + 1}
            </Button>
          ))}
        </div>
      )}

      <Collapse
        className="resource-collapse"
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
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <span className="resource-label">
      <span>{icon}<strong>{label}</strong></span>
      {count !== undefined && <em>{count} 个</em>}
    </span>
  );
}

function ImageGallery({ images }: { images: ReturnType<typeof normalizeImages> }) {
  const previewUrls = images.flatMap((item) => item.imageUrl ? [item.imageUrl] : []);
  return (
    <div>
      {previewUrls.length > 0 && (
        <Image.PreviewGroup items={previewUrls}>
          <div className="image-grid">
            {images.map((item, index) => item.imageUrl ? (
              <div className="image-card" key={`${item.imageUrl}-${index}`}>
                <Image src={item.imageUrl} alt={`解析图片 ${index + 1}`} loading="lazy" fallback="" />
                <ExternalResource url={item.imageUrl} label="打开原图" compact />
                {item.livePhotoUrl && <ExternalResource url={item.livePhotoUrl} label="打开实况视频" compact />}
              </div>
            ) : item.livePhotoUrl ? (
              <div className="live-only" key={`${item.livePhotoUrl}-${index}`}>
                <FileImageOutlined />
                <span>第 {index + 1} 项仅包含实况视频</span>
                <ExternalResource url={item.livePhotoUrl} label="打开实况视频" compact />
              </div>
            ) : null)}
          </div>
        </Image.PreviewGroup>
      )}
    </div>
  );
}

function AudioResource({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="audio-resource">
      <audio controls preload="metadata" src={url} onError={() => setFailed(true)} onLoadedMetadata={() => setFailed(false)}>
        你的浏览器不支持音频播放。
      </audio>
      {failed && <p>浏览器无法直接预览，可通过下面的资源链接检查。</p>}
      <ExternalResource url={url} label="打开音频资源" compact />
    </div>
  );
}

function SubtitleList({ subtitles }: { subtitles: NonNullable<ParseSuccess['data']['subtitles']> }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? subtitles : subtitles.slice(0, 8);
  return (
    <div className="subtitle-list">
      <ol>
        {visible.map((subtitle, index) => (
          <li key={`${subtitle.start_ms ?? 'x'}-${index}`}>
            {formatSubtitleTime(subtitle) && <time>{formatSubtitleTime(subtitle)}</time>}
            <span>{subtitle.text}</span>
          </li>
        ))}
      </ol>
      {subtitles.length > 8 && (
        <Button type="link" onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起字幕' : `展开全部 ${subtitles.length} 条字幕`}
        </Button>
      )}
    </div>
  );
}

function TechnicalDetails({ response }: { response: ParseSuccess }) {
  const [copied, setCopied] = useState(false);
  const raw = JSON.stringify(response, null, 2);
  const copy = async () => {
    await navigator.clipboard.writeText(raw);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="technical-details">
      <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>
        {copied ? '已复制' : '复制 JSON'}
      </Button>
      <pre>{raw}</pre>
    </div>
  );
}

function ExternalResource({ url, label, compact = false }: { url: string; label: string; compact?: boolean }) {
  return (
    <a className={`external-resource${compact ? ' is-compact' : ''}`} href={url} target="_blank" rel="noopener noreferrer">
      {compact ? <LinkOutlined /> : <PlayCircleOutlined />}
      <span>{label}</span>
      <LinkOutlined />
    </a>
  );
}
