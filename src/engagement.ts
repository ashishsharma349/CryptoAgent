import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { checkDailyLimit, connectDB, logAction } from './repo/mongo.repo';
import { sendDraftForApproval } from './bot/telegram.bot';
import { config } from './config/env.config';
import { getTwitterClient } from './services/twitter';
import { TweetSchema } from './services/ai.service';
import { withRetry } from './utils/retry.util';
import { validateCompliance } from './utils/compliance.util';

export function startEngagementLoop() {
    cron.schedule('*/15 * * * *', async () => {
        try {
            logger.info('Engagement loop checking for mentions...');
            const canReply = await checkDailyLimit('reply');
            if (!canReply) {
                logger.warn('Daily reply limit reached. Skipping engagement loop.');
                return;
            }

            const db = await connectDB();
            const collection = db.collection('accounts_config');
            let configDoc = await collection.findOne({ account_id: config.ACCOUNT_ID });
            let lastCursor = configDoc?.last_mention_cursor || undefined;

            const client = await getTwitterClient();
            const newMentions = await client.getMentions(lastCursor);
            
            if (newMentions.length === 0) {
                logger.info('No new mentions found.');
                return;
            }

            // Just reply to the first new mention for rate limits, update cursor to it
            const mentionToReply = newMentions[0];
            logger.info(`Generating reply for mention from ${mentionToReply.username}`);

            // DB-FIRST: Save mention to DB before calling AI to prevent data loss
            const mentionsCollection = db.collection('engagement_mentions');
            await mentionsCollection.updateOne(
                { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
                {
                    $set: {
                        account_id: config.ACCOUNT_ID,
                        mention_id: mentionToReply.id,
                        username: mentionToReply.username,
                        text: mentionToReply.text,
                        created_at: mentionToReply.created_at,
                        fetched_at: new Date().toISOString(),
                        processing_status: 'fetched'
                    }
                },
                { upsert: true }
            );

            const prompt = `
${config.SYSTEM_PROMPT}
You received this mention from @${mentionToReply.username}: "${mentionToReply.text}"
Write a short, engaging reply.
Return ONLY valid JSON:
{
  "content_type": "reply",
  "lane": "engagement",
  "text": "your reply here",
  "tickers": []
}`;

            await mentionsCollection.updateOne(
                { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
                { $set: { ai_input: prompt, ai_input_at: new Date().toISOString(), processing_status: 'ai_pending' } }
            );

            const draft = await withRetry('AI Reply Generation', async () => {
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
                await mentionsCollection.updateOne(
                    { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
                    { $set: { processing_status: 'ai_failed', failed_at: new Date().toISOString(), error: 'AI generation or compliance failed' } }
                );
                return;
            }

            await mentionsCollection.updateOne(
                { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
                { $set: { ai_output: draft, ai_output_at: new Date().toISOString(), processing_status: 'draft_ready' } }
            );

            const dbId = await logAction('pending', `REPLY TO @${mentionToReply.username}: ${draft.text}`, draft.tickers, 'reply');

            await sendDraftForApproval(`REPLY TO @${mentionToReply.username}`, draft.text, dbId, 'reply', { tweetId: mentionToReply.id, mentionId: mentionToReply.id });

            await mentionsCollection.updateOne(
                { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
                { $set: { processing_status: 'approval_pending' } }
            );

            // Note: Cursor will be updated by telegram.bot.ts after Twitter confirms successful reply

            logger.info('Engagement loop processed successfully.');
        } catch (error) {
            logger.error(`Engagement loop error (or compliance failed): ${error}`);
            const dbId = await logAction('compliance_failed', 'Reply Generation failed (Compliance/API)', [], 'reply');
            const { bot } = require('./bot/telegram.bot');
            await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `🚨 Auto-generation failed for a Reply (Compliance/API). Log ID: ${dbId}`);
        }
    });
}
