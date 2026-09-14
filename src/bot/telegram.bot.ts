import { Telegraf, Markup } from 'telegraf';
import https from 'https';
import { config } from '../config/env.config';
import { getAgentConfig, updateActionStatus, incrementDailyCounter } from '../repo/mongo.repo';
import { logger } from '../utils/logger.util';
import { getTwitterClient } from '../services/twitter';

export const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
    telegram: {
        agent: new https.Agent({ family: 4 })
    }
});

const activeTimers = new Map<string, NodeJS.Timeout>();

interface DraftContext {
    type: 'post' | 'reply' | 'quote';
    contextData: any;
    regenerateCount: number;
    rawDraftText: string;
    displayLabel: string;
}
const pendingContexts = new Map<string, DraftContext>();

export async function executeTwitterPost(dbId: string, rawDraftText: string, type: 'post' | 'reply' | 'quote', contextData: any) {
    const client = await getTwitterClient();
    try {
        let tweetId = '';
        if (type === 'post') {
            tweetId = await client.postTweet(rawDraftText);
        } else if (type === 'reply') {
            tweetId = await client.replyTweet(rawDraftText, contextData.tweetId);
        } else if (type === 'quote') {
            tweetId = await client.quoteTweet(rawDraftText, contextData.tweetId);
        }

        await updateActionStatus(dbId, 'posted', tweetId);
        if (type === 'post') await incrementDailyCounter('post');
        if (type === 'reply' || type === 'quote') await incrementDailyCounter('reply');
        
        return { success: true, tweetId };
    } catch (e: any) {
        logger.error(`Twitter post failed for ${dbId}: ${e}`);
        await updateActionStatus(dbId, 'post_failed', undefined, String(e?.data?.detail || e.message || e));
        if (type === 'post') {
            const { scheduleBackfillPost } = require('../scheduler');
            await scheduleBackfillPost();
        }
        return { success: false, error: e };
    }
}

export async function sendDraftForApproval(displayLabel: string, rawDraftText: string, dbId: string, type: 'post' | 'reply' | 'quote', contextData: any, existingMsgId?: number, regenCount = 0) {
    pendingContexts.set(dbId, { type, contextData, regenerateCount: regenCount, rawDraftText, displayLabel });
    
    const text = displayLabel ? `${displayLabel}:\n\n${rawDraftText}` : rawDraftText;

    const buttons = [
        Markup.button.callback('Approve', `approve_${dbId}`),
        Markup.button.callback('Reject', `reject_${dbId}`)
    ];

    if (regenCount < 3) {
        buttons.push(Markup.button.callback(`Regenerate (${3 - regenCount} left)`, `regenerate_${dbId}`));
    }

    const keyboard = Markup.inlineKeyboard(buttons);
    
    let msgId = existingMsgId;

    if (msgId) {
        await bot.telegram.editMessageText(config.TELEGRAM_CHAT_ID, msgId, undefined, `DRAFT TWEET:\n\n${text}`, keyboard);
    } else {
        const msg = await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `DRAFT TWEET:\n\n${text}`, keyboard);
        msgId = msg.message_id;
    }

    // Set auto-approve timer only if we are below max regenerations.
    // As per user requirement: If regenerate hits its cap (3) and disables, leave the auto-approve timer disabled.
    if (regenCount < 3) {
        const agentConfig = await getAgentConfig();
        const timeoutMs = (agentConfig.auto_post_timeout_minutes || 15) * 60 * 1000;
        
        if (activeTimers.has(dbId)) {
            clearTimeout(activeTimers.get(dbId)!);
        }

        const timer = setTimeout(async () => {
            try {
                activeTimers.delete(dbId);
                const ctxData = pendingContexts.get(dbId);
                if (!ctxData) return; // context gone somehow
                
                logger.info(`Timeout reached. Auto-approving draft ${dbId}`);
                
                const result = await executeTwitterPost(dbId, text, type, contextData);
                
                if (result.success) {
                    await bot.telegram.editMessageText(config.TELEGRAM_CHAT_ID, msgId!, undefined, `[AUTO-APPROVED & POSTED]\n\n${text}\n\nID: ${result.tweetId}`);
                } else {
                    await bot.telegram.editMessageText(config.TELEGRAM_CHAT_ID, msgId!, undefined, `[FAILED TO POST (Timeout)]\n\n${text}\n\nError: ${result.error}`);
                }
                pendingContexts.delete(dbId);
            } catch (error) {
                logger.error(`Failed to auto-approve draft ${dbId}: ${error}`);
            }
        }, timeoutMs);
        
        activeTimers.set(dbId, timer);
    }
}

bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data;
    if (!data) return;
    
    const match = data.match(/^(approve|reject|regenerate)_(.+)$/);
    if (!match) {
        logger.warn(`Unknown Telegram callback data: ${data}`);
        return;
    }

    const [, action, dbId] = match;
    const ctxData = pendingContexts.get(dbId);
    // @ts-ignore
    const message = ctx.callbackQuery.message;

    try {
        // Acknowledge immediately, but do not block the action if Telegram reports a stale query.
        try {
            await ctx.answerCbQuery();
        } catch (error) {
            logger.warn(`Telegram callback acknowledgement failed for ${dbId}: ${error}`);
        }
    
        if (action === 'approve' || action === 'reject') {
            if (activeTimers.has(dbId)) {
                clearTimeout(activeTimers.get(dbId)!);
                activeTimers.delete(dbId);
            }
            pendingContexts.delete(dbId);
        }

        if (action === 'approve') {
            if (!ctxData) {
                return;
            }
            logger.info(`Received APPROVE for draft ${dbId}`);
            await ctx.editMessageText(`[APPROVING...] Posting to Twitter...`);
            
            const result = await executeTwitterPost(dbId, ctxData.rawDraftText, ctxData.type, ctxData.contextData);
            const fullText = ctxData.displayLabel ? `${ctxData.displayLabel}:\n\n${ctxData.rawDraftText}` : ctxData.rawDraftText;
            
            if (result.success) {
                await ctx.editMessageText(`[APPROVED & POSTED]\n\n${fullText}\n\nID: ${result.tweetId}`);
            } else {
                await ctx.editMessageText(`[FAILED TO POST]\n\n${fullText}\n\nError: ${result.error}`);
            }
            
        } else if (action === 'reject') {
            await updateActionStatus(dbId, 'rejected');
            logger.info(`Received REJECT for draft ${dbId}`);
            const fullText = ctxData ? (ctxData.displayLabel ? `${ctxData.displayLabel}:\n\n${ctxData.rawDraftText}` : ctxData.rawDraftText) : 'Draft content lost';
            await ctx.editMessageText(`[REJECTED] Discarded.\n\n${fullText}`);
            if (ctxData && ctxData.type === 'post') {
                const { scheduleBackfillPost } = require('../scheduler');
                await scheduleBackfillPost();
            }
            
        } else if (action === 'regenerate') {
            if (!ctxData) {
                return;
            }
            
            if (ctxData.regenerateCount >= 3) {
                return;
            }
            
            if (activeTimers.has(dbId)) {
                clearTimeout(activeTimers.get(dbId)!);
                activeTimers.delete(dbId);
            }
            
            await ctx.editMessageText(`[REGENERATING...] Please wait...`);
            
            let newDraft = null;
            if (ctxData.type === 'post') {
                const { generateTweet } = require('../services/ai.service');
                newDraft = await generateTweet(ctxData.contextData.trending, ctxData.contextData.pastTweets);
            } else if (ctxData.type === 'reply' || ctxData.type === 'quote') {
                const { TweetSchema } = require('../services/ai.service');
                const { withRetry } = require('../utils/retry.util');
                const { validateCompliance } = require('../utils/compliance.util');
                
                let prompt = '';
                if (ctxData.type === 'quote') {
                    prompt = `${config.SYSTEM_PROMPT}\nYou are monitoring Twitter. Write a Quote Tweet (QT) adding insightful perspective.\nReturn ONLY valid JSON: {"content_type": "quote_tweet", "lane": "monitoring", "text": "QT text", "tickers": []}`;
                } else {
                    prompt = `${config.SYSTEM_PROMPT}\nYou received a mention. Write an engaging reply.\nReturn ONLY valid JSON: {"content_type": "reply", "lane": "engagement", "text": "reply text", "tickers": []}`;
                }
                
                newDraft = await withRetry('AI Regen', async () => {
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
                }, 3, 2000).catch((e: any) => null);
            }

            if (!newDraft) {
                await updateActionStatus(dbId, 'compliance_failed', undefined, 'Regeneration failed compliance after 3 retries');
                await ctx.editMessageText(`[REGENERATION FAILED] Could not generate compliant text.`);
                if (ctxData.type === 'post') {
                    const { scheduleBackfillPost } = require('../scheduler');
                    await scheduleBackfillPost();
                }
                pendingContexts.delete(dbId);
                return;
            }
            
            await sendDraftForApproval(ctxData.displayLabel, newDraft.text, dbId, ctxData.type, ctxData.contextData, (message as any).message_id, ctxData.regenerateCount + 1);
        }
        
    } catch (error) {
        logger.error(`Error handling callback: ${error}`);
    }
});

bot.telegram.deleteWebhook().then(() => {
    bot.launch();
    logger.info('Telegram bot is listening via polling...');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
