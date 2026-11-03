# Railway Telegram Bot — Claude Code OAuth
#
# Deploy: railway up
# Or connect GitHub repo → Railway auto-deploys
#
# Required env vars (set in Railway dashboard):
#   TELEGRAM_BOT_TOKEN      — from @BotFather
#   CLAUDE_CODE_OAUTH_TOKEN — from `claude setup-token`
#
# Optional:
#   ALLOWED_USERS           — comma-separated Telegram user IDs
#   CLAUDE_MODEL            — default: claude-sonnet-4-20250514
#   WEEKLY_TOKEN_CAP        — default: 800000
#   PER_USER_RPM            — default: 10
#   GLOBAL_RPM              — default: 40
#   CONTEXT_TURNS           — default: 6
#   MAX_OUTPUT_TOKENS       — default: 2048
#   SYSTEM_PROMPT           — default: helpful assistant
#   SHOW_TOKEN_INFO         — default: true
