import { connectDB } from '../src/repo/mongo.repo';
import { config } from '../src/config/env.config';

async function updateDB() {
    console.log('Connecting to DB...');
    const db = await connectDB();
    const collection = db.collection('accounts_config');
    
    console.log('Updating monitored_accounts for', config.ACCOUNT_ID);
    
    await collection.updateOne(
        { account_id: config.ACCOUNT_ID },
        { 
            $set: { 
                monitored_accounts: ['elonmusk', 'cz_binance', 'VitalikButerin', 'RajatKast'],
                monitor_interval_hours: 2, // Check every 2 hours in virtual time
            }
        },
        { upsert: true }
    );
    
    console.log('✅ DB updated successfully with target accounts!');
    process.exit(0);
}

updateDB().catch(console.error);
