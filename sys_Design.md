# SYSTEM_DESIGN.md — Multi-Account AI Twitter Agent
**Stack:** n8n (self-hosted) · OpenAI API · ChirpAPI · MongoDB Atlas · CoinGecko · Telegram Bot
**Status:** Draft for review — assumptions marked [ASSUMED], unresolved items marked [UNKNOWN]

---

## 0. Scope Notes (read before building)

- **ChirpAPI is not something I can vet or design write-permission logic against** — I don't have reliable specs on how it obtains Twitter write access, especially for actions (like/retweet/follow) that X removed from its own self-serve API in April 2026. Treat every ChirpAPI call as an external dependency of unknown reliability: wrap all of them in the error-handling pattern in Section 8, and confirm ChirpAPI's terms/ToS-compliance yourself before relying on it for production accounts.
- **Multi-account is built as isolated, config-driven infrastructure**, not as a way to fake independent grassroots accounts amplifying each other. If Account 2/3 end up being used to reply to or amplify Account 1's posts to simulate organic third-party traction, that's coordinated inauthentic behavior regardless of tooling — the design doesn't include an "accounts interact with each other" feature (Open Question 11 resolved as: **no**, unless they are genuinely distinct, independently disclosed brands with no cross-promotion of each other's posts).
- **No fingerprint/IP rotation or detection-evasion logic is included** (Open Question 5 resolved as: **out of scope**). Randomization below is for natural-looking scheduling only, not evasion.

---

## 1. High-Level Architecture

```
                         ┌───────────────────────────────┐
                         │  MongoDB: accounts_config      │
                         │  (one doc per account, holds   │
                         │  persona, lanes, schedule,     │
                         │  Telegram chat ID, API keys*)  │
                         └───────────────┬─────────────────┘
                                         │ read at start of every run
        ┌────────────────────────────────┼─────────────────────────────────┐
        │                                                                  │
   n8n WORKFLOW 1: CONTENT LOOP                              n8n WORKFLOW 2: ENGAGEMENT LOOP
   (per account, jittered schedule)                          (per account, ~15 min poll)
        │                                                                  │
  1. Load account config (persona, lane rotation state)         1. Load account config
  2. Determine due lane from rotation state                     2. ChirpAPI: fetch mentions since last cursor
  3. MongoDB: pull last 10d full content +                       3. Filter spam / low-quality senders
     last 20d titles/tickers for this account_id only            4. MongoDB: pull source-list priority + reply history
  4. (Pulse lane only) CoinGecko: pull live BSC data              5. OpenAI: generate reply candidate(s)
  5. OpenAI: generate draft, JSON output, grounded only           6. Similarity check vs this account's reply history
     in data actually passed in                                  7. Telegram HIL: send to THIS account's configured
  6. Dedupe check vs pulled history                                  chat, Approve/Reject/Edit buttons
  7. Telegram HIL: send preview to THIS account's                8. Wait for response (timeout logic, Section 6)
     configured chat, Approve/Reject/Edit buttons                9. On approve: ChirpAPI: post reply
  8. Wait node (configurable timeout, Section 6)                10. MongoDB: log action (Section 5 schema)
  9. On approve: (optional) image gen → ChirpAPI: post          11. Update per-account rate counters
 10. MongoDB: log action + update rotation state
 11. Update per-account daily counters

                         ┌───────────────────────────────┐
                         │  n8n WORKFLOW 3: DAILY RESET   │
                         │  Resets per-account counters,  │
                         │  runs once per account per day │
                         └───────────────────────────────┘

                         ┌───────────────────────────────┐
                         │  n8n WORKFLOW 4: WEEKLY REPORT │
                         │  Aggregates MongoDB per account,│
                         │  OpenAI summary, sends to       │
                         │  operator (not per-account chat)│
                         └───────────────────────────────┘
```

*API keys should live in n8n's built-in credential store, referenced by ID from the config document — never store raw keys inside MongoDB documents (see Section 9).

---

## 2. n8n Workflow Breakdown

