FROM node:22-alpine
WORKDIR /app
COPY bot.mjs .
CMD ["node", "bot.mjs"]
