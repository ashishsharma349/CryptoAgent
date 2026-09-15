import { TweetDraft } from '../services/ai.service';
import { logger } from './logger.util';

const BANNED_PHRASES = [
    'moon soon',
    '10x',
    '100x',
    'will pump',
    'guaranteed',
    'guarantee',
    'price target',
    'buy now',
    'sell now',
    'financial advice',
    'investment advice',
    'sure thing',
    'cant lose',
    "can't lose",
    'risk free',
    'risk-free',
    'expected return',
];

export function validateCompliance(draft: TweetDraft): void {
    const textLower = draft.text.toLowerCase();

    // Check for banned phrases from SYSTEM_PROMPT
    for (const phrase of BANNED_PHRASES) {
        if (textLower.includes(phrase)) {
            logger.warn(`Compliance check failed: Banned phrase detected: "${phrase}"`);
            throw new Error(`Compliance validation failed: Tweet contains banned phrase "${phrase}"`);
        }
    }

    // Auto-append disclaimer when tickers mentioned (instead of checking AI output)
    if (draft.tickers && draft.tickers.length > 0) {
        draft.text = draft.text.trim() + '\n\nNot financial advice. DYOR.';
    }

    // Check tweet length after all modifications (Twitter hard limit is 280 characters)
    if (draft.text.length > 280) {
        logger.warn(`Compliance check failed: Tweet exceeds 280 characters (${draft.text.length} chars)`);
        throw new Error(`Compliance validation failed: Tweet too long (${draft.text.length}/280 characters)`);
    }
}
