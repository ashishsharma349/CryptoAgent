const SIMULATION_REAL_MINUTES = process.env.SIM_MINS ? parseInt(process.env.SIM_MINS) : 30; 
const productionAccountId = process.env.ACCOUNT_ID || 'crypto_agent_01';
process.env.ACCOUNT_ID = process.env.SIM_ACCOUNT_ID || `${productionAccountId}_simulation`;

const VIRTUAL_TICK_MINUTES = 5; 
const TOTAL_VIRTUAL_MINUTES = 24 * 60; // 1440
const TOTAL_TICKS = Math.floor(TOTAL_VIRTUAL_MINUTES / VIRTUAL_TICK_MINUTES); // 288
const REAL_MS_PER_TICK = (SIMULATION_REAL_MINUTES * 60 * 1000) / TOTAL_TICKS;

console.log(`🚀 Starting Simulation: Mapping 24 hours into ${SIMULATION_REAL_MINUTES} real minutes.`);
console.log(`🧪 Simulation Mongo namespace: ${process.env.ACCOUNT_ID}`);
console.log(`Each 5-minute virtual tick will take ${REAL_MS_PER_TICK.toFixed(0)} ms in real time.\n`);

async function runMonitoringAndReposts() {
    const { getAgentConfig } = await import('../src/repo/mongo.repo');
    const { evaluateRepostDecision } = await import('../src/services/ai.service');
    const { getTwitterClient } = await import('../src/services/twitter');
    const agentConfig = await getAgentConfig();
    const client = getTwitterClient();
    const db = (await import('../src/repo/mongo.repo')).connectDB;
    const collection = (await db()).collection('monitored_tweets');
    for (const account of agentConfig.monitored_accounts || []) {
        try {
            const tweet = await client.getLatestTweet(account);
            if (!tweet) {
                console.log(`[ACTION FAILED] Monitoring fetch: @${account}`);
                continue;
            }
            console.log(`[ACTION WORKING] Monitoring fetch: @${account} -> ${tweet.id}`);
            const decision = await evaluateRepostDecision(tweet.text);
            await collection.updateOne(
                { account_id: agentConfig.account_id, tweet_id: tweet.id },
                { $set: { ai_checked: true, ai_should_repost: decision.should_repost, ai_reason: decision.reason, ai_checked_at: new Date().toISOString() } },
                { upsert: true }
            );
            console.log(`[AI DECISION] @${account}/${tweet.id} should_repost=${decision.should_repost} reason=${decision.reason}`);
            if (decision.should_repost) {
                const repostId = await client.repostTweet(tweet.id);
                console.log(`[ACTION WORKING] AI-approved repost: @${account}/${tweet.id} -> ${repostId}`);
            } else {
                console.log(`[ACTION SKIPPED] AI rejected repost: @${account}/${tweet.id}`);
            }
        } catch (error: any) {
            console.error(`[ACTION FAILED] Monitoring @${account}: ${error?.message || error}`);
        }
    }
}

async function runSimulation() {
    const { executePlannedPosts, planDailyPosts } = await import('../src/scheduler');
    const { connectDB, updateAgentConfig } = await import('../src/repo/mongo.repo');
    const { config } = await import('../src/config/env.config');

    await import('../src/bot/telegram.bot');
    await connectDB();
    // Bot is launched automatically when imported

    // 2. Set start time to today at 12:00 AM
    const virtualTime = new Date();
    virtualTime.setHours(0, 0, 0, 0);

    // 3. Clear existing planned posts and reset counters for simulation
    const db = await connectDB();
    await db.collection('planned_posts').deleteMany({ account_id: config.ACCOUNT_ID });
    await db.collection('daily_counters').deleteMany({ account_id: config.ACCOUNT_ID });
    
    // Reset monitor run time so it triggers on first check
    await updateAgentConfig({ last_monitor_run: 0 });

    console.log(`🕒 [VIRTUAL CLOCK] ${virtualTime.toLocaleTimeString()}: Planning posts for the day...`);
    await planDailyPosts(virtualTime);

    // 4. Run the main loop
    for (let i = 0; i < TOTAL_TICKS; i++) {
        virtualTime.setMinutes(virtualTime.getMinutes() + VIRTUAL_TICK_MINUTES);
        
        console.log(`\n🕒 [VIRTUAL CLOCK] ${virtualTime.toLocaleTimeString()} (Tick ${i + 1}/${TOTAL_TICKS})`);
        
        // Execute scheduled posts against the virtual clock.
        await executePlannedPosts(virtualTime);

        if (i % 12 === 0) { // Every 1 hour (12 * 5 mins)
            console.log(`🔍 [VIRTUAL CLOCK] Executing Monitoring Check...`);
            await runMonitoringAndReposts();
            console.log('[ACTION SKIPPED] Mentions and replies are excluded from this simulation.');
        }

        // Wait for real time before next tick
        // (If executing posts took time, this wait is fine)
        await new Promise(r => setTimeout(r, REAL_MS_PER_TICK));
    }

    console.log(`\n✅ Simulation Complete! 24 virtual hours passed.`);
    process.exit(0);
}

runSimulation().catch(console.error);
