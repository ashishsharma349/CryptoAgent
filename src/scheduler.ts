import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { config } from './config/env.config';
import { getAgentConfig } from './repo/mongo.repo';
import { connectDB, checkDailyLimit, getRecentTweets, startPipelineRun, updatePipelineRun } from './repo/mongo.repo';
import { fetchTrendingCoins } from './services/coingecko.service';
import { fetchNewsSources } from './services/news.service';
import { generateTweet } from './services/ai.service';
import { sendDraftForApproval } from './bot/telegram.bot';

let plannedPostExecutionInProgress = false;

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

function selectLaneForSlot(currentState: any): string {
    const lanes = ['pulse', 'meme', 'opinion', 'education', 'tools'];
    const weights = [40, 30, 10, 10, 10]; // Probabilities out of 100
    
    if (!currentState) currentState = { last_lane: null, last_lane_date: null, consecutive_days_count: 0 };
    
    let availableLanes = [...lanes];
    let availableWeights = [...weights];
    
    if (currentState.consecutive_days_count >= 2 && currentState.last_lane) {
        const idx = availableLanes.indexOf(currentState.last_lane);
        if (idx !== -1) {
            availableLanes.splice(idx, 1);
            availableWeights.splice(idx, 1);
        }
    }
    
    const totalWeight = availableWeights.reduce((a, b) => a + b, 0);
    let randomNum = Math.floor(Math.random() * totalWeight);
    
    let selectedLane = availableLanes[0];
    for (let i = 0; i < availableLanes.length; i++) {
        if (randomNum < availableWeights[i]) {
            selectedLane = availableLanes[i];
            break;
        }
        randomNum -= availableWeights[i];
    }
    
    if (currentState.last_lane === selectedLane) {
        currentState.consecutive_days_count++;
    } else {
        currentState.last_lane = selectedLane;
        currentState.consecutive_days_count = 1;
    }
    
    return selectedLane;
}

export async function planDailyPosts(overrideDate?: Date) {
    const agentConfig = await getAgentConfig();
    const minPosts = parseInt(agentConfig.min_posts_per_day as any) || 3;
    const maxPosts = parseInt(agentConfig.max_posts_per_day as any) || 6;
    const numPosts = Math.floor(Math.random() * (maxPosts - minPosts + 1)) + minPosts;
    logger.info(`Planning ${numPosts} posts for today.`);
    
    const db = await connectDB();
    const collection = db.collection('planned_posts');
    
    const planned = [];
    const scheduledTimes = new Set<string>();
    const now = overrideDate || new Date();
    const planningDate = now.toISOString().slice(0, 10);
    
    const startHour = parseInt(agentConfig.schedule_start_hour as any) || 9;
    const endHour = parseInt(agentConfig.schedule_end_hour as any) || 22;

    let attempts = 0;
    let currentState = agentConfig.rotation_state || { last_lane: null, last_lane_date: null, consecutive_days_count: 0 };
    const { updateAgentConfig } = require('./repo/mongo.repo');

    while (planned.length < numPosts && attempts < numPosts * 20) {
        attempts++;
        const postTime = new Date(now);
        const randomHour = Math.floor(Math.random() * (endHour - startHour + 1)) + startHour;
        const randomMinute = Math.floor(Math.random() * 60);
        postTime.setHours(randomHour, randomMinute, 0, 0);
        const scheduledTime = postTime.toISOString();

        if (postTime > now && !scheduledTimes.has(scheduledTime)) {
            scheduledTimes.add(scheduledTime);
            
            const selectedLane = selectLaneForSlot(currentState);
            currentState.last_lane_date = planningDate;

            planned.push({
                account_id: config.ACCOUNT_ID,
                planning_date: planningDate,
                scheduled_time: scheduledTime,
                lane: selectedLane,
                executed: false
            });
        }
    }

    await updateAgentConfig({ rotation_state: currentState });

    if (planned.length < numPosts) {
        logger.warn(`Only ${planned.length}/${numPosts} unique future post slots could be planned.`);
    }
    
    if (planned.length > 0) {
        planned.sort((a, b) => new Date(a.scheduled_time).getTime() - new Date(b.scheduled_time).getTime());
        await collection.insertMany(planned);
        logger.info(`Saved ${planned.length} planned posts to MongoDB.`);
    }
}

