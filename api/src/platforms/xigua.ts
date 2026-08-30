import { registerParser } from '../core/parser-registry.js';
import { DouyinSharedParser } from './douyin-shared.js';

registerParser('xigua', {
  factory: (context) => new DouyinSharedParser('xigua', context),
  allowedHosts: ['www.douyin.com', 'ttwid.bytedance.com'],
});
