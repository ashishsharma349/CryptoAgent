## 2026-09-14 12:10 PM IST

**Summary:** Discovered and verified a working X (Twitter) automation method bypassing Cloudflare and login rate-limits.
**Files modified:** None (Created scratch script `scripts/test_puppeteer_cookies.ts`)
**What was done:** Proved that using Puppeteer + Stealth Plugin with directly injected `auth_token` and `ct0` cookies works. The script bypasses the login screen entirely, navigates to the compose UI, and types/clicks to post tweets just like a human.
**Why it was done:** The unofficial API libraries (`agent-twitter-client`) are currently broken due to X deprecating endpoints (Code 34). Additionally, trying to have Puppeteer type the username/password triggers an immediate "temporarily limited your login" block. Cookie injection avoids the login flow completely.

**Method Reference (How it works):**
1. Launch `puppeteer` with `puppeteer-extra-plugin-stealth` in headless mode.
2. Read `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` from the `.env` file (these must be manually extracted from a logged-in Chrome session by the user).
3. Inject these cookies directly into the Puppeteer context for domains `.x.com` and `.twitter.com` before navigating anywhere.
4. Navigate directly to `https://x.com/compose/tweet` (bypassing `/login` entirely).
5. Wait for the DOM, find the `[data-testid="tweetTextarea_0"]` element, type the text via keyboard events, and click `[data-testid="tweetButton"]`.
6. This effectively tricks X into seeing a normal, active session executing UI clicks, immune to API rate limits and fingerprinting.

**Note for next session:** The next step is to build the actual `PuppeteerTwitterAdapter` implementing the 5 core actions (Post, Reply, Quote, Fetch Mentions, Fetch Target Accounts) using this DOM manipulation technique. The system relies on the user manually pulling fresh cookies from their Chrome browser and placing them in `.env` whenever X expires the session.