### Workflow 1 — Scheduled Content Generation (loops once per active account)

| # | Node | Details |
|---|---|---|
| 1 | **Cron (with jitter)** | Base schedule per account (e.g. 6–10 posts/day spread across active hours) + a **Function node** that adds a random ±15–30 min offset before proceeding, so timing isn't perfectly periodic |
| 2 | **MongoDB → Find One** (`accounts_config`) | Load persona, lane rotation state, Telegram chat ID, active/paused flag |
| 3 | **IF** | If `status != active` → stop here (paused accounts do nothing) |
| 4 | **Function** | Determine which lane is due, based on rotation rules (no lane >2 consecutive days) using `rotation_state` from config doc |
| 5 | **MongoDB → Find** (`actions_log`) | `account_id` = this account, `type = post`, `timestamp >= now-10d` → full content; separate query `timestamp >= now-20d`, project only `topic/ticker/title` fields |
| 6 | **IF (lane == Pulse)** | Branch to live data pull |
| 6a | **HTTP Request → CoinGecko** | Pull trending BSC pairs. Output feeds directly into the OpenAI prompt as the *only* permitted source of numbers |
| 7 | **OpenAI → Chat Completion** | System prompt (Section 4 of prior doc, reused) + dynamic context (lane, history, live data) → JSON out |
| 8 | **Function** | Parse JSON; independently re-check `tickers.length > 0` and force `needs_human_review = true` regardless of model's own flag (don't trust the model's self-assessment alone) |
| 9 | **Function → similarity check** | Compare `post_text` against the pulled history (simple normalized-text overlap, or a second cheap OpenAI call asking "is this substantially similar to any of these?"); if too similar, loop back to node 7 (max 2 retries), else continue |
| 10 | **IF (image needed)** | Branch to image generation (template engine or DALL·E per lane — see prior doc Section 5, same logic applies here) |
| 11 | **Telegram → Send Message** | To **this account's configured `telegram_chat_id`** — include draft text, image if any, inline Approve/Reject/Edit buttons |
| 12 | **Wait (webhook-resumed)** | n8n Wait node listening for the Telegram callback webhook, with a **timeout branch** (Section 6) |
| 13 | **Switch** | Approved → continue / Rejected → log + end / Timeout → per config, Section 6 |
| 14 | **ChirpAPI → Post Tweet** | Wrapped in error-handling (Section 8) |
| 15 | **MongoDB → Insert** (`actions_log`) | Full record incl. account_id, status=posted, tweet_id |
| 16 | **MongoDB → Update** (`accounts_config.rotation_state`) | Mark lane used today |
| 17 | **MongoDB → Update** (`daily_counters`) | Increment posts_today for this account |

### Workflow 2 — Mentions/Reply Monitoring (loops once per active account)

| # | Node | Details |
|---|---|---|
| 1 | **Cron** | Every 10–15 min per account [ASSUMED — Open Question 4] |
| 2 | **MongoDB → Find One** (`accounts_config`) | Load config, `last_mention_cursor` |
| 3 | **ChirpAPI → Get Mentions** | Since `last_mention_cursor` |
| 4 | **IF (empty)** | Stop if nothing new |
| 5 | **Function → Filter** | Drop obvious spam/bot senders (basic heuristics: follower count, account age if available) |
| 6 | **MongoDB → Find** (`source_accounts`) | This account's priority list, to tag urgency (does not gate whether to reply — 100% non-spam response rate per requirement) |
| 7 | **MongoDB → Find** (`actions_log`, type=reply, last 7–10d) | For repetition check |
| 8 | **OpenAI → Chat Completion** | Persona + guardrails + tweet content + recent reply history → reply candidate, JSON |
| 9 | **Function** | Force `needs_human_review = true` if reply references a ticker/market claim, independent of model output |
| 10 | **MongoDB → Find** (`daily_counters`) | Check `replies_today` against target cap — if at/over cap, queue for tomorrow instead of sending (log as `status: deferred`) |
| 11 | **Telegram → Send Message** | To this account's chat, batched every run rather than one-message-per-mention if volume is high |
| 12 | **Wait (webhook-resumed)** | Timeout logic per Section 6 |
| 13 | **ChirpAPI → Post Reply** | On approval |
| 14 | **MongoDB → Insert** (`actions_log`) | |
| 15 | **MongoDB → Update** | `last_mention_cursor`, `daily_counters.replies_today` |

