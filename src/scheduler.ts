import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { config } from './config/env.config';
import { connectDB, checkDailyLimit, incrementDailyCounter, getRecentTweets } from './repo/mongo.repo';
import { fetchTrendingCoins } from './services/coingecko.service';
import { generateTweet } from './services/ai.service';
import { sendDraftForApproval } from './bot/telegram.bot';

export function startMasterScheduler() {
    cron.schedule('0 8 * * *', async () => {
        logger.info('Master Scheduler triggered. Planning today\'s posts...');
        await planDailyPosts();
    });
    
    cron.schedule('* * * * *', async () => {
        await executePlannedPosts();
    });
    
    logger.info('Master Scheduler started.');
}

async function planDailyPosts() {
    const numPosts = Math.floor(Math.random() * (config.MAX_POSTS_PER_DAY - config.MIN_POSTS_PER_DAY + 1)) + config.MIN_POSTS_PER_DAY;
    logger.info(`Planning ${numPosts} posts for today.`);
    
    const db = await connectDB();
    const collection = db.collection('planned_posts');
    
    const planned = [];
    const now = new Date();
    
    for (let i = 0; i < numPosts; i++) {
        const postTime = new Date(now);
        const randomHour = Math.floor(Math.random() * (config.SCHEDULE_END_HOUR - config.SCHEDULE_START_HOUR + 1)) + config.SCHEDULE_START_HOUR;
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
        if (!draft) {
            logger.error('Failed to generate draft. Aborting.');
            return;
        }

        logger.info('Sending to Telegram for approval...');
        const { logAction } = require('./repo/mongo.repo');
        const dbId = await logAction('pending', draft.text, draft.tickers);
        
        await sendDraftForApproval(draft.text, dbId);
        await incrementDailyCounter('post');
        
        logger.info('Pipeline complete. Sent to Telegram with Auto-Post Timer.');
    } catch (error) {
        logger.error(`Pipeline failed: ${error}`);
    }
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
