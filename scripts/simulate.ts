import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import cron from 'node-cron';
import { connectDB, checkDailyLimit, incrementDailyCounter, getRecentTweets } from './repo/mongo.repo';
import { logger } from './utils/logger.util';
import { config } from './config/env.config';
import { fetchTrendingCoins } from './services/coingecko.service';
import { generateTweet, TweetSchema } from './services/ai.service';
import { sendDraftForApproval, bot } from './bot/telegram.bot';
import { withRetry } from './utils/retry.util';

// We now expect AUTO_POST_TIMEOUT_MINUTES and Limits to be passed via CLI/ENV

async function planAcceleratedPosts() {
    const db = await connectDB();
    const collection = db.collection('planned_posts');
    await collection.deleteMany({ account_id: config.ACCOUNT_ID });
    
    logger.info(`[SIMULATION] Planning 3 posts for the next 20 minutes...`);
    const planned = [];
    const now = new Date();
    
    for (let i = 0; i < 3; i++) {
        const postTime = new Date(now);
        // Random minute offset between 1 and 20 minutes from now
        const offset = Math.floor(Math.random() * 20) + 1;
        postTime.setMinutes(postTime.getMinutes() + offset);
        
        planned.push({
            account_id: config.ACCOUNT_ID,
            scheduled_time: postTime.toISOString(),
            executed: false
        });
    }
    
    planned.sort((a, b) => new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime());
    await collection.insertMany(planned);
    
    planned.forEach((p, idx) => {
        logger.info(`[SIMULATION] Post ${idx+1} scheduled at: ${new Date(p.scheduled_time).toLocaleTimeString()}`);
    });
}

export async function runPipeline() {
    try {
        const canPost = await checkDailyLimit('post');
        if (!canPost) {
            logger.warn('[SIMULATION] Daily post limit reached.');
            return;
        }
        logger.info('[SIMULATION] Pipeline: Fetching market data...');
        const trending = await fetchTrendingCoins();
        const pastTweets = await getRecentTweets(config.MEMORY_DAYS);
        logger.info('[SIMULATION] Pipeline: Generating tweet via AI...');
        const draft = await generateTweet(trending, pastTweets);
        if (!draft) return;
        logger.info(`[SIMULATION] Pipeline: Sending to Telegram (${config.AUTO_POST_TIMEOUT_MINUTES}m timer)...`);
        const { logAction } = require('./repo/mongo.repo');
        const dbId = await logAction('pending', draft.text, draft.tickers);
        await sendDraftForApproval(draft.text, dbId);
        await incrementDailyCounter('post');
    } catch (error) {
        logger.error(`[SIMULATION] Pipeline error: ${error}`);
    }
}

async function checkScheduleLoop() {
    const db = await connectDB();
    const collection = db.collection('planned_posts');
    const nowISO = new Date().toISOString();
    
    const pendingPost = await collection.findOne({
        account_id: config.ACCOUNT_ID,
        executed: false,
        scheduled_time: { "$lte": nowISO }
    });
    
    if (pendingPost) {
        logger.info(`[SIMULATION] Triggering planned post: ${pendingPost.scheduled_time}`);
        await collection.updateOne({ _id: pendingPost._id }, { "$set": { executed: true } });
        await runPipeline();
    }
}

const MOCK_MENTIONS = [
    { id: '201', text: '@CryptoAgent What coin will pump next?', user: '@moon_boy' },
    { id: '202', text: '@CryptoAgent Are we in a bear market?', user: '@rekt_trader' }
];

let engagementIndex = 0;

function startAcceleratedEngagement() {
    cron.schedule('*/2 * * * *', async () => {
        if (engagementIndex >= MOCK_MENTIONS.length) {
            logger.info('[SIMULATION] Engagement Loop: No more mock mentions left.');
            return;
        }
        logger.info('[SIMULATION] Engagement Loop Triggered!');
        const mention = MOCK_MENTIONS[engagementIndex++];
        
        const prompt = `
${config.SYSTEM_PROMPT}
You received this mention from ${mention.user}: "${mention.text}"
Write a short, engaging reply. 
Return ONLY valid JSON:
{
  "content_type": "reply",
  "lane": "engagement",
  "text": "your reply here",
  "tickers": []
}`;

        try {
            const draft = await withRetry('AI Reply Generation', async () => {
                const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AI_API_KEY}` },
                    body: JSON.stringify({
                        model: config.AI_MODEL,
                        messages: [{ role: 'user', content: prompt }],
                        response_format: { type: "json_object" },
                        stream: false
                    })
                });
                if (!response.ok) throw new Error(`AI error: ${response.status}`);
                const data = await response.json();
                let content = data.choices[0].message.content;
                const firstBrace = content.indexOf('{');
                const lastBrace = content.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) content = content.substring(firstBrace, lastBrace + 1);
                return TweetSchema.parse(JSON.parse(content));
            }, 3, 2000);

            if (!draft) return;
            const { logAction } = require('./repo/mongo.repo');
            const dbId = await logAction('pending', `REPLY TO ${mention.user}: ${draft.text}`, draft.tickers);
            logger.info(`[SIMULATION] Engagement Loop: Sending reply to Telegram (${config.AUTO_POST_TIMEOUT_MINUTES}m timer)...`);
            await sendDraftForApproval(`REPLY TO ${mention.user}:\n\n${draft.text}`, dbId);
            await incrementDailyCounter('reply');
        } catch (e) {
            logger.error(`[SIMULATION] Engagement loop failed: ${e}`);
        }
    });
}

async function bootSimulation() {
    await connectDB();
    logger.info('==========================================');
    logger.info('[SIMULATION] SIMULATION MODE ACTIVATED');
    
    // Instead of hardcoding 16:10, let's just trigger immediately when run to avoid clock sync issues!
    logger.info('[SIMULATION] TRIGGERING PLANNER FOR 20-MINUTE WINDOW!');
    await planAcceleratedPosts();
    cron.schedule('*/10 * * * * *', checkScheduleLoop);
    startAcceleratedEngagement();
    
    // Let it run for exactly 21 minutes, then exit automatically
    setTimeout(() => {
        logger.info('[SIMULATION] 20-Minute simulated day is OVER. Exiting.');
        process.exit(0);
    }, 21 * 60 * 1000);
}

bootSimulation();
