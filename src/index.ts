import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import { connectDB , getAgentConfig, updateAgentConfig } from './repo/mongo.repo';
import { config } from './config/env.config';
import { logger } from './utils/logger.util';
import { startMasterScheduler, runPipeline } from './scheduler';
import { startEngagementLoop } from './engagement';
import { startTweetMonitoring } from './monitoring';
import { resetTwitterClient } from './services/twitter';

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}\n${error.stack}`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

const app = express();
app.use(express.json());

function requireAdminPassword(req: express.Request, res: express.Response, next: express.NextFunction) {
    const authorization = req.headers.authorization;
    if (!config.ADMIN_PASSWORD || !authorization?.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="CryptoAgent Admin"');
        return res.status(401).send('Admin password required');
    }

    const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = credentials.indexOf(':');
    const password = separator >= 0 ? credentials.slice(separator + 1) : '';
    if (password !== config.ADMIN_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="CryptoAgent Admin"');
        return res.status(401).send('Invalid admin password');
    }

    next();
}

app.use('/admin', requireAdminPassword, express.static('src/ui'));
app.use('/api/config', requireAdminPassword);

app.get('/api/config', async (req, res) => {
    try {
        const conf = await getAgentConfig();
        res.json({
            ...conf,
            twitter_auth_token: conf.twitter_auth_token ? '********' : '',
            twitter_ct0: conf.twitter_ct0 ? '********' : ''
        });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});


app.post('/api/config', async (req, res) => {
    try {
        const updates = { ...req.body };
        if (updates.twitter_auth_token === '********') delete updates.twitter_auth_token;
        if (updates.twitter_ct0 === '********') delete updates.twitter_ct0;
        await updateAgentConfig(updates);
        if ('twitter_client_type' in updates || 'twitter_auth_token' in updates || 'twitter_ct0' in updates) {
            resetTwitterClient();
        }
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
