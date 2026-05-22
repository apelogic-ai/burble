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

usage() {
  cat <<'USAGE'
Usage: ./deploy-personal-runtimes.sh [--no-pull] [--keep-runtimes]

Pulls the latest repo state, rebuilds Burble plus the personal OpenClaw runtime
image, restarts Docker Compose, and removes existing burble-rt-* containers so
new DMs create runtimes with the latest image/env.

Options:
  --no-pull         Skip git pull --ff-only
  --keep-runtimes  Do not stop/remove existing burble-rt-* containers
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

docker compose "${compose_files[@]}" --profile runtime-image build openclaw-nemoclaw-image
docker compose "${compose_files[@]}" up -d --build

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
echo "docker compose -f docker-compose.yml -f docker-compose.personal-runtimes.yml logs -f burble-app"
