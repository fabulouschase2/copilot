# Copilot v0.1.1 — API Key Setup Guide

This document explains how to obtain an API key from each supported provider and enter it into Copilot.

---

## Before You Begin

- **Copilot only works with the OpenAI-compatible chat API** (`/chat/completions` with Server-Sent Events). Not every AI service exposes this endpoint.
- **A website subscription is not an API key.** ChatGPT Plus ($20/mo) and Claude Pro do **not** give you API access. You must sign up for the provider's developer platform separately.
- **Costs vary.** Some providers offer a free tier with limited usage; others are pay-as-you-go. See each section below.
- **Never paste your API key into this document, GitHub, or any public forum.** This guide uses placeholder values like `YOUR_API_KEY_HERE`.

---

## Google Gemini (Free Tier Recommended)

**Website:** https://aistudio.google.com  
**Pricing:** Free tier available (rate-limited); paid tier via Vertex AI.

### Step 1 — Create an API Key
1. Go to https://aistudio.google.com/app/apikey
2. Sign in with your Google account.
3. Click **Create API Key** → a dialog shows your key (looks like `AIzaSyD…`).
4. Click **Copy** and save it somewhere safe.

### Step 2 — Add the Provider in Copilot
1. Open Copilot → click **⚙ Setup** (top right).
2. Click the **Providers** tab.
3. Click **+ Add chat provider**.
4. Fill in:
   - **Label:** `Gemini`
   - **Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai`
   - **Model:** `gemini-flash-latest`
   - ✅ Check **Vision** (eye icon) for screen analysis support
   - ✅ Check **On**
5. Paste your API key into the key field.
6. Click **Test connection** — you should see a green badge showing latency.
7. Click the radio button next to the provider to activate it.

### Step 3 — Verify It Works
1. Close Setup.
2. Type "Hello, what is 2+2?" in the chat box and press Enter.
3. You should see a streamed response within a few seconds.

> **Note:** The Gemini free tier is subject to rate limits (roughly 15–60 requests per minute). If you see "429 Rate limited", wait a moment and try again.

---

## OpenAI (Paid)

**Website:** https://platform.openai.com  
**Pricing:** Pay-per-token. Add funds to your account at https://platform.openai.com/account/billing.

### Step 1 — Create an API Key
1. Go to https://platform.openai.com/api-keys
2. Click **+ Create new secret key**.
3. Name it (e.g., "Copilot") and click **Create secret key**.
4. Copy the key immediately — it starts with `sk-` and cannot be viewed again.

### Step 2 — Add the Provider in Copilot
1. Setup → Providers → **+ Add chat provider**.
2. Fill in:
   - **Label:** `OpenAI`
   - **Base URL:** `https://api.openai.com/v1`
   - **Model:** `gpt-4o-mini` (cheapest) or `gpt-4o`
   - ✅ Check **Vision** if using screen analysis
   - ✅ Check **On**
3. Paste the `sk-…` key → click **Test connection**.

### Step 3 — Verify
Ask a question in chat. The response should stream within 1–3 seconds.

> **Billing note:** `gpt-4o-mini` costs approximately $0.15 per million input tokens. A typical conversation uses well under 1,000 tokens — roughly $0.0002.

---

## Groq (Fast + Free Quota)

**Website:** https://groq.com  
**Pricing:** Generous free tier; paid plans for higher usage.

### Step 1 — Create an API Key
1. Go to https://console.groq.com/keys
2. Sign in (Google or GitHub).
3. Click **+ Add API Key** → copy the key.

### Step 2 — Add the Provider in Copilot
1. Setup → Providers → **+ Add chat provider**.
2. Fill in:
   - **Label:** `Groq`
   - **Base URL:** `https://api.groq.com/openai/v1`
   - **Model:** `llama-3.1-8b-instant`
   - Leave **Vision** unchecked (Groq's models don't support images yet)
   - ✅ Check **On**
3. Paste the key → **Test connection**.

### Step 3 — Verify
Ask a coding question. Groq is typically very fast (sub-second responses).

---

## OpenRouter (Broadest Model Selection)

**Website:** https://openrouter.ai  
**Pricing:** Pay-per-token across many providers; some models are free.

### Step 1 — Create an API Key
1. Go to https://openrouter.ai/keys
2. Sign in and click **+ Generate New Key**.
3. Copy the key.

### Step 2 — Add the Provider in Copilot
1. Setup → Providers → **+ Add chat provider**.
2. Fill in:
   - **Label:** `OpenRouter`
   - **Base URL:** `https://openrouter.ai/api/v1`
   - **Model:** `openai/gpt-4o-mini` or any model listed on openrouter.ai
   - ✅ Check **On**
