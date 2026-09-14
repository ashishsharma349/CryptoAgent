import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { config } from './config/env.config';
import { getAgentConfig } from './repo/mongo.repo';
import { connectDB, checkDailyLimit, incrementDailyCounter, getRecentTweets } from './repo/mongo.repo';
import { fetchTrendingCoins } from './services/coingecko.service';
import { generateTweet } from './services/ai.service';
import { sendDraftForApproval } from './bot/telegram.bot';

export function startMasterScheduler() {
    cron.schedule('0 0 * * *', async () => {
        logger.info('Master Scheduler triggered. Planning today\'s posts...');
        await planDailyPosts();
    });
    
    cron.schedule('* * * * *', async () => {
        await executePlannedPosts();
    });
    
    logger.info('Master Scheduler started.');
}

async function planDailyPosts() {
    const agentConfig = await getAgentConfig();
    const minPosts = agentConfig.min_posts_per_day || 3;
    const maxPosts = agentConfig.max_posts_per_day || 6;
    const numPosts = Math.floor(Math.random() * (maxPosts - minPosts + 1)) + minPosts;
    logger.info(`Planning ${numPosts} posts for today.`);
    
    const db = await connectDB();
    const collection = db.collection('planned_posts');
    
    const planned = [];
    const now = new Date();
    
    for (let i = 0; i < numPosts; i++) {
        const postTime = new Date(now);
        const randomHour = Math.floor(Math.random() * (agentConfig.schedule_end_hour - agentConfig.schedule_start_hour + 1)) + agentConfig.schedule_start_hour;
        const randomMinute = Math.floor(Math.random() * 60);
        postTime.setHours(randomHour, randomMinute, 0, 0);
        
        if (postTime > now) {
            planned.push({
                account_id: config.ACCOUNT_ID,
                scheduled_time: postTime.toISOString(),
                executed: false
            });
        }
    }
    
    if (planned.length > 0) {
        planned.sort((a, b) => new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime());
        await collection.insertMany(planned);
        logger.info(`Saved ${planned.length} planned posts to MongoDB.`);
    }
}

export async function runPipeline() {
    try {
        const canPost = await checkDailyLimit('post');
        if (!canPost) {
            logger.warn('Daily post limit reached. Aborting pipeline.');
            return;
        }

        logger.info('Starting CryptoAgent Content Pipeline...');
        
        logger.info('Fetching market data...');
        const trending = await fetchTrendingCoins();
        if (trending.length === 0) {
            logger.error('No trending data found. Aborting.');
            return;
        }

        logger.info('Fetching 7-day memory...');
        const pastTweets = await getRecentTweets(config.MEMORY_DAYS);

        logger.info('Generating tweet via AI...');
        const draft = await generateTweet(trending, pastTweets);
        const { logAction } = require('./repo/mongo.repo');
        
        if (!draft) {
            logger.error('Failed to generate draft (or compliance failed). Aborting.');
            const dbId = await logAction('compliance_failed', 'Generation failed (Compliance or API error)', [], 'post');
            const { bot } = require('./bot/telegram.bot');
            await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `🚨 Auto-generation failed for a scheduled post (Compliance/API). Log ID: ${dbId}. Attempting backfill...`);
            await scheduleBackfillPost();
            return;
        }

        logger.info('Sending to Telegram for approval...');
        const dbId = await logAction('pending', draft.text, draft.tickers, 'post');
        
        const { sendDraftForApproval } = require('./bot/telegram.bot');
        await sendDraftForApproval('', draft.text, dbId, 'post', { trending, pastTweets });
        
        logger.info('Pipeline complete. Sent to Telegram with Auto-Post Timer.');
    } catch (error) {
        logger.error(`Pipeline failed: ${error}`);
    }
}

