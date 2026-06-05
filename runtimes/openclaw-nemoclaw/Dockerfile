FROM oven/bun:1.2.21-alpine
WORKDIR /runtime
ENV NODE_ENV=production
COPY runtimes/openclaw-nemoclaw/package.json runtimes/openclaw-nemoclaw/tsconfig.json ./
COPY runtimes/openclaw-nemoclaw/src ./src
COPY runtimes/openclaw-nemoclaw/skills ./skills
COPY packages/runtime-sdk /runtime/node_modules/@burble/runtime-sdk
RUN cd /runtime/node_modules/@burble/runtime-sdk && bun install --production
EXPOSE 8080
CMD ["bun", "src/index.ts"]
