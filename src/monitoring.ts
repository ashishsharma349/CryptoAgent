import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { getAgentConfig, updateAgentConfig, logAction } from './repo/mongo.repo';
import { sendDraftForApproval } from './bot/telegram.bot';
import { config } from './config/env.config';
import { TweetSchema } from './services/ai.service';
import { withRetry } from './utils/retry.util';
import { validateCompliance } from './utils/compliance.util';
import { getTwitterClient } from './services/twitter';

export function startTweetMonitoring() {
    cron.schedule('*/10 * * * *', async () => {
        const agentConfig = await getAgentConfig();
        const intervalMs = agentConfig.monitor_interval_hours * 60 * 60 * 1000;
        
        const now = Date.now();
        const lastRunTime = agentConfig.last_monitor_run || 0;
        
        if (now - lastRunTime < intervalMs) {
            return; // Not time yet
        }
        
        const accounts = agentConfig.monitored_accounts;
        if (!accounts || accounts.length === 0) {
            return;
        }
        
        logger.info(`[MONITORING] Checking monitored accounts for Quote Tweets: ${accounts.join(', ')}`);
        
        const targetUser = accounts[Math.floor(Math.random() * accounts.length)];
        const client = getTwitterClient();
        const latestTweet = await client.getLatestTweet(targetUser);

        if (!latestTweet) {
            logger.info(`[MONITORING] No recent tweets found for ${targetUser}`);
            return;
        }

        // Only update lastRunTime if we found a tweet and are generating a draft
        await updateAgentConfig({ last_monitor_run: now });
        
        logger.info(`[MONITORING] Found new interesting tweet from ${targetUser}`);
        
        const prompt = `${config.SYSTEM_PROMPT}
You are monitoring Twitter. The user ${targetUser} just tweeted: "${latestTweet.text}"
Write a Quote Tweet (QT) adding your insightful perspective.
Return ONLY valid JSON:
{
  "content_type": "quote_tweet",
  "lane": "monitoring",
  "text": "your QT text here",
  "tickers": []
}`;

        try {
            const draft = await withRetry('AI QT Generation', async () => {
                const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AI_API_KEY}` },
                    body: JSON.stringify({
                        model: config.AI_MODEL,
                        messages: [{ role: 'user', content: prompt }],
                        response_format: { type: "json_object" },
                        stream: false
                    })
                });

                if (!response.ok) throw new Error(`AI error: ${response.status}`);
                const data = await response.json();
                let content = data.choices[0].message.content;
                const firstBrace = content.indexOf('{');
                const lastBrace = content.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1) content = content.substring(firstBrace, lastBrace + 1);
                
                const parsed = TweetSchema.parse(JSON.parse(content));
                validateCompliance(parsed);
                return parsed;
            }, 3, 2000);

            if (!draft) return;

            const dbId = await logAction('pending', `[QT of ${targetUser}]: ${draft.text}`, draft.tickers, 'quote');
            
            // Note: We need to pass the target tweet id to telegram.bot so it can QT it
            await sendDraftForApproval(`[Quote Tweet of ${targetUser}]`, draft.text, dbId, 'quote', { tweetId: latestTweet.id });
            
        } catch (e) {
            logger.error(`[MONITORING] Loop failed (or compliance failed): ${e}`);
            const dbId = await logAction('compliance_failed', 'QT Generation failed (Compliance/API)', [], 'quote');
            const { bot } = require('./bot/telegram.bot');
            await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `🚨 Auto-generation failed for a QT (Compliance/API). Log ID: ${dbId}`);
        }
    });
}
