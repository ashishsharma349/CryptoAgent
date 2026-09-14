import { TweetDraft } from '../services/ai.service';
import { logger } from './logger.util';

export function validateCompliance(draft: TweetDraft): void {
    if (draft.tickers && draft.tickers.length > 0) {
        if (!draft.text.includes('Not financial advice. DYOR.')) {
            logger.warn(`Compliance check failed: Disclaimer missing for tickers [${draft.tickers.join(', ')}]`);
            throw new Error('Compliance validation failed: Missing disclaimer "Not financial advice. DYOR."');
        }
    }
}