*Quote tweets and retweets follow the identical pattern to replies (steps 6–15), triggered instead by a separate poll of the account's monitored source list (Section 9 of REQUIREMENT.md) for major news/threads worth quoting. Likes are **not included as an automated action** — see Section 10 note below.

### Workflow 3 — Daily Counter Reset
Cron (00:00 UTC per account's configured timezone, or fixed UTC) → MongoDB update, zero out `daily_counters` for that account.

### Workflow 4 — Weekly Report
Cron (weekly) → MongoDB aggregate query across `actions_log` per account for the past 7 days → OpenAI summarization → Telegram/Email to **operator's own chat** (not the per-account HIL chats) with a per-account breakdown.

---

## 3. Multi-Account Routing Logic

- A single n8n workflow, parameterized by `account_id`, is triggered once per active account rather than duplicating the workflow per account. Use an **n8n "Split In Batches" / loop over `accounts_config` collection** at the top of a wrapper workflow, or separate Cron triggers per account calling the same sub-workflow with `account_id` as input — either works; the sub-workflow pattern is cleaner for maintenance (Requirement: "adding a new account should require only config changes").
- **Adding Account N+1 = inserting one new document into `accounts_config` + creating its Telegram bot/chat.** No workflow code changes needed, satisfying Requirement Section 3's constraint.
- Every MongoDB read/write in both workflows is scoped by `account_id` — never a global query — so memory, rate counters, and rotation state are fully isolated per account (Requirement Section 8, "memory is per account").

---

## 4. MongoDB Collection Schemas

### `accounts_config`
```json
{
  "_id": "wizard_bsc",
  "handle": "@WIZARD_BSC",
  "status": "active",
  "persona": {
    "voice_description": "smart degen, wizard archetype...",
    "emoji_set": ["🧙", "🔥", "⚡", "📉", "⚠️"]
  },
  "lanes": ["pulse", "opinion", "tools", "education", "meme"],
  "rotation_state": {
    "last_lane": "pulse",
    "last_lane_date": "2026-09-10",
    "consecutive_days_count": 1
  },
  "schedule": {
    "posts_per_day_min": 6,
    "posts_per_day_max": 10,
    "active_hours_utc": [8, 23],
    "jitter_minutes": 30
  },
  "telegram_chat_id": "-100XXXXXXXXX",
  "credential_ref": {
    "chirpapi_credential_id": "n8n-credential-id-not-raw-key",
    "openai_credential_id": "n8n-credential-id-not-raw-key"
  },
  "daily_targets": {
    "posts": 8,
    "replies": 20,
    "quotes": 4,
    "retweets": 0
  },
  "hil_timeout_minutes": 45,
  "hil_timeout_behavior": "auto_discard",
  "created_at": "...",
  "updated_at": "..."
}
```

### `actions_log` (all post/reply/quote types, one collection, filtered by `type`)
```json
{
  "_id": "...",
  "account_id": "wizard_bsc",
  "type": "post | reply | quote | retweet",
  "lane": "pulse | opinion | tools | education | meme | null",
  "timestamp": "ISODate",
  "content_text": "...",
  "tickers": ["..."],
  "narrative_tag": "...",
  "target_tweet_id": "... (null for original posts)",
  "target_account": "... (null for original posts)",
  "image_url": "... | null",
  "status": "draft | approved | rejected | timed_out | posted | failed | deferred",
  "rejection_reason": "... | null",
  "hil_response_time_seconds": 0,
  "tweet_id": "... (after posting)",
  "error_detail": "... | null",
  "content_hash": "..."
}
```

### `daily_counters`
```json
{
  "_id": "wizard_bsc_2026-09-11",
  "account_id": "wizard_bsc",
  "date": "2026-09-11",
  "posts_today": 3,
  "replies_today": 12,
  "quotes_today": 1,
  "api_spend_estimate_usd": 0.87
}
```

### `source_accounts` (per-account monitoring/priority list)
```json
{
  "_id": "...",
  "account_id": "wizard_bsc",
  "handle": "@PancakeSwap",
  "category": "exchange | protocol | kol | bot_project | narrative_starter",
  "priority_rank": 1
}
```

### `error_log`
```json
{
  "_id": "...",
  "account_id": "wizard_bsc",
  "timestamp": "ISODate",
  "workflow": "content_loop | engagement_loop",
  "node_failed": "...",
  "error_message": "...",
  "retry_count": 0
}
```

---

## 5. Telegram HIL Interaction Flow (per account)

1. n8n sends a message to the account's configured `telegram_chat_id` containing: draft content, image (if any), and three inline buttons: **✅ Approve**, **❌ Reject**, **✏️ Edit**.
2. **Approve** → Telegram webhook fires → n8n Wait node resumes → proceeds to posting.
3. **Reject** → Telegram bot replies asking for a one-line reason (free text) → next message from that chat/user in that thread is captured via a short-lived Telegram "reply-to" listener and stored in `actions_log.rejection_reason` → workflow ends without posting. *(Resolves Open Question 2.)*
4. **Edit** → operator sends replacement text as a message → n8n captures it, substitutes it for `content_text`, and re-runs the guardrail check (ticker/disclaimer check, Section 6 of prior doc) before proceeding to posting — this avoids the edit path becoming a way to bypass guardrails silently.
5. **Timeout** — see Section 6 below.

**Per-account chat isolation:** [ASSUMED — Open Question 12] one shared Telegram *bot* application, but a **distinct chat/channel ID per account**, stored in `accounts_config.telegram_chat_id`. This is simpler to operate (one bot token to manage) while still keeping approvals fully separated. If you want fully separate bots per account instead, only Section 4's `credential_ref` needs an added `telegram_bot_token_id` field — no structural change.

**Bot ownership:** [ASSUMED — Open Question 7] the operator owns and controls the Telegram bot token(s); n8n only holds the credential. This should not be delegated to any third party.

---

## 6. HIL Timeout Behavior — Resolved

**Default: `auto_post`**, configurable per account via `accounts_config.hil_timeout_behavior` (`auto_post` or `auto_discard`).

Reasoning for defaulting to auto-post rather than auto-discard: the operator wants the bot to continue posting autonomously if they are asleep or unavailable, maximizing throughput and maintaining a consistent schedule.

```json
"hil_timeout_behavior_by_lane": {
  "meme": "auto_post",
  "education": "auto_post",
  "tools": "auto_post",
  "opinion": "auto_post",
  "pulse": "auto_post"
}
```
Any lane touching tickers/market claims should never be `auto_post` on timeout.

On timeout: log `status: timed_out` to `actions_log`, send a passive notification (not a re-prompt, to avoid nagging) to the chat: "⏱ Draft expired unreviewed, discarded." Content is not deleted from the log — it stays for the weekly report to flag "how often are approvals timing out" as an operational signal.

---

## 7. Edge Cases & Failure Handling

| Edge Case | Handling |
|---|---|
| **OpenAI refuses / returns non-JSON / empty output** | `Function` node validates JSON schema before proceeding; on failure, retry once with a stricter re-prompt ("return valid JSON only"); on second failure, log to `error_log` with `node_failed: openai_generation`, notify operator via a separate ops Telegram chat (not the per-account approval chat), and end the run without posting. Do not retry indefinitely. |
| **CoinGecko API down / rate-limited (Pulse lane)** | If live data pull fails, do not fall back to model-invented numbers. Either skip the Pulse post for this slot (log `status: skipped, reason: no_data`) or reroute to a different lane for this slot. |
| **ChirpAPI post fails (network, auth, rate limit)** | Wrap in n8n's built-in error-handling (`Continue on Fail` + `IF` check on response) → retry with exponential backoff (e.g. 1x immediate retry, then log and stop — don't loop indefinitely) → log to `error_log` → notify operator. Approved-but-unposted content stays in `actions_log` as `status: approved` so it can be manually posted or requeued rather than silently lost. |
| **ChirpAPI auth/credential expired** | Detect via HTTP 401/403 response → immediately pause that account (`accounts_config.status = paused`) rather than retrying repeatedly against a dead credential → alert operator. |
| **Telegram webhook missed / n8n restarts mid-Wait** | n8n Wait nodes persist across restarts by design, but set a hard `hil_timeout_minutes` regardless so a missed webhook doesn't leave a draft pending indefinitely — it will resolve via the timeout branch (Section 6). |
| **Duplicate/near-duplicate content generated twice in a row** | Similarity check (Workflow 1, node 9) loops back for regeneration, capped at 2 retries; on 3rd failure to produce something sufficiently novel, skip this slot entirely and log `status: skipped, reason: dedupe_exhausted` rather than posting a near-duplicate. |
| **Mentions flood (e.g. account goes viral)** | `daily_counters.replies_today` check (Workflow 2, node 10) caps replies at the configured target; excess mentions get `status: deferred` and are re-surfaced the next day rather than silently dropped or causing runaway API spend. |
| **Rate limit hit mid-run (ChirpAPI or OpenAI)** | Catch the specific rate-limit error code, back off according to the API's `Retry-After` header if provided, otherwise a fixed delay (e.g. 60s) with one retry, then defer to next scheduled run. |
| **Two workflows for the same account overlap (e.g. content + engagement loop firing simultaneously)** | Not a practical conflict since they write to different `actions_log.type` values and different counters, but if both attempt to update `rotation_state` or shared config fields, use MongoDB's atomic `findOneAndUpdate` rather than read-then-write, to avoid race conditions. |
| **Regulatory/scam keyword detected** (hack, exploit, SEC, rug, delisted, exploit) | Hard keyword-match Function node runs on every generated draft regardless of lane; if matched, force `needs_human_review = true` AND tag the Telegram message with a "⚠️ FLAGGED — Regulatory/Security" prefix so the operator doesn't approve it on autopilot. |
| **Account paused mid-cycle** | Workflow 1/2 node 3 (`IF status != active`) checks on every single run, not just at startup — so pausing an account via the config doc takes effect on the very next scheduled tick, no need to stop/restart workflows manually. |
| **LLM generates a specific stat not present in the DATA block** | Function-based validator (regex for numeric patterns in `post_text`) cross-checks any number against the CoinGecko payload actually passed in; if a number appears in output that wasn't in input data, reject the draft and regenerate — don't let an unverified number reach the human approval stage looking "clean." |

