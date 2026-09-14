import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { connectDB, getAgentConfig } from '../src/repo/mongo.repo';
import { scheduleBackfillPost } from '../src/scheduler';
import { sendDraftForApproval, bot } from '../src/bot/telegram.bot';
import { getTwitterClient } from '../src/services/twitter';
import { config } from '../src/config/env.config';
import { logger } from '../src/utils/logger.util';

import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { connectDB } from '../src/repo/mongo.repo';
import { scheduleBackfillPost } from '../src/scheduler';
import { sendDraftForApproval, bot } from '../src/bot/telegram.bot';
import { getTwitterClient } from '../src/services/twitter';
import { config } from '../src/config/env.config';
import { logger } from '../src/utils/logger.util';

// Mock X API for the Happy Path test to bypass 402 error locally during wiring test
const realGetTwitterClient = getTwitterClient;
jestMockTwitterClient();

function jestMockTwitterClient() {
    const mockClient = {
        postTweet: async () => 'mock_tweet_id_123',
        replyTweet: async () => 'mock_reply_id_123',
        quoteTweet: async () => 'mock_quote_id_123',
        getLatestTweet: async () => null,
        getMentions: async () => []
    };
    // Override the cached client or inject it if possible
    // Wait, getTwitterClient is a function. I'll just override it using require cache or similar.
    // Actually, I can't easily mock an imported module without jest. 
}
