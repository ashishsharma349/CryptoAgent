import { config } from '../config/env.config';
import { z } from 'zod';
import { logger } from '../utils/logger.util';
import { withRetry } from '../utils/retry.util';

export const TweetSchema = z.object({
    content_type: z.string(),
    lane: z.string(),
    text: z.string(),
    tickers: z.array(z.string()),
});

export type TweetDraft = z.infer<typeof TweetSchema>;

export async function generateTweet(trendingData: any, pastTweets: string[] = []): Promise<TweetDraft | null> {
    const memoryContext = pastTweets.length > 0 
        ? `\nRECENT TWEETS (DO NOT REPEAT THESE HOOKS, JOKES, OR ANGLES):\n` + pastTweets.map(t => `- ${t}`).join('\n')
        : '';

    const prompt = `
${config.SYSTEM_PROMPT}

Current Trending Coins:
${JSON.stringify(trendingData, null, 2)}
${memoryContext}

Write a short, engaging tweet about one of these trending coins.
Return ONLY valid JSON matching this structure:
{
  "content_type": "post",
  "lane": "pulse",
  "text": "your tweet text here",
  "tickers": ["COIN"]
}`;

    try {
        return await withRetry('AI generation', async () => {
            const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.AI_API_KEY}`
                },
                body: JSON.stringify({
                    model: config.AI_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    response_format: { type: "json_object" },
                    stream: false
                })
            });

            if (!response.ok) throw new Error(`AI error: ${response.status}`);
            
            const data = await response.json();
            let content = data.choices[0].message.content;
            
            const firstBrace = content.indexOf('{');
            const lastBrace = content.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                content = content.substring(firstBrace, lastBrace + 1);
            }

            const parsed = JSON.parse(content);
            const draft = TweetSchema.parse(parsed);
            
            const { validateCompliance } = require('../utils/compliance.util');
            validateCompliance(draft);
            
            return draft;
        }, 3, 2000);
    } catch (error) {
        logger.error(`Failed to generate tweet: ${error}`);
        return null;
    }
}
