FROM python:3.11-slim

ARG HERMES_AGENT_REF=main

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HERMES_HOME=/data/openclaw/hermes \
    BURBLE_HERMES_PLATFORM_PORT=8766 \
    BURBLE_HERMES_RUNTIME_PORT=8080 \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_ENGINE=chrome \
    AGENT_BROWSER_ARGS="--no-sandbox --disable-dev-shm-usage"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    nodejs \
    npm \
    chromium \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "hermes-agent[mcp,web,exa,firecrawl,parallel-web] @ git+https://github.com/NousResearch/hermes-agent.git@${HERMES_AGENT_REF}" \
    aiohttp \
    ddgs \
    websockets

RUN npm install -g --silent --ignore-scripts \
    "agent-browser@^0.26.0" \
    "@askjo/camofox-browser@^1.5.2"

WORKDIR /runtime

COPY hermes-plugins /runtime/hermes-plugins
COPY runtime/entrypoint.py /runtime/entrypoint.py

EXPOSE 8080 8766

ENTRYPOINT ["python", "/runtime/entrypoint.py"]
