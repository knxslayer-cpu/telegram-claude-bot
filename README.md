# Railway Telegram Bot — Anthropic API Key

Deploy: railway up
Or connect GitHub repo → Railway auto-deploys

Required env vars (set in Railway dashboard):
  TELEGRAM_BOT_TOKEN      — from @BotFather
  ANTHROPIC_API_KEY       — from https://console.anthropic.com/settings/keys

Optional:
  ALLOWED_USERS           — comma-separated Telegram user IDs
  CLAUDE_MODEL            — default: claude-sonnet-4-20250514
  MAX_OUTPUT_TOKENS       — default: 2048
  SYSTEM_PROMPT           — default: helpful assistant
  PER_USER_RPM            — default: 10
  GLOBAL_RPM              — default: 40
  CONTEXT_TURNS           — default: 6
  SHOW_TOKEN_INFO         — default: true
  STATE_FILE              — default: unset (ephemeral in-memory)

Anthropic free tier gives $5 API credit. After it runs out, add billing or the API calls will fail.
