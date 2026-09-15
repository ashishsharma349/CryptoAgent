# CryptoAgent

Autonomous Twitter bot for crypto content generation, engagement automation, and monitoring.

## Features

- **Autonomous Posting**: AI-generated crypto tweets with compliance checks
- **Engagement Automation**: Reply to mentions with context-aware responses
- **Monitoring**: Quote-tweet tracked accounts
- **Human-in-the-Loop**: Telegram approval workflow with regeneration (3x max)
- **Compliance Layer**: Banned phrase detection, auto-disclaimer for tickers, 280-char enforcement
- **Rate Limiting**: Daily post/reply limits with MongoDB tracking
- **Retry Logic**: Exponential backoff on all Twitter operations (3 attempts)

## Tech Stack

- **Runtime**: Node.js + TypeScript (tsx)
- **Twitter Automation**: Puppeteer + stealth plugin (cookie-based auth)
- **AI**: OpenAI-compatible API (JSON mode, Zod validation)
- **Database**: MongoDB (state persistence, audit trail)
- **Bot Interface**: Telegraf (Telegram)
- **Scheduling**: node-cron (daily planning + minute-level execution)

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment** (`.env`):
   ```
   TELEGRAM_BOT_TOKEN=<your_bot_token>
   TELEGRAM_CHAT_ID=<your_chat_id>
   MONGO_URI=<mongodb_connection_string>
   AI_API_URL=<openai_compatible_endpoint>
   AI_API_KEY=<your_api_key>
   AI_MODEL=<model_name>
   ACCOUNT_ID=<unique_account_identifier>
   SYSTEM_PROMPT=<agent_persona_and_guidelines>
   ```

3. **Set Twitter credentials** in MongoDB `agent_config` collection:
   ```json
   {
     "twitter_auth_token": "your_auth_token",
     "twitter_ct0": "your_ct0_cookie"
   }
   ```

4. **Run the agent**:
   ```bash
   npm start
   ```

## Architecture

- **Scheduler** (`scheduler.ts`): Daily post planning + minute-level execution loop
- **Engagement** (`engagement.ts`): Mention detection + reply generation (every 15 min)
- **Monitoring** (`monitoring.ts`): Tracked account scraping + quote-tweet flow (every 10 min)
- **Telegram Bot** (`telegram.bot.ts`): Approval/rejection/regeneration handlers
- **Compliance** (`compliance.util.ts`): Pre-flight validation before Twitter API calls
- **Retry Layer** (`retry.util.ts`): Exponential backoff wrapper for network operations

## Database Collections

- `agent_config`: Twitter credentials, monitored accounts, system config
- `planned_posts`: Daily post queue with execution tracking
- `engagement_mentions`: Mention lifecycle (fetched → ai_pending → draft_ready → approval_pending)
- `monitored_tweets`: Tracked account tweets for quote-tweet flow
- `accounts_config`: Last mention cursor for deduplication
- `actions_log`: Audit trail (pending → posted/rejected/compliance_failed)
- `daily_counters`: Rate limit tracking

## Configuration

Adjust retry/timeout constants in `src/config/constants.ts`:
```typescript
export const RETRY = {
    MAX_ATTEMPTS: 3,
    DELAY_MS: 2000,
} as const;
```

## Compliance Rules

- **Banned phrases**: moon soon, 10x, 100x, guaranteed, financial advice, etc.
- **Ticker disclaimer**: Auto-appended when `tickers` array non-empty
- **Length limit**: 280 characters (enforced post-disclaimer)

## Production Notes

- All Twitter operations wrapped in retry logic (3 attempts, exponential backoff)
- Browser cleanup guaranteed via try/finally blocks
- DB-first pattern: State saved before external API calls
- Cursor-based mention deduplication prevents duplicate replies
- plannedPostId threading ensures execution tracking loop closes correctly
