FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p uploads tmp_uploads \
    && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=5002

EXPOSE 5002

USER node

CMD ["node", "server.js"]