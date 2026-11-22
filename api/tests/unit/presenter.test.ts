import { describe, expect, it } from 'vitest';
import { presentSuccess } from '../../src/api/presenter.js';
import { emptyMediaResult, hasMedia } from '../../src/core/media-result.js';

describe('legacy presenter', () => {
  it('deduplicates media and only emits video_list for multiple videos', () => {
    const response = presentSuccess('douyin', new URL('https://www.douyin.com/video/123'), {
      title: '作品',
      videoUrl: 'http://cdn.example/main.mp4',
      videoList: [
        'http://cdn.example/other.mp4',
        'http://cdn.example/main.mp4',
        'http://cdn.example/other.mp4',
      ],
      audioUrl: null,
      coverUrl: null,
      author: null,
      imageList: [],
      subtitles: null,
    });
    expect(response.data.video_url).toBe('https://cdn.example/main.mp4');
    expect(response.data.desc).toBeNull();
    expect(response.data.video_list).toEqual([
      'https://cdn.example/main.mp4',
      'https://cdn.example/other.mp4',
    ]);
  });

  it('omits the optional list for a single video', () => {
    const response = presentSuccess('douyin', new URL('https://www.douyin.com/video/123'), {
      title: '', videoUrl: 'https://cdn.example/1.mp4', videoList: [], audioUrl: null,
      coverUrl: null, author: null, imageList: [], subtitles: null,
    });
    expect(response.data).not.toHaveProperty('video_list');
  });

  it('promotes the first video-list item to the legacy primary video', () => {
    const response = presentSuccess('douyin', new URL('https://www.douyin.com/video/123'), {
      title: '', videoUrl: null,
      videoList: ['https://cdn.example/1.mp4', 'https://cdn.example/2.mp4'],
      audioUrl: null, coverUrl: null, author: null, imageList: [], subtitles: null,
    });
    expect(response.data.video_url).toBe('https://cdn.example/1.mp4');
    expect(response.data.video_list).toEqual([
      'https://cdn.example/1.mp4', 'https://cdn.example/2.mp4',
    ]);
  });

  it('falls back title to desc, cover_url to first image, and emits dual subtitle fields', () => {
    const response = presentSuccess('qsmusic', new URL('https://qishui.douyin.com/s/abc?track_id=99'), {
      ...emptyMediaResult(),
      title: '',
      desc: '正文描述文案',
      audioUrl: 'http://cdn.example/song.mp3',
      imageList: [{ url: 'http://cdn.example/first.jpg', livePhotoUrl: 'http://cdn.example/live.mp4' }],
      subtitles: [{ text: '第一句歌词', startMs: 640, endMs: 2120 }],
      isPreview: true,
      fullDuration: 215,
    });
    expect(response.data.title).toBe('正文描述文案');
    expect(response.data.desc).toBe('正文描述文案');
    expect(response.data.cover_url).toBe('https://cdn.example/first.jpg');
    expect(response.data.audio_url).toBe('https://cdn.example/song.mp3');
    expect(response.data.is_preview).toBe(true);
    expect(response.data.full_duration).toBe(215);
    expect(response.data.subtitles).toEqual([
      {
        text: '第一句歌词',
        start: 0.64,
        end: 2.12,
        start_ms: 640,
        end_ms: 2120,
      },
    ]);
  });

  it('treats audio-only results as valid media', () => {
    expect(hasMedia(emptyMediaResult())).toBe(false);
    expect(hasMedia({ ...emptyMediaResult(), audioUrl: 'https://cdn.example/audio.m4a' })).toBe(true);
  });
});
