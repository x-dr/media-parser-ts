import type { ParseContext } from './parse-context.js';
import type { MediaResult } from './media-result.js';

export interface PlatformParser {
  readonly platform: ParseContext['platform'];
  parse(context: ParseContext): Promise<MediaResult>;
}

export type ParserFactory = (context: ParseContext) => PlatformParser;