export async function scheduleBackfillPost() {
    const db = await connectDB();
    const agentConfig = await getAgentConfig();
    
    const dailyCounters = db.collection('daily_counters');
    const dateStr = new Date().toISOString().split('T')[0];
    
    const { withRetry } = require('./utils/retry.util');
    
    // Atomically increment and fetch to avoid read-modify-write race conditions
    // Wrapped in withRetry to handle potential Mongo duplicate-key errors on concurrent first-upserts
    const counterDoc = await withRetry('Backfill Upsert', async () => {
        return await dailyCounters.findOneAndUpdate(
            { 
                account_id: config.ACCOUNT_ID, 
                date: dateStr, 
                $or: [{ backfills_today: { $exists: false } }, { backfills_today: { $lt: 3 } }] 
            },
            { 
                $inc: { backfills_today: 1 }, 
                $setOnInsert: { shortfall_count: 0 } 
            },
            { upsert: true, returnDocument: 'after' }
        );
    }, 2, 500).catch((e: any) => {
        logger.error(`Backfill DB op failed after retries: ${e}`);
        return undefined; // distinct from legitimate null
    });
    
    if (counterDoc === undefined) {
        // Real DB failure - alert, don't log a shortfall
        const { bot } = require('./bot/telegram.bot');
        await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `🚨 Backfill DB operation failed after retries — a slot may be permanently lost. Check logs.`);
        return;
    }
    
    // If it returns null, cap is already hit
    if (!counterDoc) {
        await dailyCounters.updateOne(
            { account_id: config.ACCOUNT_ID, date: dateStr },
            { $inc: { shortfall_count: 1 } },
            { upsert: true }
        );
        logger.warn('Backfill cap reached (3) for today. Logging shortfall.');
        return;
    }
    
    const now = new Date();
    const currentHour = now.getHours();
    
    if (currentHour >= agentConfig.schedule_end_hour) {
        logger.warn('Past schedule_end_hour. Cannot backfill today. Logging shortfall.');
        await dailyCounters.updateOne(
            { account_id: config.ACCOUNT_ID, date: dateStr },
            { $inc: { backfills_today: -1, shortfall_count: 1 } }
        );
        return;
    }
    
    const minHour = Math.max(currentHour, agentConfig.schedule_start_hour);
    const maxHour = agentConfig.schedule_end_hour;
    
    let randomHour = minHour;
    let randomMinute = 0;
    
    if (minHour < maxHour) {
        randomHour = Math.floor(Math.random() * (maxHour - minHour + 1)) + minHour;
        randomMinute = Math.floor(Math.random() * 60);
    } else {
        const currentMin = now.getMinutes();
        if (currentMin >= 55) {
            await dailyCounters.updateOne(
                { account_id: config.ACCOUNT_ID, date: dateStr }, 
                { $inc: { backfills_today: -1, shortfall_count: 1 } }
            );
            return;
        }
        randomMinute = Math.floor(Math.random() * (59 - currentMin + 1)) + currentMin;
    }
    
    const postTime = new Date(now);
    postTime.setHours(randomHour, randomMinute, 0, 0);
    
    if (postTime <= now) {
        postTime.setMinutes(postTime.getMinutes() + 5);
    }
    
    const collection = db.collection('planned_posts');
    await collection.insertOne({
        account_id: config.ACCOUNT_ID,
        scheduled_time: postTime.toISOString(),
        executed: false,
        is_backfill: true
    });
    
    logger.info(`Scheduled backfill post for ${postTime.toISOString()}`);
}

async function executePlannedPosts() {
    const db = await connectDB();
    const collection = db.collection('planned_posts');
    
    const nowISO = new Date().toISOString();
    
    const pendingPost = await collection.findOne({
        account_id: config.ACCOUNT_ID,
        executed: false,
        scheduled_time: { "$lte": nowISO }
    });
    
    if (pendingPost) {
        logger.info(`Time reached for planned post: ${pendingPost.scheduled_time}. Executing...`);
        await collection.updateOne({ _id: pendingPost._id }, { "$set": { executed: true } });
        await runPipeline();
    }
}
