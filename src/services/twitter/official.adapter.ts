import { ITwitterClient, Mention } from './twitter.interface';
import { logger } from '../../utils/logger.util';
import { TwitterApi } from 'twitter-api-v2';
import { config } from '../../config/env.config';

export class OfficialTwitterAdapter implements ITwitterClient {
    private client: TwitterApi;

    constructor() {
        logger.info('Initializing Official Twitter Adapter (Paid API)');
        this.client = new TwitterApi({
            appKey: config.TWITTER_API_KEY,
            appSecret: config.TWITTER_API_SECRET,
            accessToken: config.TWITTER_ACCESS_TOKEN,
            accessSecret: config.TWITTER_ACCESS_SECRET,
        });
    }

    async postTweet(text: string): Promise<string> {
        try {
            logger.info(`[OfficialTwitterAdapter] Posting tweet: ${text.substring(0, 50)}...`);
            const rwClient = this.client.readWrite;
            const result = await rwClient.v2.tweet(text);
            logger.info(`[OfficialTwitterAdapter] Tweet posted successfully! ID: ${result.data.id}`);
            return result.data.id;
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to post tweet: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async replyTweet(text: string, tweetId: string): Promise<string> {
        try {
            logger.info(`[OfficialTwitterAdapter] Replying to tweet ${tweetId}: ${text.substring(0, 50)}...`);
            const rwClient = this.client.readWrite;
            const result = await rwClient.v2.reply(text, tweetId);
            logger.info(`[OfficialTwitterAdapter] Reply posted successfully! ID: ${result.data.id}`);
            return result.data.id;
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to reply: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async quoteTweet(text: string, tweetId: string): Promise<string> {
        try {
            logger.info(`[OfficialTwitterAdapter] Quoting tweet ${tweetId}: ${text.substring(0, 50)}...`);
            const rwClient = this.client.readWrite;
            const result = await rwClient.v2.quote(text, tweetId);
            logger.info(`[OfficialTwitterAdapter] Quote posted successfully! ID: ${result.data.id}`);
            return result.data.id;
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to quote tweet: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async getMentions(sinceId?: string): Promise<Mention[]> {
        try {
            logger.info(`[OfficialTwitterAdapter] Fetching mentions (sinceId: ${sinceId || 'none'})...`);
            // To fetch mentions we first need our own user ID
            const me = await this.client.v2.me();
            
            const options: any = {
                'tweet.fields': ['created_at', 'author_id'],
                expansions: ['author_id'],
                max_results: 20
            };
            if (sinceId) {
                options.since_id = sinceId;
            }

            const mentionsResponse = await this.client.v2.userMentionTimeline(me.data.id, options);
            
            const mentions: Mention[] = [];
            
            for (const tweet of mentionsResponse.tweets) {
                const author = mentionsResponse.includes?.users?.find(u => u.id === tweet.author_id);
                mentions.push({
                    id: tweet.id,
                    text: tweet.text,
                    username: author ? author.username : 'unknown',
                    created_at: tweet.created_at || new Date().toISOString()
                });
            }

            logger.info(`[OfficialTwitterAdapter] Fetched ${mentions.length} mentions.`);
            return mentions;
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to fetch mentions: ${error?.data?.detail || error.message || error}`);
            throw error;
        }
    }

    async getLatestTweet(username: string): Promise<Mention | null> {
        try {
            const cleanUser = username.replace('@', '');
            const user = await this.client.v2.userByUsername(cleanUser);
            if (!user.data) return null;

            const timeline = await this.client.v2.userTimeline(user.data.id, {
                max_results: 5,
                'tweet.fields': ['created_at'],
                exclude: ['retweets', 'replies']
            });

            const tweets = timeline.tweets;
            if (tweets.length === 0) return null;
            
            const tweet = tweets[0];
            return {
                id: tweet.id,
                text: tweet.text,
                username: cleanUser,
                created_at: tweet.created_at || new Date().toISOString()
            };
        } catch (error: any) {
            logger.error(`[OfficialTwitterAdapter] Failed to get latest tweet for ${username}: ${error?.data?.detail || error.message || error}`);
            return null;
        }
    }
}
