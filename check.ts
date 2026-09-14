import { connectDB } from "./src/repo/mongo.repo";
import { config } from "./src/config/env.config";

async function check() {
    const db = await connectDB();
    const doc = await db.collection("accounts_config").findOne({ account_id: config.ACCOUNT_ID });
    console.log(JSON.stringify(doc, null, 2));
    process.exit(0);
}
check();
