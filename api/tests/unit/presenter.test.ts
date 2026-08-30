import { describe, expect, it } from 'vitest';
import { presentSuccess } from '../../src/api/presenter.js';

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
});
