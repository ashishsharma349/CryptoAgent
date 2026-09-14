import { getTwitterClient } from './src/services/twitter';
import { generateTweet } from './src/services/ai.service';
import { logAction, connectDB } from './src/repo/mongo.repo';
import { sendDraftForApproval } from './src/bot/telegram.bot';

async function testActions() {
    await connectDB();
    console.log("=== STARTING CORE ACTION TESTS ===");
    const client = getTwitterClient();
    
    // 1. Test Fetching
    console.log("\n[TEST 1] Fetching Latest Tweet from @RajatKast...");
    const tweet = await client.getLatestTweet('RajatKast');
    
    if (!tweet) {
        console.log("❌ Could not find tweet. Have you posted one recently?");
        return;
    }
    console.log(`✅ Found Tweet: "${tweet.text}"`);

    // 2. Generate Reply Draft
    console.log("\n[TEST 2] Generating Reply via AI...");
    const draft = await generateTweet([], [], `Reply to this crypto tweet: "${tweet.text}"`);
    if (!draft) {
        console.log("❌ Failed to generate AI draft.");
        return;
    }
    console.log(`✅ Draft generated: "${draft.text}"`);

    // 3. Telegram & Auto-Approve Flow
    console.log("\n[TEST 3] Sending to Telegram. WAIT 30 SECONDS without clicking anything!");
    const dbId = await logAction('pending', draft.text, [], 'reply');
    
    // We send for approval and the timeout will trigger executeTwitterPost automatically
    await sendDraftForApproval(`[Reply Test to @RajatKast]`, draft.text, dbId, 'reply', { tweetId: tweet.id });
    
    console.log("Sent! Please check Telegram and let the timer run out to see it post on Twitter.");
}

testActions().catch(console.error);
