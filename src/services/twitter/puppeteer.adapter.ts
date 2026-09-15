import puppeteer from 'puppeteer-extra';
import { Browser, Page, HTTPResponse } from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { ITwitterClient, Mention } from './twitter.interface';
import { getAgentConfig } from '../../repo/mongo.repo';
import { config } from '../../config/env.config';
import { withRetry } from '../../utils/retry.util';
import { TIMEOUTS, RETRY } from '../../config/constants';

puppeteer.use(StealthPlugin());

function findTweet(value: any, username: string): Mention | null {
    if (!value || typeof value !== 'object') return null;

    const tweetId = value.rest_id || value.legacy?.id_str;
    const tweetText = value.legacy?.full_text || value.text;
    if (tweetId && tweetText) {
        return {
            id: tweetId,
            text: tweetText,
            username,
            created_at: value.legacy?.created_at || value.created_at || new Date().toISOString()
        };
    }

    for (const child of Object.values(value)) {
        const tweet = findTweet(child, username);
        if (tweet) return tweet;
    }

    return null;
}

function collectTweets(value: any, mentions: Mention[] = []): Mention[] {
    if (!value || typeof value !== 'object') return mentions;

    const tweetId = value.rest_id || value.legacy?.id_str;
    const tweetText = value.legacy?.full_text || value.text;
    if (tweetId && tweetText) {
        mentions.push({
            id: tweetId,
            text: tweetText,
            username: value.core?.user_results?.result?.legacy?.screen_name || 'unknown',
            created_at: value.legacy?.created_at || value.created_at || new Date().toISOString()
        });
    }

    for (const child of Object.values(value)) collectTweets(child, mentions);
    return mentions;
}

function isAfterCursor(tweetId: string, cursor?: string): boolean {
    if (!cursor) return true;
    if (tweetId === cursor) return false;
    try {
        return BigInt(tweetId) > BigInt(cursor);
    } catch {
        return true;
    }
}

function findCreatedTweetId(value: any): string | null {
    if (!value || typeof value !== 'object') return null;

    const tweetId = value.rest_id || value.legacy?.id_str;
    if (tweetId && (value.legacy?.full_text || value.text)) return tweetId;

    for (const child of Object.values(value)) {
        const id = findCreatedTweetId(child);
        if (id) return id;
    }

    return null;
}

function trackCreatedTweet(page: Page) {
    let createdTweetId: string | null = null;
    const responseTasks = new Set<Promise<void>>();
    const listener = (response: HTTPResponse) => {
        if (!/graphql/i.test(response.url()) || !/CreateTweet|TweetCreate/i.test(response.url())) return;
        const task = (async () => {
            try {
                const json = await response.json();
                createdTweetId = findCreatedTweetId(json?.data);
            } catch {
                // Ignore unrelated or non-JSON responses.
            }
        })();
        responseTasks.add(task);
        void task.finally(() => responseTasks.delete(task));
    };
    page.on('response', listener);

    return async () => {
        await Promise.race([Promise.allSettled([...responseTasks]), new Promise(r => setTimeout(r, TIMEOUTS.GRAPHQL_RESPONSE_TIMEOUT))]);
        page.off('response', listener);
        return createdTweetId;
    };
}

export class PuppeteerTwitterAdapter implements ITwitterClient {
    private browser: Browser | null = null;
    private page: Page | null = null;

    private async getPage(): Promise<Page> {
        if (!this.browser || !this.page) {
            this.browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-notifications']
            });
            this.page = await this.browser.newPage();

            const agentConfig = await getAgentConfig();

