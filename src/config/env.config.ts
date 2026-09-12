import dotenv from 'dotenv';
dotenv.config();

export const config = {
    MONGO_URI: process.env.MONGO_URI || '',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    AI_API_URL: process.env.AI_API_URL || 'http://127.0.0.1:20128/v1',
    AI_API_KEY: process.env.AI_API_KEY || '',
    AI_MODEL: process.env.AI_MODEL || 'my-combo',
    ACCOUNT_ID: process.env.ACCOUNT_ID || 'crypto_agent_01',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || 'You are a crypto expert.',
    
    // Limits
    MIN_POSTS_PER_DAY: parseInt(process.env.MIN_POSTS_PER_DAY || '3', 10),
    MAX_POSTS_PER_DAY: parseInt(process.env.MAX_POSTS_PER_DAY || '6', 10),
    MAX_REPLIES_PER_DAY: parseInt(process.env.MAX_REPLIES_PER_DAY || '15', 10),
    MEMORY_DAYS: parseInt(process.env.MEMORY_DAYS || '7', 10),
    AUTO_POST_TIMEOUT_MINUTES: parseInt(process.env.AUTO_POST_TIMEOUT_MINUTES || '15', 10),
    
    // Schedule Window (24h format)
    SCHEDULE_START_HOUR: parseInt(process.env.SCHEDULE_START_HOUR || '0', 10),
    SCHEDULE_END_HOUR: parseInt(process.env.SCHEDULE_END_HOUR || '23', 10),
};

const required = ['MONGO_URI', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'AI_API_KEY'];
for (const key of required) {
    if (!config[key as keyof typeof config]) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}
