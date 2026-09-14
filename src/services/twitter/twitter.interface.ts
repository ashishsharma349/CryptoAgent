export interface Mention {
    id: string;
    text: string;
    username: string;
    created_at: string;
}

export interface ITwitterClient {
    postTweet(text: string): Promise<string>;
    getMentions(sinceId?: string): Promise<Mention[]>;
    quoteTweet(text: string, tweetId: string): Promise<string>;
    replyTweet(text: string, tweetId: string): Promise<string>;
    getLatestTweet(username: string): Promise<Mention | null>;
}
