FROM python:3.11-slim

ARG HERMES_AGENT_REF=main

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HERMES_HOME=/data/openclaw/hermes \
    BURBLE_HERMES_PLATFORM_PORT=8766 \
    BURBLE_HERMES_RUNTIME_PORT=8080

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "hermes-agent[mcp] @ git+https://github.com/NousResearch/hermes-agent.git@${HERMES_AGENT_REF}" \
    aiohttp

WORKDIR /runtime

COPY hermes-plugins/burble-platform /runtime/hermes-plugins/burble-platform
COPY runtime/entrypoint.py /runtime/entrypoint.py

EXPOSE 8080 8766

ENTRYPOINT ["python", "/runtime/entrypoint.py"]
