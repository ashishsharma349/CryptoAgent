# CryptoAgent MVP Design & Test Cases

This document outlines the Minimum Viable Product (MVP) for the Multi-Account AI Twitter Agent, breaking the system down into simpler, testable modules.

---

## Module 1: Data Ingestion (CoinGecko)
**Goal:** Fetch live trending market data to ground the AI's content in reality.
**Action:** n8n HTTP Request node calling the CoinGecko ping or trending endpoint.

### Test Cases:
- **[ ] Test 1.1 (Success):** Node successfully fetches data and outputs a JSON object containing trending coins/prices.
- **[ ] Test 1.2 (Failure):** Disconnect network or provide invalid API key. Verify the workflow catches the error instead of crashing.

---

## Module 2: AI Generation (OmniRoute)
**Goal:** Generate a JSON-formatted tweet draft using the local OmniRoute server.
**Action:** n8n HTTP Request node POSTing to `http://localhost:20128/v1/chat/completions` (Model: `my-combo`) passing the CoinGecko data in the prompt.

### Test Cases:
- **[ ] Test 2.1 (Success):** OmniRoute returns a valid JSON response containing `post_text` and `needs_human_review` flags.
- **[ ] Test 2.2 (Context Check):** Verify the generated `post_text` explicitly mentions a coin/stat provided by Module 1 (no hallucinated tickers).
- **[ ] Test 2.3 (Failure):** Stop the OmniRoute server. Verify n8n catches the `ECONNREFUSED` error gracefully.

---

## Module 3: Human-in-the-Loop (Telegram)
**Goal:** Pause the workflow and wait for operator approval via Telegram inline buttons.
**Action:** n8n Telegram node sends the draft with "Approve" / "Reject" buttons. An n8n Wait node listens for the webhook callback.

### Test Cases:
- **[ ] Test 3.1 (Delivery):** Trigger workflow; verify a message with the exact draft text and buttons appears in the designated Telegram chat.
- **[ ] Test 3.2 (Approve Flow):** Click "Approve". Verify the n8n Wait node resumes and routes to the Success/Logging path.
- **[ ] Test 3.3 (Reject Flow):** Click "Reject". Verify the workflow routes to the discard path and stops.

---

## Module 4: Logging & Mock Output (MongoDB)
**Goal:** Prove the end-to-end pipeline without needing a live Twitter API by saving the approved action to the database.
**Action:** n8n MongoDB node inserts a record into the `actions_log` collection.

### Test Cases:
- **[ ] Test 4.1 (Success Log):** After clicking "Approve" in Telegram, check MongoDB. Verify a new document exists in `actions_log` with `status: "approved"`, `content_text`, and a timestamp.
- **[ ] Test 4.2 (Reject Log):** After clicking "Reject" in Telegram, verify MongoDB logs the action as `status: "rejected"`.
