import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import { connectDB , getAgentConfig, updateAgentConfig } from './repo/mongo.repo';
import { logger } from './utils/logger.util';
import { startMasterScheduler, runPipeline } from './scheduler';
import { startEngagementLoop } from './engagement';
import { startTweetMonitoring } from './monitoring';

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}\n${error.stack}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

const app = express();
app.use(express.json());
app.use('/admin', express.static('src/ui'));

app.get('/api/config', async (req, res) => {
    try {
        const conf = await getAgentConfig();
        res.json(conf);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        await updateAgentConfig(req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

const port = process.env.PORT || 7860;
app.get('/', (req, res) => res.send('CryptoAgent MVP is Running!'));
app.listen(port, () => logger.info(`Web server listening on port ${port}`));

async function boot() {
    await connectDB();
    startMasterScheduler();
    startEngagementLoop();
    startTweetMonitoring();
    logger.info('Boot complete. Services started.');
}

boot();
