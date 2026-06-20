FROM oven/bun:1.2.21-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app
COPY deploy/dev/openshell-dev-control-plane/server.ts ./server.ts

CMD ["bun", "server.ts"]
