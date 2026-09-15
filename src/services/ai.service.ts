import { config } from '../config/env.config';
import { z } from 'zod';
import { logger } from '../utils/logger.util';
import { withRetry } from '../utils/retry.util';
import { getAgentConfig } from '../repo/mongo.repo';

export const TweetSchema = z.object({
    content_type: z.string(),
    lane: z.string(),
    text: z.string(),
    tickers: z.array(z.string()).default([]),
});

export type TweetDraft = z.infer<typeof TweetSchema>;

const RepostDecisionSchema = z.object({
    should_repost: z.boolean(),
    reason: z.string().min(1)
});

export type RepostDecision = z.infer<typeof RepostDecisionSchema>;

export async function evaluateRepostDecision(tweetText: string): Promise<RepostDecision> {
    try {
        if (!tweetText.trim()) throw new Error('Cannot evaluate an empty tweet');
        const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.AI_API_KEY}`
            },
            body: JSON.stringify({
                model: config.AI_MODEL,
                messages: [{
                    role: 'user',
                    content: `${config.SYSTEM_PROMPT}\nDecide whether this crypto tweet is worth reposting for this account. Repost only if it is relevant and adds value. Return only JSON: {"should_repost": true or false, "reason": "brief reason"}.\nTweet: ${tweetText}`
                }],
                response_format: { type: 'json_object' },
                stream: false
            })
        });
        if (!response.ok) throw new Error(`AI error: ${response.status}`);
        const data = await response.json();
        const content = data.choices[0].message.content;
        return RepostDecisionSchema.parse(JSON.parse(content));
    } catch (error) {
        logger.error(`Failed to evaluate repost decision: ${error}`);
        return { should_repost: false, reason: 'AI evaluation failed' };
    }
}

export async function shouldRepostTweet(tweetText: string): Promise<boolean> {
    return (await evaluateRepostDecision(tweetText)).should_repost;
}

export async function generateTweet(trendingData: any, pastTweets: string[] = [], contextOverride?: string, lane?: string): Promise<TweetDraft | null> {
    try {
        const agentConfig = await getAgentConfig();
        const basePrompt = agentConfig.system_prompt || config.SYSTEM_PROMPT;
        
        let promptStr = `You are a crypto AI agent.\n${basePrompt}\n`;
        
        if (contextOverride) {
            promptStr += `\nTASK CONTEXT: ${contextOverride}\n`;
        } else {
            promptStr += `\nTrending Crypto Data: ${JSON.stringify(trendingData)}\n`;
            promptStr += `Recent Tweets (Avoid exact repetition): ${JSON.stringify(pastTweets)}\n`;
        }
        
        const selectedLane = lane || 'pulse';
        let laneInstruction = '';
        if (selectedLane === 'pulse') laneInstruction = 'Focus on a quick market update or price action context.';
        if (selectedLane === 'meme') laneInstruction = 'Make it humorous, slightly edgy, or a crypto culture meme.';
        if (selectedLane === 'opinion') laneInstruction = 'Share a strong, contrarian, or thoughtful hot take on the market.';
        if (selectedLane === 'education') laneInstruction = 'Explain a crypto concept, tool, or metric clearly (no financial advice).';
        if (selectedLane === 'tools') laneInstruction = 'Highlight a useful crypto trading or analysis tool.';

        promptStr += `\nLANE ASSIGNMENT: You must write this tweet in the '${selectedLane}' lane. ${laneInstruction}`;
        
        promptStr += `\nGenerate a tweet draft matching the persona.
Return ONLY valid JSON matching this structure:
{
  "content_type": "post",
  "lane": "${selectedLane}",
  "text": "your tweet text here",
  "tickers": []
}`;
        return await withRetry('AI generation', async () => {
            const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.AI_API_KEY}`
                },
                body: JSON.stringify({
                    model: config.AI_MODEL,
                    messages: [{ role: 'user', content: promptStr }],
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

const RelevanceSchema = z.object({ relevant: z.boolean() });
export async function evaluateTweetRelevance(tweetText: string): Promise<{ relevant: boolean, error?: boolean }> {
    try {
        if (!tweetText.trim()) throw new Error('Cannot evaluate an empty tweet');
        const prompt = `Analyze if the following tweet is related to cryptocurrency, blockchain, web3, trading, finance, tech, or markets.\nTweet: "${tweetText}"\nReturn ONLY valid JSON:\n{\n  "relevant": true/false\n}`;
        
        const response = await fetch(`${config.AI_API_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.AI_API_KEY}` },
            body: JSON.stringify({
                model: config.AI_MODEL,
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) throw new Error(`AI error: ${response.status}`);
        const data = await response.json();
        let content = data.choices[0].message.content;
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) content = content.substring(firstBrace, lastBrace + 1);
        
        const parsed = RelevanceSchema.parse(JSON.parse(content));
        return { relevant: parsed.relevant };
    } catch (error) {
        logger.error(`Failed to evaluate tweet relevance: ${error}`);
        // ASSUME RELEVANT ON FAILURE to prevent silent dropping of coverage
        return { relevant: true, error: true };
    }
}