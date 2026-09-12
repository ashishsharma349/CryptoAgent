import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import { connectDB } from './repo/mongo.repo';
import { logger } from './utils/logger.util';
import { startMasterScheduler, runPipeline } from './scheduler';
import { startEngagementLoop } from './engagement';

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}\n${error.stack}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

const app = express();
const port = process.env.PORT || 7860;
app.get('/', (req, res) => res.send('CryptoAgent MVP is Running!'));
app.listen(port, () => logger.info(`Dummy web server listening on port ${port}`));

async function boot() {
    await connectDB();
    startMasterScheduler();
    startEngagementLoop();
    logger.info('Running initial test pipeline on boot...');
    runPipeline();
}

boot();
