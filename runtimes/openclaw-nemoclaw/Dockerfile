FROM oven/bun:1.2.21-alpine
WORKDIR /runtime
ENV NODE_ENV=production
COPY runtimes/openclaw-nemoclaw/package.json runtimes/openclaw-nemoclaw/tsconfig.json ./
COPY runtimes/openclaw-nemoclaw/src ./src
COPY runtimes/openclaw-nemoclaw/skills ./skills
COPY packages/runtime-sdk /runtime/node_modules/@burble/runtime-sdk
RUN cd /runtime/node_modules/@burble/runtime-sdk && bun install --production
RUN echo 'sandbox:x:1000660000:' >> /etc/group \
  && echo 'sandbox:x:1000660000:1000660000:OpenShell sandbox:/runtime:/bin/sh' >> /etc/passwd \
  && mkdir -p /runtime/config /runtime/state /runtime/workspace \
  && chown -R 1000660000:1000660000 /runtime
EXPOSE 8080
CMD ["bun", "src/index.ts"]
