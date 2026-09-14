import { TwitterApi } from 'twitter-api-v2';
import dotenv from 'dotenv';
dotenv.config();

async function testTweet() {
    const client = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY!,
        appSecret: process.env.TWITTER_API_SECRET!,
        accessToken: process.env.TWITTER_ACCESS_TOKEN!,
        accessSecret: process.env.TWITTER_ACCESS_SECRET!,
    });

    const rwClient = client.readWrite;
    console.log('Posting test tweet...');
    const result = await rwClient.v2.tweet('Testing my bot setup. Please ignore.');
    console.log('Tweet posted! ID:', result.data.id);
    console.log('Done!');
}

testTweet().catch(e => {
    console.error('Failed:', e.data || e.message || e);
    process.exit(1);
});
