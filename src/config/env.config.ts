import dotenv from 'dotenv';
dotenv.config();

export const config = {
    MONGO_URI: process.env.MONGO_URI || '',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
    AI_API_URL: process.env.AI_API_URL || 'http://127.0.0.1:20128/v1',
    AI_API_KEY: process.env.AI_API_KEY || '',
    AI_MODEL: process.env.AI_MODEL || 'my-combo',
    ACCOUNT_ID: process.env.ACCOUNT_ID || 'crypto_agent_01',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || 'You are a crypto expert.',
    MEMORY_DAYS: parseInt(process.env.MEMORY_DAYS || '7', 10),

    // Twitter Configuration
    twitter: {
        clientType: process.env.TWITTER_CLIENT_TYPE || 'official', // 'official' or 'unofficial'
        apiKey: process.env.TWITTER_API_KEY || '',
        apiSecret: process.env.TWITTER_API_SECRET || '',
        accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
        accessSecret: process.env.TWITTER_ACCESS_SECRET || '',
        authToken: process.env.TWITTER_AUTH_TOKEN || '',
        ct0: process.env.TWITTER_CT0 || ''
    }
};

const required = [
    'MONGO_URI', 
    'TELEGRAM_BOT_TOKEN', 
    'TELEGRAM_CHAT_ID', 
    'AI_API_KEY'
];

for (const key of required) {
    if (!config[key as keyof typeof config]) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
}
