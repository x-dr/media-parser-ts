import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { array, at, author, extractAssignedJson, parseJson, record, result, stringAt } from './data.js';

class AcfunParser implements PlatformParser {
  public readonly platform = 'acfun' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const html = await this.context.session.getText(this.context.realUrl, { signal: this.context.signal });
    const data = extractAssignedJson(html, 'window.pageInfo');
    let videoUrl: string | null = null;
    const playJson = stringAt(data, 'currentVideoInfo', 'ksPlayJson');
    if (playJson) {
      const play = parseJson(playJson);
      const representation = array(at(play, 'adaptationSet', 0, 'representation'));
      videoUrl = stringAt(representation[0], 'url') || null;
    }
    const user = record(at(data, 'user'));
    return result({
      title: stringAt(data, 'title'),
      videoUrl,
      coverUrl: stringAt(data, 'coverUrl') || null,
      author: author(user.name, user.id, user.headUrl),
    });
  }
}

registerParser('acfun', { factory: (context) => new AcfunParser(context), allowedHosts: [] });
