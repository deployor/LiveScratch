FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --production

COPY . .

ENV PORT=3000
ENV NODE_ENV=production

CMD ["bun", "run", "index.js"]
