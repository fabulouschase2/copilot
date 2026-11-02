# Copilot v0.1.1 — User Guide

Copilot is a desktop AI copilot for interviews and meetings. It listens to conversations, analyzes your screen, stores documents and profile facts locally, and uses any OpenAI-compatible AI provider to generate answers, summaries, and notes — all without sending your data to the cloud except to the provider you choose.

This guide assumes you are new to AI APIs. Follow it from top to bottom and you should be able to configure Copilot without asking for help.

---

## 1. What Copilot Does

- **Live transcription** — records your mic or system audio, transcribes it in real time (requires an STT provider key).
- **Chat with context** — you type a question, Copilot attaches relevant documents, profile facts, and the current transcript, then streams an answer from your chosen AI provider.
- **Interview mode** — detect questions from the live transcript and generate answers in STAR, Coding, Concise, Detailed, Technical, or Research style.
- **Meeting mode** — generate summaries and extract action items (owners/deadlines appear only when stated in the transcript).
- **Screen analysis** — take a one-shot screenshot and ask an AI model to describe or explain what is on screen.
- **Local knowledge** — import PDF / TXT / MD documents, write profile facts, and keep them private on your machine.

### What requires an API key
- Every AI feature (chat, interview answers, meeting summaries, screen analysis) needs a configured chat provider.
- Transcription needs a separate STT provider.
- Some providers (Gemini free tier, Ollama, LM Studio) are free; others (OpenAI, Groq, OpenRouter) charge per token.

### What does not require a key
- The app itself installs and runs. You can view the UI, manage documents, and configure settings before adding a provider.
- Local storage (documents, profile facts, meeting notes) is always SQLite on disk — no cloud dependency.

---

## 2. Installation

### Prerequisites
- Windows 10 or 11 (64-bit)
- At least 2 GB of free disk space
- An active internet connection (required for AI provider calls)