export async function runPipeline(plannedPostId?: string, lane?: string): Promise<boolean> {
    try {
        const canPost = await checkDailyLimit('post');
        if (!canPost) {
            logger.warn('Daily post limit reached. Aborting pipeline.');
            return false;
        }

        logger.info('Starting CryptoAgent Content Pipeline...');
        const pipelineRunId = await startPipelineRun();
        const agentConfig = await getAgentConfig();
        
        logger.info('Fetching market data...');
        const trending = await fetchTrendingCoins();
        const news = await fetchNewsSources(agentConfig.active_data_sources || ['coingecko']);
        await updatePipelineRun(pipelineRunId, {
            source_snapshot: { trending, news },
            source_names: agentConfig.active_data_sources || ['coingecko'],
            source_fetched_at: new Date().toISOString()
        });
        if (trending.length === 0 && news.length === 0) {
            logger.error('No content source data found. Aborting.');
            await updatePipelineRun(pipelineRunId, { status: 'source_failed', error: 'No content source data found' });
            return false;
        }

        logger.info('Fetching 7-day memory...');
        const pastTweets = await getRecentTweets(config.MEMORY_DAYS);
        await updatePipelineRun(pipelineRunId, { memory_snapshot: pastTweets, memory_days: config.MEMORY_DAYS });

        logger.info('Generating tweet via AI...');
        const draft = await generateTweet({ trending, news }, pastTweets, undefined, lane);
        const { logAction } = require('./repo/mongo.repo');
        
        if (!draft) {
            logger.error('Failed to generate draft (or compliance failed). Aborting.');
            if (lane) {
                logger.warn(`[LANE_METRICS] Lane "${lane}" failed AI/compliance generation. Divergence increased.`);
                const { incrementLaneRejection } = require('./repo/mongo.repo');
                await incrementLaneRejection(lane);
            }
            await updatePipelineRun(pipelineRunId, { status: 'ai_failed', error: 'Draft generation or compliance failed' });
            const dbId = await logAction('compliance_failed', 'Generation failed (Compliance or API error)', [], 'post');
            const { bot } = require('./bot/telegram.bot');
            await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `🚨 Auto-generation failed for a scheduled post (Compliance/API). Log ID: ${dbId}. Attempting backfill...`);
            await scheduleBackfillPost();
            return false;
        }

        await updatePipelineRun(pipelineRunId, {
            status: 'draft_ready',
            ai_output: draft,
            ai_completed_at: new Date().toISOString()
        });

        logger.info('Sending to Telegram for approval...');
        const dbId = await logAction('pending', draft.text, draft.tickers, 'post');

        const { sendDraftForApproval } = require('./bot/telegram.bot');
        await sendDraftForApproval('', draft.text, dbId, 'post', { trending, pastTweets, plannedPostId, lane });

        logger.info('Pipeline complete. Sent to Telegram with Auto-Post Timer.');
        return true;
    } catch (error) {
        logger.error(`Pipeline failed: ${error}`);
        return false;
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
    
    let currentState = agentConfig.rotation_state || { last_lane: null, last_lane_date: null, consecutive_days_count: 0 };
    const { updateAgentConfig } = require('./repo/mongo.repo');
    const selectedLane = selectLaneForSlot(currentState);
    currentState.last_lane_date = now.toISOString().slice(0, 10);
    await updateAgentConfig({ rotation_state: currentState });

    const collection = db.collection('planned_posts');
    await collection.insertOne({
        account_id: config.ACCOUNT_ID,
        planning_date: now.toISOString().slice(0, 10),
        scheduled_time: postTime.toISOString(),
        lane: selectedLane,
        executed: false,
        is_backfill: true
    });
    
    logger.info(`Scheduled backfill post for ${postTime.toISOString()}`);
}

export async function executePlannedPosts(overrideDate?: Date) {
    if (plannedPostExecutionInProgress) {
        logger.warn('Skipping scheduler tick because a planned post pipeline is already running.');
        return;
    }

    plannedPostExecutionInProgress = true;
    try {
        const db = await connectDB();
        const collection = db.collection('planned_posts');
        const now = overrideDate || new Date();
        const nowISO = now.toISOString();
        const planningDate = now.toISOString().slice(0, 10);

        await collection.updateMany(
            { account_id: config.ACCOUNT_ID, executed: false, planning_date: { $lt: planningDate } },
            { $set: { executed: true, status: 'expired', expired_at: new Date().toISOString() } }
        );

        const pendingPost = await collection.findOne({
            account_id: config.ACCOUNT_ID,
            planning_date: planningDate,
            executed: false,
            scheduled_time: { "$lte": nowISO }
        });

        if (pendingPost) {
            logger.info(`Time reached for planned post: ${pendingPost.scheduled_time}. Executing...`);
            const pipelineSucceeded = await runPipeline(pendingPost._id.toString(), pendingPost.lane);
            if (!pipelineSucceeded) {
                logger.warn(`Planned post ${pendingPost._id} pipeline failed (AI/compliance error).`);
            }
            // Note: executed:true will be set by telegram.bot.ts after Twitter confirms post
        }
    } finally {
        plannedPostExecutionInProgress = false;
    }
}
