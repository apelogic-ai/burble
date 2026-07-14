FROM oven/bun:1.2.21 AS bun

FROM debian:trixie-slim
WORKDIR /runtime
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iproute2 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

COPY runtimes/burble-native/package.json runtimes/burble-native/tsconfig.json ./
COPY runtimes/burble-native/src ./src
COPY packages/runtime-sdk /runtime/node_modules/@burble/runtime-sdk
RUN cd /runtime/node_modules/@burble/runtime-sdk && bun install --production
RUN groupadd --gid 1000660000 sandbox \
  && useradd --uid 1000660000 --gid 1000660000 --home-dir /runtime --shell /bin/sh sandbox \
  && mkdir -p /runtime/config /runtime/state /runtime/workspace /data/burble-native/config /data/burble-native/state /data/burble-native/workspace \
  && chown -R sandbox:sandbox /runtime /data/burble-native

EXPOSE 8080
CMD ["bun", "src/index.ts"]