---

## 8. API Failure / General Error-Handling Pattern (applies to every external call)

```
[Any external API node]
        │
   Continue on Fail: ON
        │
   IF (node output contains error)
        │
   ├── YES → Function: format error → MongoDB: insert error_log
   │             → Telegram (ops chat): alert
   │             → Switch: is this a hard-stop error (auth/credential)?
   │                  ├── YES → MongoDB: set account status = paused → END
   │                  └── NO  → Wait (backoff) → retry once → still fails? → log + END this run
   │
   └── NO  → continue normal path
```

---

## 9. Security Notes

- **API keys/tokens** (ChirpAPI, OpenAI, Telegram bot tokens) live only in **n8n's built-in credential manager**, never as plaintext fields inside MongoDB documents. `accounts_config` stores only credential *references* (IDs), as shown in Section 4.
- **MongoDB Atlas**: enable IP allowlisting restricted to your VPS's static IP; use a dedicated database user per environment (staging vs. production) with least-privilege roles (read/write only to the specific collections above, not admin).
- **n8n instance**: put it behind authentication (n8n's built-in user management or a reverse proxy with basic auth/SSO), and expose only the Telegram webhook endpoint publicly (via HTTPS, e.g. through Nginx/Caddy + Let's Encrypt) — the editor UI itself should not be internet-exposed without auth.
- **Per-account access control**: if multiple humans approve for different accounts, use separate Telegram bot tokens per account (not just separate chat IDs) so no one operator's Telegram account has approval authority over another account's chat by default.
- **Secrets rotation**: store credential IDs, not raw secrets, in version-controlled config exports if you ever export `accounts_config` for backup — never commit raw API keys to any repository.

