FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source and data
COPY src ./src
COPY drizzle.config.ts ./
COPY data ./data

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