3. Paste the key → **Test connection**.

---

## Ollama (Local, Completely Free)

**Website:** https://ollama.com  
**Pricing:** Free — runs entirely on your machine. No API key needed.

### Step 1 — Install Ollama
1. Download from https://ollama.com/download
2. Run the installer and follow the prompts.
3. Open a terminal and verify: `ollama --version`

### Step 2 — Pull a Model
```bash
ollama pull llama3.1
```
This downloads ~4 GB. You can also pull smaller models like `llama3.1:8b` or larger ones like `llama3.1:70b`.

### Step 3 — Add the Provider in Copilot
1. Ollama runs automatically on startup. Verify with:
   ```bash
   curl http://localhost:11434/v1/models
   ```
2. In Copilot → Setup → Providers → **+ Add chat provider**:
   - **Label:** `Ollama`
   - **Base URL:** `http://localhost:11434/v1`
   - **Model:** `llama3.1`
   - Leave **Vision** unchecked (unless using a vision-capable model)
   - ✅ Check **On**
3. Leave the key field **empty**.
4. Click **Test connection** — should show "Connected".

### Step 4 — Verify
Ask a question. Responses are slower than cloud providers (depends on your hardware) but completely private.

---

## LM Studio (Local, Completely Free)

**Website:** https://lmstudio.ai  
**Pricing:** Free — runs entirely on your machine.

### Step 1 — Install LM Studio
1. Download from https://lmstudio.ai
2. Run the installer.
3. Open LM Studio and download a model (e.g., `llama-3.1-8b-instruct`).

### Step 2 — Start the Local Server
1. In LM Studio, go to the **Local Server** tab (left sidebar).
2. Select your model and click **Start Server**.
3. Note the port (default is `1234`).

### Step 3 — Add the Provider in Copilot
1. Setup → Providers → **+ Add chat provider**:
   - **Label:** `LM Studio`
   - **Base URL:** `http://localhost:1234/v1`
   - **Model:** the exact model name shown in LM Studio (e.g., `llama-3.1-8b-instruct`)
   - ✅ Check **On**
2. Leave the key field **empty**.
3. Click **Test connection**.

---

## Saving and Managing API Keys

### How keys are stored
- Keys are stored in `%APPDATA%\copilot\credentials.json`.
- They are encrypted using Windows DPAPI (your Windows login password is the encryption key).
- The plaintext key is never written to disk.
- The renderer process (the visible UI) never sees the key — it only sends the provider ID to the main process, which injects the key at request time.

### How to change a key
1. Go to Setup → Providers.
2. Find the provider in the list.
3. Type the new key in the key field.
4. Click away from the field (blur it) — the key saves automatically on blur.
5. Click **Test connection** to verify the new key works.

### How to remove a key
1. In Setup → Providers, find the provider.
2. Clear the key field completely.
3. Click away — the key is removed.
4. Or use the ✕ button to delete the entire provider row.

### How to switch providers
Click the radio button next to the provider you want to use. The next chat message will use that provider. You can add multiple providers and switch freely.

---

## Troubleshooting Provider Issues

| Error | Cause | Fix |
|---|---|---|
| `Authentication failed — check the API key` | Wrong key, expired key, or insufficient quota | Re-check the key at the provider's console. For Gemini, ensure you created the key at AI Studio, not a regular Google account. |
| `Endpoint or model not found (404)` | Wrong model name or base URL | Double-check the model string. Try `gemini-flash-latest` instead of a pinned version. Verify the base URL has no trailing slash. |
| `Rate limited (429)` | Quota exhausted | Wait 30–60 seconds and retry. Free tiers have strict per-minute limits. |
| `Could not reach provider` | Network issue or wrong URL | Check your internet. For local providers, ensure the server is running. |
| `Provider responded with HTTP 5xx` | Provider-side outage | Wait a few minutes and retry. Check the provider's status page. |
| Test connection shows "Connected" but chat fails | Model name mismatch | The `/models` endpoint lists available models — use the exact name shown. |

---

## Quick Reference Card

| Provider | Base URL | Example Model | Free? | Vision? |
|---|---|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-flash-latest` | ✅ | ✅ |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | ❌ | ✅ |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.1-8b-instant` | ⚠️ Quota | ❌ |
| OpenRouter | `https://openrouter.ai/api/v1` | varies | ⚠️ Some free | ✅ |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.1` | ✅ | Varies |
| LM Studio (local) | `http://localhost:1234/v1` | varies | ✅ | Varies |
