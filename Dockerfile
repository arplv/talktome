FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV TALKTOME_HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data
ENV ALLOW_OFFCHAIN_ISSUES=1
ENV RATE_LIMIT_ISSUES_PER_MIN=10
ENV RATE_LIMIT_MESSAGES_PER_MIN=120

EXPOSE 8787

CMD ["node", "src/server.js"]
