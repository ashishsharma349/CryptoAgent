import { ITwitterClient } from './twitter.interface';
import { OfficialTwitterAdapter } from './official.adapter';
import { PuppeteerTwitterAdapter } from './puppeteer.adapter';
import { getAgentConfig } from '../../repo/mongo.repo';

let clientInstance: ITwitterClient | null = null;

class SerialTwitterClient implements ITwitterClient {
    private queue = Promise.resolve();

    constructor(private readonly client: ITwitterClient) {}

    private run<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.queue.then(operation, operation);
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }

    postTweet(text: string) { return this.run(() => this.client.postTweet(text)); }
    repostTweet(tweetId: string) { return this.run(() => this.client.repostTweet(tweetId)); }
    getMentions(sinceId?: string) { return this.run(() => this.client.getMentions(sinceId)); }
    quoteTweet(text: string, tweetId: string) { return this.run(() => this.client.quoteTweet(text, tweetId)); }
    replyTweet(text: string, tweetId: string) { return this.run(() => this.client.replyTweet(text, tweetId)); }
    getLatestTweet(username: string) { return this.run(() => this.client.getLatestTweet(username)); }
    getLatestTweets(username: string, limit?: number) { return this.run(() => this.client.getLatestTweets(username, limit)); }
}

export function resetTwitterClient() {
    clientInstance = null;
}

export async function getTwitterClient(): Promise<ITwitterClient> {
    if (clientInstance) return clientInstance;

    const config = await getAgentConfig();

    if (config.twitter_client_type === 'unofficial') {
        console.log('🔄 Using Unofficial (Puppeteer Stealth) Twitter Client');
        clientInstance = new SerialTwitterClient(new PuppeteerTwitterAdapter());
    } else {
        console.log('🔄 Using Official (OAuth 1.0a) Twitter Client');
        clientInstance = new SerialTwitterClient(new OfficialTwitterAdapter());
    }
    
    return clientInstance;
}
