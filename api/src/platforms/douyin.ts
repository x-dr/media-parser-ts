import { registerParser } from '../core/parser-registry.js';
import { DouyinSharedParser } from './douyin-shared.js';

registerParser('douyin', {
  factory: (context) => new DouyinSharedParser('douyin', context),
  allowedHosts: ['ttwid.bytedance.com'],
});
