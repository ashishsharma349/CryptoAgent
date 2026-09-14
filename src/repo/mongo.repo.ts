import { MongoClient } from 'mongodb';
import { config } from '../config/env.config';
import { logger } from '../utils/logger.util';

const client = new MongoClient(config.MONGO_URI);
let db: any;

export async function connectDB() {
    if (!db) {
        await client.connect();
        db = client.db('crypto-bot');
        logger.info('Connected to MongoDB');
    }
    return db;
}

export async function logAction(status: 'pending' | 'approved' | 'rejected' | 'posted' | 'post_failed' | 'compliance_failed', text: string, tickers: string[], type: 'post' | 'reply' | 'quote' = 'post') {
    const database = await connectDB();
    const collection = database.collection('actions_log');
    
    const result = await collection.insertOne({
        account_id: config.ACCOUNT_ID,
        status,
        content_text: text,
        tickers,
        timestamp: new Date().toISOString(),
        type
    });
    
    return result.insertedId.toString();
}

export async function updateActionStatus(id: string, newStatus: 'approved' | 'rejected' | 'posted' | 'post_failed' | 'compliance_failed', tweet_id?: string, error_message?: string) {
    const database = await connectDB();
    const collection = database.collection('actions_log');
    const { ObjectId } = require('mongodb');
    
    const updateDoc: any = { status: newStatus, updated_at: new Date().toISOString() };
    if (tweet_id) updateDoc.tweet_id = tweet_id;
    if (error_message) updateDoc.error_message = error_message;

    await collection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateDoc }
    );
}

export async function getRecentTweets(days: number): Promise<string[]> {
    const database = await connectDB();
    const collection = database.collection('actions_log');
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const recent = await collection.find({
        account_id: config.ACCOUNT_ID,
        status: { $in: ['approved', 'posted'] },
        type: 'post',
        timestamp: { $gte: cutoffDate.toISOString() }
    }).toArray();
    
    return recent.map((r: any) => r.content_text);
}

export async function checkDailyLimit(type: 'post' | 'reply'): Promise<boolean> {
    const database = await connectDB();
    const collection = database.collection('daily_counters');
    const agentConfig = await getAgentConfig();
    
    const dateStr = new Date().toISOString().split('T')[0];
    const doc = await collection.findOne({ account_id: config.ACCOUNT_ID, date: dateStr });
    
    if (!doc) return true; // Under limit
    
    if (type === 'post' && doc.posts_today >= (agentConfig.max_posts_per_day || 6)) return false;
    if (type === 'reply' && doc.replies_today >= (agentConfig.max_replies_per_day || 15)) return false;
    
    return true;
}

export async function incrementDailyCounter(type: 'post' | 'reply') {
    const database = await connectDB();
    const collection = database.collection('daily_counters');
    const dateStr = new Date().toISOString().split('T')[0];
    
    const updateField = type === 'post' ? 'posts_today' : 'replies_today';
    
    await collection.updateOne(
        { account_id: config.ACCOUNT_ID, date: dateStr },
        { $inc: { [updateField]: 1 } },
        { upsert: true }
    );
}

export async function getAgentConfig() {
    const database = await connectDB();
    const collection = database.collection('accounts_config');
    let agentConfig = await collection.findOne({ account_id: config.ACCOUNT_ID });
    
    // Default seed if not exists
    if (!agentConfig) {
        agentConfig = {
            account_id: config.ACCOUNT_ID,
            min_posts_per_day: 3,
            max_posts_per_day: 6,
            max_replies_per_day: 15,
            schedule_start_hour: 9,
            schedule_end_hour: 22,
            auto_post_timeout_minutes: 15,
            active_data_sources: ['coingecko'],
            monitored_accounts: [],
            monitor_interval_hours: 2,
            last_monitor_run: 0,
            updated_at: new Date().toISOString()
        };
        await collection.insertOne(agentConfig);
    }
    return agentConfig;
}

export async function updateAgentConfig(updates: any) {
    const database = await connectDB();
    const collection = database.collection('accounts_config');
    updates.updated_at = new Date().toISOString();
    
    await collection.updateOne(
        { account_id: config.ACCOUNT_ID },
        { "$set": updates },
        { upsert: true }
    );
}
