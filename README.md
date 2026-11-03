# Railway Telegram Bot — Vyce AI API

Free $50 credits, 42+ models (Claude, GPT, DeepSeek, Gemini, Grok), OpenAI-compatible.

## Railway env vars

Required (set in Railway dashboard → Variables):

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `VYCE_API_KEY` | your Vyce AI API key |

Optional:

| Variable | Default |
|----------|---------|
| `VYCE_MODEL` | `beam-1.0` |
| `VYCE_BASE_URL` | `https://vyceai.com/v1` |
| `MAX_OUTPUT_TOKENS` | `4096` |
| `CONTEXT_TURNS` | `20` |
| `PER_USER_RPM` | `10` |
| `GLOBAL_RPM` | `30` |
| `ALLOWED_USERS` | (empty = anyone) |
| `SYSTEM_PROMPT` | helpful assistant |
| `SHOW_TOKEN_INFO` | `true` |

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | help |
| `/clear` | clear chat history |
| `/savenote <text>` | save a note |
| `/notes` | view all notes |
| `/clearnotes` | clear all notes |
| `/usage` | token usage |
| `/model` | current model |

## Deploy

1. Push to GitHub (already done)
2. Railway → New Project → Deploy from GitHub repo
3. Set `TELEGRAM_BOT_TOKEN` and `VYCE_API_KEY` in Variables
4. Auto-deploys and starts polling
