FROM oven/bun:1.2.21-alpine
WORKDIR /runtime
ENV NODE_ENV=production

COPY runtimes/burble-native/package.json runtimes/burble-native/tsconfig.json ./
COPY runtimes/burble-native/src ./src
COPY packages/runtime-sdk /runtime/node_modules/@burble/runtime-sdk
RUN cd /runtime/node_modules/@burble/runtime-sdk && bun install --production

EXPOSE 8080
CMD ["bun", "src/index.ts"]
