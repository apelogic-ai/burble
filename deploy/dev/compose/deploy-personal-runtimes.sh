#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "${script_dir}" rev-parse --show-toplevel)"
compose_files=(
  -f docker-compose.yml
  -f docker-compose.personal-runtimes.yml
)

pull_latest=true
recycle_runtimes=true
use_agentgateway=false

usage() {
  cat <<'USAGE'
Usage: ./deploy-personal-runtimes.sh [--no-pull] [--keep-runtimes] [--agentgateway]

Pulls the latest repo state, rebuilds Burble plus the selected personal runtime
image, restarts Docker Compose, and removes existing burble-rt-* containers so
new DMs create runtimes with the latest image/env.

Select a runtime with AGENT_RUNTIME_ENGINE. Supported image build defaults:
  AGENT_RUNTIME_ENGINE=openclaw  -> burble-openclaw-nemoclaw-openclaw-cli:dev
  AGENT_RUNTIME_ENGINE=hermes    -> burble-nemo-hermes:dev

Options:
  --no-pull         Skip git pull --ff-only
  --keep-runtimes  Do not stop/remove existing burble-rt-* containers
  --agentgateway    Include the agentgateway MCP compose override
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)
      pull_latest=false
      shift
      ;;
    --keep-runtimes)
      recycle_runtimes=false
      shift
      ;;
    --agentgateway)
      use_agentgateway=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "${repo_root}"

if [[ "${pull_latest}" == "true" ]]; then
  git pull --ff-only
fi

cd "${script_dir}"

if [[ "${use_agentgateway}" == "true" ]]; then
  compose_files+=(
    -f docker-compose.agentgateway.yml
  )
fi

runtime_engine="${AGENT_RUNTIME_ENGINE:-openclaw}"
case "${runtime_engine}" in
  hermes|nemo-hermes)
    export AGENT_RUNTIME_ENGINE=hermes
    export AGENT_RUNTIME_IMAGE="${AGENT_RUNTIME_IMAGE:-burble-nemo-hermes:dev}"
    runtime_image_service="nemo-hermes-image"
    ;;
  ""|openclaw|openclaw-gateway|deterministic|burble-direct|direct-provider)
    export AGENT_RUNTIME_IMAGE="${AGENT_RUNTIME_IMAGE:-burble-openclaw-nemoclaw-openclaw-cli:dev}"
    runtime_image_service="openclaw-nemoclaw-image"
    ;;
  *)
    echo "Unsupported AGENT_RUNTIME_ENGINE: ${runtime_engine}" >&2
    echo "Expected openclaw, hermes, deterministic, or burble-direct." >&2
    exit 2
    ;;
esac

echo "Building personal runtime image: ${AGENT_RUNTIME_IMAGE} (${AGENT_RUNTIME_ENGINE:-openclaw}; ${runtime_image_service})"
docker compose "${compose_files[@]}" --profile runtime-image build "${runtime_image_service}"
docker compose "${compose_files[@]}" up -d --build

if [[ "${use_agentgateway}" == "true" ]]; then
  docker compose "${compose_files[@]}" up -d --force-recreate --no-deps agentgateway
fi

if [[ "${recycle_runtimes}" == "true" ]]; then
  mapfile -t runtime_containers < <(docker ps -aq --filter "name=burble-rt-")
  if [[ "${#runtime_containers[@]}" -gt 0 ]]; then
    docker stop "${runtime_containers[@]}" >/dev/null || true
    docker rm "${runtime_containers[@]}" >/dev/null || true
  fi
fi

docker compose "${compose_files[@]}" ps
echo
echo "Tail logs with:"
echo "docker compose ${compose_files[*]} logs -f burble-app agentgateway"
