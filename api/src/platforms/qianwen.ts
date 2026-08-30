import { registerParser } from '../core/parser-registry.js';
import { QianwenSharedParser } from './qianwen-shared.js';

registerParser('qianwen', {
  factory: (context) => new QianwenSharedParser('qianwen', context),
  allowedHosts: [],
});
