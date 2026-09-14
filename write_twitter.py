import os
import re

# 1. Update env.config.ts
with open("src/config/env.config.ts", "r", encoding="utf-8") as f:
    content = f.read()

new_config = """    ACCOUNT_ID: process.env.ACCOUNT_ID || 'crypto_agent_01',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || 'You are a crypto expert.',
    MEMORY_DAYS: parseInt(process.env.MEMORY_DAYS || '7', 10),

    // Twitter Configuration
    TWITTER_CLIENT_TYPE: process.env.TWITTER_CLIENT_TYPE || 'free', // 'free' or 'official'
    TWITTER_AUTH_TOKEN: process.env.TWITTER_AUTH_TOKEN || '',
    TWITTER_CT0: process.env.TWITTER_CT0 || '',
    TWITTER_API_KEY: process.env.TWITTER_API_KEY || '',
    TWITTER_API_SECRET: process.env.TWITTER_API_SECRET || '',
    TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN || '',
    TWITTER_ACCESS_SECRET: process.env.TWITTER_ACCESS_SECRET || '',
};"""

content = re.sub(r"    ACCOUNT_ID:.*?\};", new_config, content, flags=re.DOTALL)

with open("src/config/env.config.ts", "w", encoding="utf-8") as f:
    f.write(content)

# 2. Create services/twitter directory
os.makedirs("src/services/twitter", exist_ok=True)

# 3. Create Interface
interface_code = """export interface Mention {
    id: string;
    text: string;
    username: string;
    created_at: string;
}

export interface ITwitterClient {
    postTweet(text: string): Promise<string>;
    getMentions(sinceId?: string): Promise<Mention[]>;
    quoteTweet(text: string, tweetId: string): Promise<string>;
}
"""
with open("src/services/twitter/twitter.interface.ts", "w", encoding="utf-8") as f:
    f.write(interface_code)

# 4. Create Official Adapter (Stub)
official_code = """import { ITwitterClient, Mention } from './twitter.interface';
import { logger } from '../../utils/logger.util';

export class OfficialTwitterAdapter implements ITwitterClient {
    constructor() {
        logger.info('Initializing Official Twitter Adapter (Paid API)');
        // Initialize twitter-api-v2 here in the future
    }

    async postTweet(text: string): Promise<string> {
        throw new Error('Official API not yet implemented. Set TWITTER_CLIENT_TYPE=free in .env');
    }

    async getMentions(sinceId?: string): Promise<Mention[]> {
        throw new Error('Official API not yet implemented. Set TWITTER_CLIENT_TYPE=free in .env');
    }

    async quoteTweet(text: string, tweetId: string): Promise<string> {
        throw new Error('Official API not yet implemented. Set TWITTER_CLIENT_TYPE=free in .env');
    }
}
"""
with open("src/services/twitter/official.adapter.ts", "w", encoding="utf-8") as f:
    f.write(official_code)

