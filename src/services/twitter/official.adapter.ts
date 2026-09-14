import { ITwitterClient, Mention } from './twitter.interface';
import { logger } from '../../utils/logger.util';
import { TwitterApi } from 'twitter-api-v2';
import { config } from '../../config/env.config';
import { withRetry } from '../../utils/retry.util';

export class OfficialTwitterAdapter implements ITwitterClient {
    private client: TwitterApi;

    private validateText(text: string) {
        if (!text?.trim()) throw new Error('Tweet text cannot be empty');
    }

    private validateTweetId(tweetId: string) {
        if (!tweetId?.trim()) throw new Error('Tweet ID cannot be empty');
    }

    constructor() {
        logger.info('Initializing Official Twitter Adapter (Paid API)');
        this.client = new TwitterApi({
            appKey: config.twitter.apiKey,
            appSecret: config.twitter.apiSecret,
            accessToken: config.twitter.accessToken,
            accessSecret: config.twitter.accessSecret,
        });
    }

    async postTweet(text: string): Promise<string> {
        try {
            this.validateText(text);
            return await withRetry('Official post tweet', async () => {
                logger.info(`[OfficialTwitterAdapter] Posting tweet: ${text.substring(0, 50)}...`);
                const result = await this.client.readWrite.v2.tweet(text);
                if (!result.data?.id) throw new Error('Official API returned no tweet ID');
                logger.info(`[OfficialTwitterAdapter] Tweet posted successfully! ID: ${result.data.id}`);
                return result.data.id;
            }, 3, 2000);
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to post tweet: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async repostTweet(tweetId: string): Promise<string> {
        try {
            this.validateTweetId(tweetId);
            return await withRetry('Official repost tweet', async () => {
                const me = await this.client.v2.me();
                const result = await this.client.readWrite.v2.retweet(me.data.id, tweetId);
                if (!result.data?.retweeted) throw new Error('Official API did not confirm repost');
                logger.info(`[OfficialTwitterAdapter] Reposted tweet successfully! Source ID: ${tweetId}`);
                return tweetId;
            }, 3, 2000);
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to repost: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async replyTweet(text: string, tweetId: string): Promise<string> {
        try {
            this.validateText(text);
            this.validateTweetId(tweetId);
            return await withRetry('Official reply tweet', async () => {
                logger.info(`[OfficialTwitterAdapter] Replying to tweet ${tweetId}: ${text.substring(0, 50)}...`);
                const result = await this.client.readWrite.v2.reply(text, tweetId);
                if (!result.data?.id) throw new Error('Official API returned no reply ID');
                logger.info(`[OfficialTwitterAdapter] Reply posted successfully! ID: ${result.data.id}`);
                return result.data.id;
            }, 3, 2000);
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to reply: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async quoteTweet(text: string, tweetId: string): Promise<string> {
        try {
            this.validateText(text);
            this.validateTweetId(tweetId);
            return await withRetry('Official quote tweet', async () => {
                logger.info(`[OfficialTwitterAdapter] Quoting tweet ${tweetId}: ${text.substring(0, 50)}...`);
                const result = await this.client.readWrite.v2.quote(text, tweetId);
                if (!result.data?.id) throw new Error('Official API returned no quote ID');
                logger.info(`[OfficialTwitterAdapter] Quote posted successfully! ID: ${result.data.id}`);
                return result.data.id;
            }, 3, 2000);
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to quote tweet: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async getMentions(sinceId?: string): Promise<Mention[]> {
        try {
            logger.info(`[OfficialTwitterAdapter] Fetching mentions (sinceId: ${sinceId || 'none'})...`);
            return await withRetry('Official fetch mentions', async () => {
                const me = await this.client.v2.me();
                const options: any = {
                    'tweet.fields': ['created_at', 'author_id'],
                    expansions: ['author_id'],
                    max_results: 20
                };
                if (sinceId) options.since_id = sinceId;
                const mentionsResponse = await this.client.v2.userMentionTimeline(me.data.id, options);
                const mentions: Mention[] = [];
                for (const tweet of mentionsResponse.tweets || []) {
                    if (!tweet.id || !tweet.text?.trim()) continue;
                    const author = mentionsResponse.includes?.users?.find(u => u.id === tweet.author_id);
                    mentions.push({
                        id: tweet.id,
                        text: tweet.text.trim(),
                        username: author ? author.username : 'unknown',
                        created_at: tweet.created_at || new Date().toISOString()
                    });
                }
                logger.info(`[OfficialTwitterAdapter] Fetched ${mentions.length} mentions.`);
                return mentions;
            }, 3, 2000);
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to fetch mentions: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async getLatestTweet(username: string): Promise<Mention | null> {
        const tweets = await this.getLatestTweets(username, 1);
        return tweets[0] || null;
    }

    async getLatestTweets(username: string, limit = 2): Promise<Mention[]> {
        try {
            const cleanUser = username.replace('@', '');
            if (!cleanUser) throw new Error('Username cannot be empty');
            if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Tweet limit must be between 1 and 20');
            return await withRetry(`Official fetch latest @${cleanUser}`, async () => {
                const user = await this.client.v2.userByUsername(cleanUser);
                if (!user.data) return [];
                const timeline = await this.client.v2.userTimeline(user.data.id, {
                    max_results: Math.max(5, limit),
                    'tweet.fields': ['created_at'],
                    exclude: ['retweets', 'replies']
                });
                return (timeline.tweets || []).slice(0, limit).flatMap(tweet => {
                    if (!tweet?.id || !tweet.text?.trim()) return [];
                    return [{ id: tweet.id, text: tweet.text.trim(), username: cleanUser, created_at: tweet.created_at || new Date().toISOString() }];
                });
            }, 3, 2000);
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to get latest tweet for ${username}: ${error?.data?.detail || error.message || error}`);
            return [];
        }
    }
}