---

## 10. Deployment Steps

1. **Provision VPS** [UNKNOWN — Open Question 6: exact provider/budget not specified; a 2–4 vCPU / 4–8GB RAM instance is generally sufficient for n8n + light workflow volume at this scale].
2. Install Docker + Docker Compose.
3. Deploy n8n via Docker Compose with a persistent volume for workflow data and an environment-variable-based `.env` file for base config (not secrets — those go in n8n's credential store post-install).
4. Set up a reverse proxy (Caddy or Nginx) with automatic HTTPS for the n8n domain and the Telegram webhook path.
5. Create MongoDB Atlas cluster (free tier is fine for launch volume), configure IP allowlist to the VPS's IP, create the five collections from Section 4 with the schemas above.
6. In n8n, add credentials: OpenAI, ChirpAPI, MongoDB connection string, Telegram bot token(s).
7. Import/build the four workflows (Sections 2).
8. Insert the first `accounts_config` document for @WIZARD_BSC manually via MongoDB Compass or a one-off n8n workflow.
9. Set up the Telegram bot(s) via BotFather, get the chat ID(s), store in the config doc.
10. Run Workflow 1 and 2 manually (not on cron) against a **test/staging Twitter account** first (Section 11).
11. Once stable, enable the Cron triggers for production accounts one at a time, starting with the lowest-risk lanes.

---

## 11. Testing Plan

1. **Staging account first**: create a throwaway/test X account, point ChirpAPI credentials at it, and run the full pipeline end-to-end before touching @WIZARD_BSC.
2. **Dry-run mode**: add a global `DRY_RUN` flag in `accounts_config` — when true, the final ChirpAPI posting node is replaced by a no-op that logs "would have posted: {content}" instead of actually posting. Use this to validate generation, dedupe, and HIL flow without any live posting risk.
3. **Mock mention injection**: manually insert a fake mention document (or use a test tweet on the staging account) to trigger Workflow 2 and confirm reply generation + HIL + logging work end-to-end.
4. **Guardrail test cases**: manually feed prompts designed to try to elicit a price prediction, a fabricated statistic, or a missing disclaimer, and confirm the Function-node validators catch them before reaching Telegram.
5. **Timeout test**: set `hil_timeout_minutes` very low (e.g. 1 minute) temporarily and confirm the discard path fires and logs correctly.
6. **Failure injection**: temporarily point ChirpAPI credential to an invalid key to confirm the pause-on-auth-failure path (Section 7) works instead of retry-looping.
7. **Multi-account isolation test**: run two test account configs simultaneously, confirm no cross-contamination of history, counters, or Telegram approvals between them.
8. **Load/rate test**: simulate a mention flood (10+ mock mentions in one poll cycle) and confirm the daily counter cap defers rather than floods the Telegram approval chat or blows past reply targets.

---

## 12. Remaining Open Items Requiring Your Input

These weren't resolved by reasonable default and need an actual answer before full production rollout:

- **Image generation in v1**: recommend deferring to v2 — ship text-only posts first, add images once the core loop is validated (reduces initial build complexity and cost).
- **Exact VPS provider/budget**: needs your input.
- **Exact account list for Accounts 2/3**: needs your input; infrastructure supports them once defined.
- **Persona per account — shared or unique**: infrastructure supports either (persona lives in each account's own config doc); needs your decision.
- **Likes and retweets as automated actions**: flagging again — native like/retweet endpoints are Enterprise-only on X's official API as of April 2026. If ChirpAPI claims to offer these anyway, verify how before relying on it; I haven't built dedicated workflow steps for them pending that verification. Quote tweets (a post referencing another) are unaffected and are included in Workflow 2's pattern.