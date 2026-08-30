import type { ParseContext } from '../core/parse-context.js';
import type { PlatformParser } from '../core/parser.js';
import { registerParser } from '../core/parser-registry.js';
import { result } from './data.js';

class XianyuParser implements PlatformParser {
  public readonly platform = 'xianyu' as const;
  public constructor(private readonly context: ParseContext) {}

  public async parse(): Promise<ReturnType<typeof result>> {
    const html = await this.context.session.getText(this.context.realUrl, {
      headers: { referer: 'https://e.tb.cn/' }, signal: this.context.signal,
    });
    const targetValue = /var\s+url\s*=\s*'([^']+)'/u.exec(html)?.[1];
    const targetUrl = targetValue ? new URL(targetValue) : null;
    const itemId = targetUrl?.searchParams.get('id') ?? this.context.realUrl.searchParams.get('id');
    const price = targetUrl?.searchParams.get('price');
    const title = itemId
      ? `闲鱼商品 (商品ID: ${itemId}${price ? `, 标价: ¥${price}` : ''})`
      : '';
    return result({
      title,
      coverUrl: targetUrl?.href ?? null,
      imageList: targetUrl ? [targetUrl.href] : [],
    });
  }
}

registerParser('xianyu', { factory: (context) => new XianyuParser(context), allowedHosts: [] });
