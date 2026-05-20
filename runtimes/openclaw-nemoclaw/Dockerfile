FROM oven/bun:1.2.21-alpine
WORKDIR /runtime
ENV NODE_ENV=production
COPY package.json tsconfig.json ./
COPY src ./src
EXPOSE 8080
CMD ["bun", "src/index.ts"]
