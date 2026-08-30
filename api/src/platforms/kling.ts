import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { at, author, result, stringAt } from './data.js';

class KlingParser implements PlatformParser {
  public readonly platform = 'kling' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const creativeId = this.context.realUrl.searchParams.get('creative_id') ??
      this.context.realUrl.searchParams.get('work_id');
    if (!creativeId) return result({});
    const url = new URL('https://klingai-share.kuaishou.com/app/creatives/query');
    url.searchParams.set('creativeId', creativeId);
    url.searchParams.set('creativeType', this.context.realUrl.searchParams.get('creative_type') ?? 'WORK');
    const payload = await this.context.session.getJson<unknown>(url, {
      headers: { accept: 'application/json, text/plain, */*', 'accept-language': 'zh' },
      signal: this.context.signal,
    });
    if (at(payload, 'status') !== 200 || at(payload, 'result') !== 1) return result({});
    const detail = at(payload, 'data');
    const profile = at(detail, 'userProfile');
    return result({
      title: stringAt(detail, 'introduction') || '可灵AI 作品',
      videoUrl: resourceUrl(at(detail, 'resource')),
      coverUrl: resourceUrl(at(detail, 'cover')) ?? resourceUrl(at(detail, 'firstFrame')),
      author: author(
        at(profile, 'userName'),
        at(profile, 'userId'),
        resourceUrl(at(profile, 'avatar')) ?? '',
      ),
    });
  }
}

function resourceUrl(value: unknown): string | null {
  return stringAt(value, 'resource').replaceAll('\\/', '/') || null;
}

registerParser('kling', { factory: (context) => new KlingParser(context), allowedHosts: [] });
