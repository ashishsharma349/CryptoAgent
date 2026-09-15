const SIMULATION_REAL_MINUTES = process.env.SIM_MINS ? parseInt(process.env.SIM_MINS) : 30; 
const productionAccountId = process.env.ACCOUNT_ID || 'crypto_agent_01';
process.env.ACCOUNT_ID = process.env.SIM_ACCOUNT_ID || `${productionAccountId}_simulation`;

const VIRTUAL_TICK_MINUTES = 5; 
const TOTAL_VIRTUAL_MINUTES = 24 * 60; // 1440
const TOTAL_TICKS = Math.floor(TOTAL_VIRTUAL_MINUTES / VIRTUAL_TICK_MINUTES); // 288
const REAL_MS_PER_TICK = (SIMULATION_REAL_MINUTES * 60 * 1000) / TOTAL_TICKS;

console.log(`\u23F1\uFE0F Starting Simulation: Mapping 24 hours into ${SIMULATION_REAL_MINUTES} real minutes.`);
console.log(`\uD83D\uDCC2 Simulation Mongo namespace: ${process.env.ACCOUNT_ID}`);
console.log(`Each 5-minute virtual tick will take ${REAL_MS_PER_TICK.toFixed(0)} ms in real time.\n`);

async function runMonitoringAndReposts() {
    const { getAgentConfig, logAction } = await import('../src/repo/mongo.repo');
    const { getTwitterClient } = await import('../src/services/twitter');
    const { sendDraftForApproval } = await import('../src/bot/telegram.bot');
    const { config } = await import('../src/config/env.config');
    const { withRetry } = await import('../src/utils/retry.util');
    const { TweetSchema } = await import('../src/services/ai.service');
    const { validateCompliance } = await import('../src/utils/compliance.util');
    const agentConfig = await getAgentConfig();
    const client = await getTwitterClient();
    const db = (await import('../src/repo/mongo.repo')).connectDB;
    const collection = (await db()).collection('monitored_tweets');

    const { evaluateTweetRelevance } = await import('../src/services/ai.service');
    let consecutiveEvalFailures = agentConfig.consecutive_eval_failures || 0;
    const { updateAgentConfig } = await import('../src/repo/mongo.repo');

    for (const targetUser of agentConfig.monitored_accounts || []) {
        try {
            const tweet = await client.getLatestTweet(targetUser);
            if (!tweet) continue;

            const existing = await collection.findOne({ account_id: config.ACCOUNT_ID, tweet_id: tweet.id });
            if (existing) continue;

            const evalResult = await evaluateTweetRelevance(tweet.text);
            if (evalResult.error) {
                consecutiveEvalFailures++;
                await updateAgentConfig({ consecutive_eval_failures: consecutiveEvalFailures });
                if (consecutiveEvalFailures >= 3) {
                    const { sendAlert } = await import('../src/bot/telegram.bot');
                    await sendAlert(`\u26A0\uFE0F Monitoring Eval Alert: Relevance check failed ${consecutiveEvalFailures} times in a row. Defaulting to Assume-Relevant.`);
                }
            } else {
                if (consecutiveEvalFailures > 0) {
                    consecutiveEvalFailures = 0;
                    await updateAgentConfig({ consecutive_eval_failures: 0 });
                }
            }

            if (!evalResult.relevant) {
                console.log(`[MONITORING] Skipping tweet ${tweet.id} as irrelevant.`);
                await collection.updateOne(
                    { account_id: config.ACCOUNT_ID, tweet_id: tweet.id },
                    { $set: { processing_status: 'skipped_irrelevant', fetched_at: new Date().toISOString() } },
                    { upsert: true }
                );
                continue;
            }

            await collection.updateOne(
                { account_id: config.ACCOUNT_ID, tweet_id: tweet.id },
                { $set: { processing_status: 'fetched', fetched_at: new Date().toISOString() } },
                { upsert: true }
            );

            const prompt = `${config.SYSTEM_PROMPT}\nYou are monitoring Twitter. The user ${targetUser} just tweeted: "${tweet.text}"\nWrite a Quote Tweet (QT) adding your insightful perspective.\nReturn ONLY valid JSON:\n{\n  "content_type": "quote_tweet",\n  "lane": "monitoring",\n  "text": "your QT text here",\n  "tickers": []\n}`;

            await collection.updateOne(
                { account_id: config.ACCOUNT_ID, tweet_id: tweet.id },
                { $set: { ai_input: prompt, ai_input_at: new Date().toISOString(), processing_status: 'ai_pending' } }
            );

            const draft = await withRetry('AI QT Generation', async () => {
                const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AI_API_KEY}` },
                    body: JSON.stringify({ model: config.AI_MODEL, messages: [{ role: 'user', content: prompt }], response_format: { type: "json_object" } })
                });
                const data = await response.json();
                const parsed = TweetSchema.parse(JSON.parse(data.choices[0].message.content));
                validateCompliance(parsed);
                return parsed;
            }, 3, 2000);

            await collection.updateOne(
                { account_id: config.ACCOUNT_ID, tweet_id: tweet.id },
                { $set: { ai_output: draft, processing_status: 'draft_ready' } }
            );

            const dbId = await logAction('pending', `QUOTE @${targetUser}: ${draft.text.substring(0, 50)}...`, draft.tickers, 'quote');
            await sendDraftForApproval(`[Quote Tweet of @${targetUser}]`, draft.text, dbId, 'quote', { tweetId: tweet.id });
            console.log(`[ACTION SENT TO HIL] Quote Tweet draft sent to Telegram for @${targetUser}/${tweet.id}`);

        } catch (error: any) {
            console.error(`[ACTION FAILED] Monitoring @${targetUser}: ${error?.message || error}`);
        }
    }
}

async function runMentions() {
    const { getAgentConfig, logAction } = await import('../src/repo/mongo.repo');
    const { sendDraftForApproval } = await import('../src/bot/telegram.bot');
    const { getTwitterClient } = await import('../src/services/twitter');
    const { TweetSchema } = await import('../src/services/ai.service');
    const { config } = await import('../src/config/env.config');
    const { withRetry } = await import('../src/utils/retry.util');
    const { validateCompliance } = await import('../src/utils/compliance.util');
    
    const db = (await import('../src/repo/mongo.repo')).connectDB;
    const collection = (await db()).collection('accounts_config');
    let configDoc = await collection.findOne({ account_id: config.ACCOUNT_ID });
    let lastCursor = configDoc?.last_mention_cursor || undefined;

    const client = await getTwitterClient();
    const newMentions = await client.getMentions(lastCursor);
    
    if (newMentions.length === 0) {
        console.log('[MENTIONS] No new mentions found.');
        return;
    }

    const mentionsCollection = (await db()).collection('engagement_mentions');
    await mentionsCollection.createIndex({ account_id: 1, mention_id: 1 }, { unique: true });

    let unprocessedMention = null;
    for (const mention of newMentions) {
        try {
            await mentionsCollection.insertOne({
                account_id: config.ACCOUNT_ID,
                mention_id: mention.id,
                username: mention.username,
                text: mention.text,
                created_at: mention.created_at,
                fetched_at: new Date().toISOString(),
                processing_status: 'fetched'
            });
            unprocessedMention = mention;
            break;
        } catch (error: any) {
            if (error.code === 11000) continue;
            throw error;
        }
    }

    if (!unprocessedMention) {
        console.log('[MENTIONS] No new unprocessed mentions found. Waiting for pending approvals.');
        return;
    }

    const mentionToReply = unprocessedMention;
    console.log(`[MENTIONS] Generating reply for mention from ${mentionToReply.username}`);

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

    try {
        const draft = await withRetry('AI Reply Generation', async () => {
            const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AI_API_KEY}` },
                body: JSON.stringify({
                    model: config.AI_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: "json_object" },
                    temperature: 0.7
                })
            });
            const data = await response.json();
            let content = data.choices[0].message.content;
            const firstBrace = content.indexOf('{');
            const lastBrace = content.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) content = content.substring(firstBrace, lastBrace + 1);
            const parsed = TweetSchema.parse(JSON.parse(content));
            validateCompliance(parsed);
            return parsed;
        }, 3, 2000);

        await mentionsCollection.updateOne(
            { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
            { $set: { ai_output: draft, ai_output_at: new Date().toISOString(), processing_status: 'draft_ready' } }
        );

        const dbId = await logAction('pending', `REPLY TO @${mentionToReply.username}: ${draft.text}`, draft.tickers, 'reply');
        await sendDraftForApproval(`REPLY TO @${mentionToReply.username}`, draft.text, dbId, 'reply', { tweetId: mentionToReply.id });
        
        await mentionsCollection.updateOne(
            { account_id: config.ACCOUNT_ID, mention_id: mentionToReply.id },
            { $set: { processing_status: 'approval_pending' } }
        );
        console.log(`[ACTION SENT TO HIL] Mention reply draft sent to Telegram for @${mentionToReply.username}`);
    } catch (e: any) {
        console.error(`[ACTION FAILED] Mention AI/Compliance failed: ${e.message}`);
    }
}

