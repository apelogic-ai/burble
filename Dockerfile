FROM oven/bun:1.2.21-alpine AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages/runtime-sdk/package.json ./packages/runtime-sdk/package.json
RUN bun install --frozen-lockfile

FROM oven/bun:1.2.21-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache docker-cli
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY packages/runtime-sdk ./packages/runtime-sdk
COPY src ./src
RUN mkdir -p /data /opt/openshell-cli
EXPOSE 3000
CMD ["bun", "src/index.ts"]
