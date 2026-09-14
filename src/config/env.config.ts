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
    MEMORY_DAYS: parseInt(process.env.MEMORY_DAYS || '7', 10),

    // Twitter Configuration (Official OAuth 1.0a)
    TWITTER_API_KEY: process.env.TWITTER_API_KEY || '',
    TWITTER_API_SECRET: process.env.TWITTER_API_SECRET || '',
    TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN || '',
    TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET || '',
};

const required = [
    'MONGO_URI', 
    'TELEGRAM_BOT_TOKEN', 
    'TELEGRAM_CHAT_ID', 
    'AI_API_KEY',
    'TWITTER_API_KEY',
    'TWITTER_API_SECRET',
    'TWITTER_ACCESS_TOKEN',
    'TWITTER_ACCESS_SECRET'
];

for (const key of required) {
    if (!config[key as keyof typeof config]) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}
