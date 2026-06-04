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
image, and restarts Docker Compose. Runtime containers are recycled only when
the selected runtime image ID changes, and only for burble-rt-* containers that
were created from the previous image ID.

Select a runtime with AGENT_RUNTIME_ENGINE. Supported image build defaults:
  AGENT_RUNTIME_ENGINE=openclaw  -> burble-openclaw-nemoclaw-openclaw-cli:dev
  AGENT_RUNTIME_ENGINE=hermes    -> burble-nemo-hermes:dev

Options:
  --no-pull         Skip git pull --ff-only
  --keep-runtimes  Do not stop/remove existing burble-rt-* containers, even
                   when the selected runtime image changes
  --agentgateway    Include the agentgateway MCP compose override
USAGE
}

image_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
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

previous_runtime_image_id="$(image_id "${AGENT_RUNTIME_IMAGE}")"
echo "Building personal runtime image: ${AGENT_RUNTIME_IMAGE} (${AGENT_RUNTIME_ENGINE:-openclaw}; ${runtime_image_service})"
docker compose "${compose_files[@]}" --profile runtime-image build "${runtime_image_service}"
current_runtime_image_id="$(image_id "${AGENT_RUNTIME_IMAGE}")"
docker compose "${compose_files[@]}" up -d --build

if [[ "${use_agentgateway}" == "true" ]]; then
  docker compose "${compose_files[@]}" up -d --force-recreate --no-deps agentgateway
fi

if [[ "${recycle_runtimes}" == "true" ]]; then
  if [[ -n "${previous_runtime_image_id}" && "${previous_runtime_image_id}" != "${current_runtime_image_id}" ]]; then
    mapfile -t runtime_containers < <(
      docker ps -aq --filter "name=burble-rt-" |
        while IFS= read -r container_id; do
          if [[ "$(docker inspect --format '{{.Image}}' "${container_id}" 2>/dev/null || true)" == "${previous_runtime_image_id}" ]]; then
            echo "${container_id}"
          fi
        done
    )
    if [[ "${#runtime_containers[@]}" -gt 0 ]]; then
      echo "Runtime image changed; recycling ${#runtime_containers[@]} runtime container(s) from previous image."
      docker stop "${runtime_containers[@]}" >/dev/null || true
      docker rm "${runtime_containers[@]}" >/dev/null || true
    else
      echo "Runtime image changed, but no burble-rt-* containers use the previous image."
    fi
  else
    echo "Runtime image unchanged; keeping existing burble-rt-* containers."
  fi
else
  echo "Keeping existing burble-rt-* containers because --keep-runtimes was set."
fi

docker compose "${compose_files[@]}" ps
echo
echo "Tail logs with:"
echo "docker compose ${compose_files[*]} logs -f burble-app agentgateway"