            await this.page.setCookie(
                { name: 'auth_token', value: agentConfig.twitter_auth_token || '', domain: '.x.com' },
                { name: 'ct0', value: agentConfig.twitter_ct0 || '', domain: '.x.com' }
            );
        }
        return this.page;
    }

    private async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }

    async postTweet(text: string): Promise<string> {
        return await withRetry('Post Tweet', async () => {
            const page = await this.getPage();
            try {
                if (!text?.trim()) throw new Error('Tweet text cannot be empty');
                const getCreatedTweetId = trackCreatedTweet(page);
                await page.goto('https://x.com/compose/tweet', { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));

                await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: TIMEOUTS.SELECTOR_WAIT });
                await page.type('[data-testid="tweetTextarea_0"]', text);
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_SHORT));

                await page.click('[data-testid="tweetButton"]');
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));
                const createdTweetId = await getCreatedTweetId();
                if (!createdTweetId) throw new Error('X did not return a created tweet ID');
                return createdTweetId;
            } finally {
                await this.cleanup();
            }
        }, RETRY.MAX_ATTEMPTS, RETRY.DELAY_MS);
    }

    async repostTweet(tweetId: string): Promise<string> {
        return await withRetry('Repost Tweet', async () => {
            const page = await this.getPage();
            try {
                if (!tweetId?.trim()) throw new Error('Repost target ID cannot be empty');
                await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));
                await page.waitForSelector('[data-testid="retweet"]', { timeout: TIMEOUTS.SELECTOR_WAIT });
                await page.click('[data-testid="retweet"]');
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_SHORT));
                const reposted = await page.evaluate(() => {
                    const items = Array.from(document.querySelectorAll('[role="menuitem"], [data-testid]'));
                    const item = items.find(element => /^(Repost|Retweet)$/i.test((element.textContent || '').trim()));
                    if (!item) return false;
                    (item as HTMLElement).click();
                    return true;
                });
                if (!reposted) throw new Error('Repost option not found');
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_LONG));
                return tweetId;
            } finally {
                await this.cleanup();
            }
        }, RETRY.MAX_ATTEMPTS, RETRY.DELAY_MS);
    }

    async replyTweet(text: string, tweetId: string): Promise<string> {
        return await withRetry('Reply Tweet', async () => {
            const page = await this.getPage();
            try {
                if (!text?.trim()) throw new Error('Reply text cannot be empty');
                if (!tweetId?.trim()) throw new Error('Reply target ID cannot be empty');

                let createdReplyId: string | null = null;
                const responseTasks = new Set<Promise<void>>();
                page.on('response', async response => {
                    if (!/graphql/i.test(response.url()) || !/CreateTweet|TweetCreate/i.test(response.url())) return;
                    const task = (async () => {
                        try {
                            const json = await response.json();
                            createdReplyId = findCreatedTweetId(json?.data);
                        } catch {
                            // Ignore unrelated or non-JSON responses.
                        }
                    })();
                    responseTasks.add(task);
                    await task;
                    responseTasks.delete(task);
                });

                await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION_TIMEOUT });
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));

                await page.waitForSelector('[data-testid="reply"]', { timeout: TIMEOUTS.SELECTOR_WAIT });
                await page.click('[data-testid="reply"]');
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_MEDIUM));

                await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: TIMEOUTS.SELECTOR_WAIT });
                await page.type('[data-testid="tweetTextarea_0"]', text);
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_SHORT));

                await page.click('[data-testid="tweetButton"]');
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));
                await Promise.race([Promise.allSettled([...responseTasks]), new Promise(r => setTimeout(r, TIMEOUTS.GRAPHQL_RESPONSE_TIMEOUT))]);

                if (!createdReplyId) throw new Error('X did not return a created reply ID');
                return createdReplyId;
            } finally {
                await this.cleanup();
            }
        }, RETRY.MAX_ATTEMPTS, RETRY.DELAY_MS);
    }

    async quoteTweet(text: string, tweetId: string): Promise<string> {
        return await withRetry('Quote Tweet', async () => {
            const page = await this.getPage();
            try {
                if (!text?.trim()) throw new Error('Quote text cannot be empty');
                if (!tweetId?.trim()) throw new Error('Quote target ID cannot be empty');
                const getCreatedTweetId = trackCreatedTweet(page);
                await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded' });
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));

                await page.waitForSelector('[data-testid="retweet"]', { timeout: TIMEOUTS.SELECTOR_WAIT });
                await page.click('[data-testid="retweet"]');
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_SHORT));

                await page.evaluate(() => {
                    const spans = Array.from(document.querySelectorAll('span'));
                    const quoteSpan = spans.find(s => s.innerText.includes('Quote'));
                    if (quoteSpan) quoteSpan.click();
                });
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_MEDIUM));

                await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: TIMEOUTS.SELECTOR_WAIT });
                await page.type('[data-testid="tweetTextarea_0"]', text);
                await new Promise(r => setTimeout(r, TIMEOUTS.ACTION_DELAY_SHORT));

                await page.click('[data-testid="tweetButton"]');
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));
                const createdTweetId = await getCreatedTweetId();
                if (!createdTweetId) throw new Error('X did not return a created quote ID');
                return createdTweetId;
            } finally {
                await this.cleanup();
            }
        }, RETRY.MAX_ATTEMPTS, RETRY.DELAY_MS);
    }

    async getMentions(sinceId?: string): Promise<Mention[]> {
        return await withRetry('Fetch Mentions', async () => {
            const page = await this.getPage();
            try {
                let mentions: Mention[] = [];
                const responseTasks = new Set<Promise<void>>();

                page.on('response', async (response: HTTPResponse) => {
                    if (!/graphql/i.test(response.url()) || !/NotificationsTimeline|Mentions/i.test(response.url())) return;
                    const task = (async () => {
                        try {
                            const json = await response.json();
                            mentions.push(...collectTweets(json?.data));
                        } catch (e) {
                            // Ignore unrelated or non-JSON GraphQL responses.
                        }
                    })();
                    responseTasks.add(task);
                    await task;
                    responseTasks.delete(task);
                });

                await page.goto('https://x.com/notifications/mentions', { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION_TIMEOUT });
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD));
                await Promise.race([Promise.allSettled([...responseTasks]), new Promise(r => setTimeout(r, TIMEOUTS.GRAPHQL_RESPONSE_TIMEOUT))]);

                return Array.from(new Map(
                    mentions
                        .filter(mention => isAfterCursor(mention.id, sinceId))
                        .map(mention => [mention.id, mention])
                ).values());
            } finally {
                await this.cleanup();
            }
        }, RETRY.MAX_ATTEMPTS, RETRY.DELAY_MS);
    }

    async getLatestTweet(username: string): Promise<Mention | null> {
        const tweets = await this.getLatestTweets(username, 1);
        return tweets[0] || null;
    }

    async getLatestTweets(username: string, limit = 2): Promise<Mention[]> {
        return await withRetry(`Fetch Latest Tweets @${username}`, async () => {
            const page = await this.getPage();
            try {
                if (!username?.trim()) throw new Error('Username cannot be empty');
                if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Tweet limit must be between 1 and 20');
                let tweets: Mention[] = [];
                const responseTasks = new Set<Promise<void>>();

                page.on('response', (response: HTTPResponse) => {
                    if (/graphql/i.test(response.url())) {
                        const task = (async () => {
                            try {
                                const json = await response.json();
                                tweets.push(...collectTweets(json?.data).map(tweet => ({ ...tweet, username: username.replace('@', '') })));
                            } catch (e) {
                                // Ignore unrelated or non-JSON GraphQL responses.
                            }
                        })();
                        responseTasks.add(task);
                        void task.finally(() => responseTasks.delete(task));
                    }
                });

                await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2', timeout: 45000 });
                await new Promise(r => setTimeout(r, TIMEOUTS.PAGE_LOAD_LONG));
                await Promise.race([Promise.allSettled([...responseTasks]), new Promise(r => setTimeout(r, TIMEOUTS.GRAPHQL_RESPONSE_TIMEOUT))]);

                return Array.from(new Map(tweets.map(tweet => [tweet.id, tweet])).values())
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                    .slice(0, limit);
            } finally {
                await this.cleanup();
            }
        }, RETRY.MAX_ATTEMPTS, RETRY.DELAY_MS);
    }
}
