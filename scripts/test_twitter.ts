import { getTwitterClient } from "../src/services/twitter";
import { config } from "../src/config/env.config";

async function test() {
    console.log("Testing Twitter Client...");
    console.log(`Config Type: ${config.TWITTER_CLIENT_TYPE}`);
    console.log(`Username: ${config.TWITTER_USERNAME}`);
    
    try {
        const client = getTwitterClient();
        console.log("Fetching mentions to test login...");
        const mentions = await client.getMentions();
        console.log(`Success! Found ${mentions.length} mentions.`);
        if (mentions.length > 0) {
            console.log("Latest mention:", mentions[0]);
        }
        process.exit(0);
    } catch (e) {
        console.error("Test failed:", e);
        process.exit(1);
    }
}
test();
