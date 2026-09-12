import cron from 'node-cron';
import { logger } from './utils/logger.util';
import { checkDailyLimit, incrementDailyCounter, connectDB } from './repo/mongo.repo';
import { sendDraftForApproval } from './bot/telegram.bot';
import { config } from './config/env.config';

const MOCK_MENTIONS = [
    { id: '101', text: '@CryptoAgent what do you think about $SOL right now?', user: '@degen_danny' },
    { id: '102', text: '@CryptoAgent is the bull market over??', user: '@panic_seller' }
];

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
            let lastCursor = configDoc?.last_mention_cursor || '100';

            const newMentions = MOCK_MENTIONS.filter(m => parseInt(m.id) > parseInt(lastCursor));
            if (newMentions.length === 0) {
                logger.info('No new mentions found.');
                return;
            }

            const mentionToReply = newMentions[0];
            logger.info(`Generating reply for mention from ${mentionToReply.user}`);

            const prompt = `
${config.SYSTEM_PROMPT}
You received this mention from ${mentionToReply.user}: "${mentionToReply.text}"
Write a short, engaging reply. 
Return ONLY valid JSON:
{
  "content_type": "reply",
  "lane": "engagement",
  "text": "your reply here",
  "tickers": []
}`;

            const { withRetry } = require('./utils/retry.util');
            const { TweetSchema } = require('./services/ai.service');

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
                return TweetSchema.parse(JSON.parse(content));
            }, 3, 2000);

            if (!draft) return;

            const { logAction } = require('./repo/mongo.repo');
            const dbId = await logAction('pending', `REPLY TO ${mentionToReply.user}: ${draft.text}`, draft.tickers);
            
            await sendDraftForApproval(`REPLY TO ${mentionToReply.user}:\n\n${draft.text}`, dbId);
            await incrementDailyCounter('reply');
            
            await collection.updateOne(
                { account_id: config.ACCOUNT_ID },
                { "$set": { last_mention_cursor: mentionToReply.id } },
                { upsert: true }
            );
            
            logger.info('Engagement loop processed successfully.');
        } catch (error) {
            logger.error(`Engagement loop error: ${error}`);
        }
    });
}
