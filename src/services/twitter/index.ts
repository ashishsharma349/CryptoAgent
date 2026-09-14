import { ITwitterClient } from './twitter.interface';
import { OfficialTwitterAdapter } from './official.adapter';
import { PuppeteerTwitterAdapter } from './puppeteer.adapter';
import { getAgentConfig } from '../../repo/mongo.repo';

let clientInstance: ITwitterClient | null = null;

export function resetTwitterClient() {
    clientInstance = null;
}

export async function getTwitterClient(): Promise<ITwitterClient> {
    if (clientInstance) return clientInstance;

    const config = await getAgentConfig();

    if (config.twitter_client_type === 'unofficial') {
        console.log('🔄 Using Unofficial (Puppeteer Stealth) Twitter Client');
        clientInstance = new PuppeteerTwitterAdapter();
    } else {
        console.log('🔄 Using Official (OAuth 1.0a) Twitter Client');
        clientInstance = new OfficialTwitterAdapter();
    }
    
    return clientInstance;
}
