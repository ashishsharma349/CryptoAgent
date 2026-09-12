import { Telegraf, Markup } from 'telegraf';
import https from 'https';
import { config } from '../config/env.config';
import { updateActionStatus } from '../repo/mongo.repo';
import { logger } from '../utils/logger.util';

export const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
    telegram: {
        agent: new https.Agent({ family: 4 })
    }
});

const activeTimers = new Map<string, NodeJS.Timeout>();

export async function sendDraftForApproval(text: string, dbId: string) {
    const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('Approve', `approve_${dbId}`),
        Markup.button.callback('Reject', `reject_${dbId}`)
    ]);
    
    const msg = await bot.telegram.sendMessage(config.TELEGRAM_CHAT_ID, `DRAFT TWEET:\n\n${text}`, keyboard);

    const timeoutMs = config.AUTO_POST_TIMEOUT_MINUTES * 60 * 1000;
    const timer = setTimeout(async () => {
        try {
            activeTimers.delete(dbId);
            await updateActionStatus(dbId, 'approved');
            logger.info(`Timeout reached. Auto-approved draft ${dbId}`);
            
            await bot.telegram.editMessageText(
                config.TELEGRAM_CHAT_ID,
                msg.message_id,
                undefined,
                `[AUTO-APPROVED by Timeout]\n\n${text}`
            );
        } catch (error) {
            logger.error(`Failed to auto-approve draft ${dbId}: ${error}`);
        }
    }, timeoutMs);
    
    activeTimers.set(dbId, timer);
}

bot.on('callback_query', async (ctx) => {
    // @ts-ignore
    const data = ctx.callbackQuery.data;
    if (!data) return;
    
    const [action, dbId] = data.split('_');
    
    if (activeTimers.has(dbId)) {
        clearTimeout(activeTimers.get(dbId)!);
        activeTimers.delete(dbId);
    }
    
    try {
        if (action === 'approve') {
            await updateActionStatus(dbId, 'approved');
            logger.info(`Received APPROVE for draft ${dbId}`);
            // @ts-ignore
            await ctx.editMessageText(`[APPROVED] Logged and ready for Twitter.\n\n${ctx.callbackQuery.message.text}`);
        } else if (action === 'reject') {
            await updateActionStatus(dbId, 'rejected');
            logger.info(`Received REJECT for draft ${dbId}`);
            // @ts-ignore
            await ctx.editMessageText(`[REJECTED] Discarded.\n\n${ctx.callbackQuery.message.text}`);
        }
        await ctx.answerCbQuery();
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
