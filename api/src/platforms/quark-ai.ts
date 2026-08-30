import { registerParser } from '../core/parser-registry.js';
import { QianwenSharedParser } from './qianwen-shared.js';

registerParser('quark_ai', {
  factory: (context) => new QianwenSharedParser('quark_ai', context),
  allowedHosts: [],
});
