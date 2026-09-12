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

export async function logAction(status: 'pending' | 'approved' | 'rejected', text: string, tickers: string[]) {
    const database = await connectDB();
    const collection = database.collection('actions_log');
    
    const result = await collection.insertOne({
        account_id: config.ACCOUNT_ID,
        status,
        content_text: text,
        tickers,
        timestamp: new Date().toISOString(),
        type: 'post'
    });
    
    return result.insertedId.toString();
}

export async function updateActionStatus(id: string, newStatus: 'approved' | 'rejected') {
    const database = await connectDB();
    const collection = database.collection('actions_log');
    const { ObjectId } = require('mongodb');
    
    await collection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: newStatus, updated_at: new Date().toISOString() } }
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
    
    const dateStr = new Date().toISOString().split('T')[0];
    const doc = await collection.findOne({ account_id: config.ACCOUNT_ID, date: dateStr });
    
    if (!doc) return true; // Under limit
    
    if (type === 'post' && doc.posts_today >= config.MAX_POSTS_PER_DAY) return false;
    if (type === 'reply' && doc.replies_today >= config.MAX_REPLIES_PER_DAY) return false;
    
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