### Install from the `.exe` installer
1. Download `Copilot-Setup-0.1.1.exe` from the GitHub releases page (see [Download](#download)).
2. Double-click the file. If Windows SmartScreen shows a warning, click **More info** → **Run anyway**.
3. Follow the installer prompts. The app installs to `C:\Program Files\Copilot\` by default and adds a Start Menu shortcut.
4. Launch Copilot from **Start → Copilot**.

### First launch
On first launch Copilot opens to the **Interview** view. It will look empty because no provider is configured yet — follow Section 3 to set one up.

---

## 3. Configure Your First AI Provider

### Supported providers
Copilot accepts any provider that implements the OpenAI chat-completions API (`POST /chat/completions` with SSE streaming). The most common are:

| Provider | Base URL | Free tier? | Notes |
|---|---|---|---|
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | ✅ Yes (limited) | Use `gemini-flash-latest` or `gemini-2.5-flash`. Vision works. |
| **OpenAI** | `https://api.openai.com/v1` | ❌ Paid | Use `gpt-4o-mini` or `gpt-4o`. |
| **Groq** | `https://api.groq.com/openai/v1` | ⚠️ Free quota | Fast inference; use `llama-3.1-8b-instant`. |
| **OpenRouter** | `https://openrouter.ai/api/v1` | ⚠️ Some free models | Broadest model selection. |
| **Ollama (local)** | `http://localhost:11434/v1` | ✅ Free | Runs entirely offline. Pull a model first: `ollama pull llama3.1`. |
| **LM Studio (local)** | `http://localhost:1234/v1` | ✅ Free | Runs entirely offline. Start the local server in LM Studio. |

> **Important:** ChatGPT (chat.openai.com), Claude.ai, and Gemini (gemini.google.com) are *web products*. They are **not** API endpoints. You must obtain an API key from the provider's developer console — see the links below for step-by-step instructions.

### Step-by-step: Google Gemini (free tier)
1. Go to https://aistudio.google.com/app/apikey and sign in with your Google account.
2. Click **Create API Key** → copy the key (it looks like `AIza…`).
3. Open Copilot. Click the **⚙ Setup** button (top right).
4. In the **Providers** tab, click **+ Add chat provider**.
5. Fill in:
   - **Label:** `Gemini`
   - **Base URL:** `https://generativelanguage.googleapis.com/v1beta/openai`
   - **Model:** `gemini-flash-latest`
   - ✅ Check **Vision** (the eye icon) if you plan to use screen analysis
   - ✅ Check **On** to enable the provider
6. Paste your API key into the **key** field on the same row. The field blurs when you click away — that saves the key automatically.
7. Click **Test connection**. You should see a green "Connected · X ms" badge.
8. Click the radio button next to this provider to make it the active one.
9. Close the Setup panel. You are ready to chat.

### Step-by-step: OpenAI (paid)
1. Go to https://platform.openai.com/api-keys and sign in.
2. Click **+ Create new secret key** → copy the key (starts with `sk-…`).
3. In Copilot Setup → Providers → **+ Add chat provider**:
   - **Label:** `OpenAI`
   - **Base URL:** `https://api.openai.com/v1`
   - **Model:** `gpt-4o-mini` (cheapest) or `gpt-4o`
   - ✅ **On**, optional ✅ **Vision**
4. Paste the key and click **Test connection**.

### Step-by-step: Ollama (local, no key needed)
1. Install Ollama from https://ollama.com if you haven't already.
2. Open a terminal and run: `ollama pull llama3.1` (or another model).
3. In Copilot Setup → Providers → **+ Add chat provider**:
   - **Label:** `Ollama`
   - **Base URL:** `http://localhost:11434/v1`
   - **Model:** `llama3.1`
   - ✅ **On** (leave Vision unchecked unless using a vision model)
4. Leave the key field empty — Ollama does not require one.
5. Click **Test connection**. You should see "Connected".

### Step-by-step: Groq (fast, free quota)
1. Go to https://console.groq.com/keys and create a key.
2. In Copilot Setup:
   - **Label:** `Groq`
   - **Base URL:** `https://api.groq.com/openai/v1`
   - **Model:** `llama-3.1-8b-instant`
   - Paste the key → Test connection.

---

## 4. How to Use Copilot

### Sending a message
1. Type a question in the chat input at the bottom of the Interview view.
2. Press **Enter** (or click Send). Copilot streams the response word by word.
3. While streaming, press **Stop** to cancel. Press **Copy** to copy the answer.

### Using interview mode
1. Start a live transcription session (click **Live** in the top nav → choose Mic or System → **Start**).
2. Speak naturally; Copilot detects questions from the transcript and shows them as pills.
3. Click a detected question, pick a style (**STAR**, **Coding**, **Concise**, etc.), and press **Answer**.
4. The answer cites which document or fact it used. If your resume does not contain the relevant experience, Copilot will say so rather than inventing an answer.

### Using meeting mode
1. With an active transcription running, click **Meetings** in the top nav.
2. Click **Summarize meeting** to generate a summary, or **Extract action items** for a list.
3. Owners and deadlines appear only when explicitly stated in the transcript; otherwise they show "(not stated)".
4. Edit the generated notes, then click **Export** to save as Markdown or plain text.

### Screen analysis
1. Click the **🖥 Read screen** button (top bar).
2. A consent prompt appears — confirm once (valid for 5 minutes).
3. Describe what you want to know about the screen and press Enter.
4. Copilot captures the current screen, sends it to your vision-capable provider, and streams the observations.
5. Duplicate screens (same visual content) are skipped automatically — no provider call, no charge.

### Managing your knowledge
1. **Import documents:** Setup → Profile & context → **Import PDF / TXT / MD…**
2. **Add profile facts:** Type something like "6 years of TypeScript" and click **Add**.
3. **Job description:** Paste your target job description; it ranks alongside your resume for every interview answer.
4. **Exclude items:** Toggle the exclusion checkbox next to any document or fact in the Context view.

---

## 5. Security & Privacy

- **API keys are encrypted at rest** using Windows DPAPI (via Electron's `safeStorage`). The plaintext key never touches the renderer process and is never stored in any file readable by other applications.
- **Conversation content is not saved.** Only the final summarized notes you choose to export are persisted.
- **Documents and profile facts** are stored in a local SQLite database (`context.db`) in your user data folder. No copy leaves your machine except what you send to your configured provider.
- **Free-tier providers may use your data** for training. Do not paste confidential material into a free Gemini or OpenRouter account. Check the provider's terms.
- **No telemetry is sent** by Copilot. The app does not phone home for analytics.

---

## 6. Troubleshooting

### "Authentication failed — check the API key"
- The key is wrong, expired, or has insufficient quota. Re-check the provider console.
- For Gemini free tier: the key must be created at https://aistudio.google.com/app/apikey — a regular Google account login is not enough.

### "Endpoint or model not found (404)"
- The model name is wrong. Try `gemini-flash-latest` instead of a pinned model version that has been retired.
- For OpenAI: ensure you typed `gpt-4o-mini` exactly (case-sensitive).

### "Rate limited (429)"
- Your provider quota is exhausted. Wait a few minutes or upgrade your plan.
- Free tiers often have strict per-minute limits. Space out your requests.

### "Could not reach provider"
- Check your internet connection.
- For local providers (Ollama / LM Studio), make sure the server is running and the base URL is exactly `http://localhost:11434/v1` or `http://localhost:1234/v1`.

### "Screen analysis fails"
- Make sure the provider has **Vision** enabled (eye icon).
- Ensure the selected model supports image input (Gemini, GPT-4o, Claude).

### Settings or data missing after reinstall
- Your settings and SQLite database live in `%APPDATA%\copilot\` on Windows. Reinstalling the app does not delete this folder. If data is missing, the user profile may have been cleaned separately.

### Copilot won't open
- Close all instances (check the system tray for the Copilot icon and quit it).
- Delete `%APPDATA%\copilot\settings.json` and restart — the app will recreate it with defaults.

---

## 7. FAQ

**Q: Do I need to pay for Copilot?**
No. The app is free. You pay only for the AI provider you choose (if any). Ollama and LM Studio run locally at zero cost.

**Q: Can I use Copilot without an internet connection?**
Yes, if you configure a local provider (Ollama or LM Studio). Cloud providers require internet.

**Q: Is my conversation history saved?**
No. Each chat session is independent; there is no persistent history between launches unless you manually export notes.

**Q: Where are my documents stored?**
In `%APPDATA%\copilot\context.db` (SQLite). You can back up this file from Setup → Data → Back up now.

**Q: Can I use more than one provider?**
Yes. Add multiple providers in Setup → Providers and switch between them with the radio button.

**Q: Does Copilot record audio permanently?**
No. Audio is streamed to the STT provider and discarded. Only the resulting transcript text is kept, and only for the current session.

---

## 8. Get Help

If you encounter an issue not covered here:
1. Check the [GitHub issues page](https://github.com/fabulouschase2/copilot/issues).
2. When reporting a problem, include:
   - Your operating system and Copilot version (`0.1.1`)
   - The provider you are using
   - Any error message you see (never include your API key)
   - Steps to reproduce the issue
