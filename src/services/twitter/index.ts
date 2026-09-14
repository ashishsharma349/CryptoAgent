import { ITwitterClient } from './twitter.interface';
import { OfficialTwitterAdapter } from './official.adapter';
import { logger } from '../../utils/logger.util';

let clientInstance: ITwitterClient | null = null;

export function getTwitterClient(): ITwitterClient {
    if (clientInstance) return clientInstance;

    logger.info(`Creating Official Twitter Client`);
    clientInstance = new OfficialTwitterAdapter();
    
    return clientInstance;
}
