FROM oven/bun:1.2.21-alpine
WORKDIR /runtime
ENV NODE_ENV=production
COPY runtimes/openclaw-nemoclaw/package.json runtimes/openclaw-nemoclaw/tsconfig.json ./
COPY runtimes/openclaw-nemoclaw/src ./src
COPY runtimes/openclaw-nemoclaw/skills ./skills
COPY src/runtime-sdk/server.ts /src/runtime-sdk/server.ts
EXPOSE 8080
CMD ["bun", "src/index.ts"]
