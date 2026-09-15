import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { connectDB, getAgentConfig, updateAgentConfig, logAction } from './repo/mongo.repo';
import { sendDraftForApproval } from './bot/telegram.bot';
import { config } from './config/env.config';
import { TweetSchema, generateTweet } from './services/ai.service';
import { withRetry } from './utils/retry.util';
import { validateCompliance } from './utils/compliance.util';
import { getTwitterClient } from './services/twitter';

export function startTweetMonitoring() {
    cron.schedule('*/10 * * * *', async () => {
        await checkMonitoredAccounts();
    });
}

export async function checkMonitoredAccounts(overrideDate?: Date) {
    try {
        const agentConfig = await getAgentConfig();
        const intervalMs = agentConfig.monitor_interval_hours * 60 * 60 * 1000;
        
        const now = overrideDate ? overrideDate.getTime() : Date.now();
        const lastRunTime = agentConfig.last_monitor_run || 0;
        
        // Use 0 as start time for simulation to force it, or just let simulation ignore interval checks.
        // Actually for simulation we will bypass the intervalMs check or force the lastRunTime back.
        if (now - lastRunTime < intervalMs) {
            return; // Not time yet
        }
        
        const accounts = agentConfig.monitored_accounts;
        if (!accounts || accounts.length === 0) {
            return;
        }
        
        logger.info(`[MONITORING] Checking monitored accounts for Quote Tweets: ${accounts.join(', ')}`);
        
        const { evaluateTweetRelevance } = require('./services/ai.service');
        let consecutiveEvalFailures = agentConfig.consecutive_eval_failures || 0;

        const client = await getTwitterClient();
        const database = await connectDB();
        const monitoredTweets = database.collection('monitored_tweets');
        for (const targetUser of accounts) {
            try {
                const latestTweets = await client.getLatestTweets(targetUser, 2);
                for (const latestTweet of latestTweets) {
                    if (!latestTweet.id || !latestTweet.text?.trim()) continue;
                    const existing = await monitoredTweets.findOne({ account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id });
                    if (['ai_pending', 'draft_ready', 'approval_pending', 'reposted', 'rejected', 'skipped_irrelevant'].includes(existing?.processing_status)) {
                        logger.info(`[MONITORING] Skipping already processed tweet ${latestTweet.id}`);
                        continue;
                    }
                    const tweetText = latestTweet.text.trim();

                    const evalResult = await evaluateTweetRelevance(tweetText);
                    if (evalResult.error) {
                        consecutiveEvalFailures++;
                        await updateAgentConfig({ consecutive_eval_failures: consecutiveEvalFailures });
                        if (consecutiveEvalFailures >= 3) {
                            const { sendAlert } = require('./bot/telegram.bot');
                            await sendAlert(`\u26A0\uFE0F Monitoring Eval Alert: Relevance check failed ${consecutiveEvalFailures} times in a row. Defaulting to Assume-Relevant.`);
                        }
                    } else {
                        if (consecutiveEvalFailures > 0) {
                            consecutiveEvalFailures = 0;
                            await updateAgentConfig({ consecutive_eval_failures: 0 });
                        }
                    }

                    if (!evalResult.relevant) {
                        logger.info(`[MONITORING] Skipping tweet ${latestTweet.id} as irrelevant.`);
                        await monitoredTweets.updateOne(
                            { account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id },
                            { $set: { processing_status: 'skipped_irrelevant', fetched_at: new Date().toISOString() } },
                            { upsert: true }
                        );
                        continue;
                    }

                    await monitoredTweets.updateOne(
                        { account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id },
                        { $set: { account_id: config.ACCOUNT_ID, source_account: targetUser, tweet_id: latestTweet.id, text: tweetText, created_at: latestTweet.created_at, fetched_at: new Date().toISOString(), ai_input_verified: true, processing_status: 'fetched' } },
                        { upsert: true }
                    );
                    logger.info(`[MONITORING] Found new tweet from ${targetUser}: ${latestTweet.id}`);

                    const prompt = `${config.SYSTEM_PROMPT}
You are monitoring Twitter. The user ${targetUser} just tweeted: "${tweetText}"
Write a Quote Tweet (QT) adding your insightful perspective.
Return ONLY valid JSON:
{
  "content_type": "quote_tweet",
  "lane": "monitoring",
  "text": "your QT text here",
  "tickers": []
}`;

                    await monitoredTweets.updateOne({ account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id }, { $set: { ai_input: prompt, ai_input_at: new Date().toISOString(), processing_status: 'ai_pending' } });

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

            if (!draft) {
                await monitoredTweets.updateOne(
                    { account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id },
                    { $set: { processing_status: 'failed', processing_error: 'AI returned no draft', failed_at: new Date().toISOString() } }
                );
                continue;
            }

            await monitoredTweets.updateOne(
                { account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id },
                {
                    $set: {
                        ai_output: draft,
                        ai_output_at: new Date().toISOString(),
                        processing_status: 'draft_ready'
                    }
                }
            );

            const dbId = await logAction('pending', `[QT of ${targetUser}]: ${draft.text}`, draft.tickers, 'quote');
            
            // Note: We need to pass the target tweet id to telegram.bot so it can QT it
            await sendDraftForApproval(`[Quote Tweet of ${targetUser}]`, draft.text, dbId, 'quote', { tweetId: latestTweet.id });
                    await monitoredTweets.updateOne({ account_id: config.ACCOUNT_ID, tweet_id: latestTweet.id }, { $set: { processing_status: 'approval_pending' } });
                }
            } catch (error) {
                logger.error(`[MONITORING] Account ${targetUser} failed: ${error}`);
            }
        }
        await updateAgentConfig({ last_monitor_run: now });
    } catch (error) {
        logger.error(`[MONITORING] Top level error: ${error}`);
    }
}

export async function checkMentions(overrideDate?: Date) {
    try {
        const agentConfig = await getAgentConfig();
        const client = await getTwitterClient();
        
        logger.info(`[MONITORING] Checking for new Mentions...`);
        const mentions = await client.getMentions(agentConfig.last_mention_cursor);
        
        if (mentions.length > 0) {
            logger.info(`[MONITORING] Found ${mentions.length} new mentions! Generating replies...`);
            // Sort by oldest first
            mentions.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            
            for (const mention of mentions) {
                const draft = await generateTweet([], [], `Reply to user @${mention.username} who mentioned you saying: "${mention.text}"`);
                if (draft) {
                    const dbId = await logAction('pending', draft.text, [], 'reply');
                    const { sendDraftForApproval } = require('./bot/telegram.bot');
                    await sendDraftForApproval(`[Reply to @${mention.username}]`, draft.text, dbId, 'reply', { tweetId: mention.id });
                }
            }
            
            await updateAgentConfig({ last_mention_cursor: mentions[mentions.length - 1].id });
        } else {
            logger.info(`[MONITORING] No new mentions found.`);
        }
    } catch (error) {
        logger.error(`[MONITORING] Mention check failed: ${error}`);
    }
}
