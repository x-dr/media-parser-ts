import { registerParser } from '../core/parser-registry.js';
import { DouyinSharedParser } from './douyin-shared.js';

registerParser('douyin', {
  factory: (context) => new DouyinSharedParser('douyin', context),
  allowedHosts: [
    'ttwid.bytedance.com',
    'api5-normal-c-hl.amemv.com',
    'aweme.snssdk.com',
    '*.amemv.com',
    '*.snssdk.com',
    '*.douyinpic.com',
    '*.douyinstatic.com',
    '*.douyinvod.com',
    '*.byteimg.com',
    '*.zjcdn.com',
  ],
});