async function runSimulation() {
    const { executePlannedPosts, planDailyPosts } = await import('../src/scheduler');
    const { connectDB, updateAgentConfig } = await import('../src/repo/mongo.repo');
    const { config } = await import('../src/config/env.config');

    await import('../src/bot/telegram.bot');
    await connectDB();
    const virtualTime = new Date();
    virtualTime.setHours(0, 0, 0, 0);

    const db = await connectDB();
    await db.collection('planned_posts').deleteMany({ account_id: config.ACCOUNT_ID });
    await db.collection('daily_counters').deleteMany({ account_id: config.ACCOUNT_ID });
    await updateAgentConfig({ last_monitor_run: 0 });
    await db.collection('engagement_mentions').deleteMany({ account_id: config.ACCOUNT_ID });
    await db.collection('monitored_tweets').deleteMany({ account_id: config.ACCOUNT_ID });
    await db.collection('actions_log').deleteMany({ account_id: config.ACCOUNT_ID });
    console.log(`\u23F0 DB Cleanup Complete for Namespace: ${config.ACCOUNT_ID}`);

    console.log(`\u23F0 [VIRTUAL CLOCK] ${virtualTime.toLocaleTimeString()}: Planning posts for the day...`);
    await planDailyPosts(virtualTime);

    for (let i = 0; i < TOTAL_TICKS; i++) {
        virtualTime.setMinutes(virtualTime.getMinutes() + VIRTUAL_TICK_MINUTES);
        console.log(`\n\u23F0 [VIRTUAL CLOCK] ${virtualTime.toLocaleTimeString()} (Tick ${i + 1}/${TOTAL_TICKS})`);
        
        await executePlannedPosts(virtualTime);

        if (i % 3 === 0) { // Every 15 mins
            console.log(`\uD83D\uDD0D [VIRTUAL CLOCK] Executing Engagement (Mentions) Check...`);
            await runMentions();
        }

        if (i % 12 === 0) { // Every 1 hour
            console.log(`\uD83D\uDD0D [VIRTUAL CLOCK] Executing Monitoring Check...`);
            await runMonitoringAndReposts();
        }

        await new Promise(r => setTimeout(r, REAL_MS_PER_TICK));
    }

    console.log(`\n\u2705 Simulation Complete! 24 virtual hours passed.`);
    process.exit(0);
}

runSimulation().catch(console.error);