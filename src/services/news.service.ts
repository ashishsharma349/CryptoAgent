import { XMLParser } from 'fast-xml-parser';
import { logger } from '../utils/logger.util';
import { withRetry } from '../utils/retry.util';

export interface NewsItem {
    source: string;
    title: string;
    link: string;
    published_at: string;
    summary?: string;
}

const RSS_SOURCES: Record<string, string> = {
    coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    cointelegraph: 'https://cointelegraph.com/rss',
    bitcoinmagazine: 'https://bitcoinmagazine.com/.rss/full/'
};

const parser = new XMLParser({ ignoreAttributes: false, processEntities: true });

function normalizeItems(source: string, xml: string): NewsItem[] {
    const parsed = parser.parse(xml);
    const rawItems = parsed?.rss?.channel?.item || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items.flatMap((item: any) => {
        const title = typeof item.title === 'string' ? item.title.trim() : '';
        const link = typeof item.link === 'string' ? item.link.trim() : '';
        if (!title || !link) return [];
        return [{
            source,
            title,
            link,
            published_at: typeof item.pubDate === 'string' ? item.pubDate : new Date().toISOString(),
            summary: typeof item.description === 'string' ? item.description.replace(/<[^>]*>/g, '').trim() : undefined
        }];
    });
}

export async function fetchNewsSources(sourceNames: string[]): Promise<NewsItem[]> {
    const results = await Promise.all(sourceNames
        .filter(source => source !== 'coingecko' && RSS_SOURCES[source])
        .map(async source => {
            try {
                const xml = await withRetry(`RSS fetch ${source}`, async () => {
                    const response = await fetch(RSS_SOURCES[source], { signal: AbortSignal.timeout(15000) });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.text();
                }, 3, 2000);
                return normalizeItems(source, xml).slice(0, 10);
            } catch (error) {
                logger.error(`[RSS] Failed to fetch ${source}: ${error}`);
                return [];
            }
        }));

    return results.flat();
}