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
runtime_build_images=()
runtime_build_services=()
runtime_build_labels=()
previous_runtime_image_ids=()
current_runtime_image_ids=()

usage() {
  cat <<'USAGE'
Usage: ./deploy-personal-runtimes.sh [--no-pull] [--keep-runtimes] [--agentgateway]

Pulls the latest repo state, rebuilds Burble plus the default personal runtime
images, and restarts Docker Compose. Runtime containers are recycled only when
their image ID changes, and only for burble-rt-* containers from the matching
runtime image family whose running image ID differs from the current image ID.

Select a runtime with AGENT_RUNTIME_ENGINE. Supported image build defaults:
  AGENT_RUNTIME_ENGINE=openclaw  -> burble-openclaw-nemoclaw-openclaw-cli:dev
  AGENT_RUNTIME_ENGINE=hermes    -> burble-nemo-hermes:dev
  AGENT_RUNTIME_ENGINE=burble-native -> burble-native-runtime:dev

If AGENT_RUNTIME_IMAGE is set to a non-default custom image, only the selected
runtime engine image is rebuilt and recycled.

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

is_known_default_runtime_image() {
  case "$1" in
    burble-openclaw-nemoclaw:dev|burble-openclaw-nemoclaw-openclaw-cli:dev|burble-nemo-hermes:dev|burble-native-runtime:dev)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

select_runtime_image() {
  local default_image="$1"
  local configured_image="${AGENT_RUNTIME_IMAGE:-}"
  if [[ -z "${configured_image}" ]] || is_known_default_runtime_image "${configured_image}"; then
    export AGENT_RUNTIME_IMAGE="${default_image}"
  else
    export AGENT_RUNTIME_IMAGE="${configured_image}"
  fi
}

add_runtime_image_build() {
  runtime_build_labels+=("$1")
  runtime_build_images+=("$2")
  runtime_build_services+=("$3")
}

runtime_image_family() {
  case "$1" in
    hermes|nemo-hermes)
      echo "hermes"
      ;;
    burble-native)
      echo "burble-native"
      ;;
    ""|openclaw|openclaw-gateway|deterministic)
      echo "openclaw"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

container_runtime_engine() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null |
    awk -F= '$1 == "AGENT_RUNTIME_ENGINE" { print $2; exit }'
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
configured_runtime_image="${AGENT_RUNTIME_IMAGE:-}"
custom_runtime_image=false
if [[ -n "${configured_runtime_image}" ]] && ! is_known_default_runtime_image "${configured_runtime_image}"; then
  custom_runtime_image=true
fi

case "${runtime_engine}" in
  hermes|nemo-hermes)
    export AGENT_RUNTIME_ENGINE=hermes
    select_runtime_image "burble-nemo-hermes:dev"
    selected_runtime_image_service="nemo-hermes-image"
    selected_runtime_image_label="$(runtime_image_family "${AGENT_RUNTIME_ENGINE}")"
    ;;
  burble-native)
    export AGENT_RUNTIME_ENGINE=burble-native
    select_runtime_image "burble-native-runtime:dev"
    selected_runtime_image_service="burble-native-image"
    selected_runtime_image_label="$(runtime_image_family "${AGENT_RUNTIME_ENGINE}")"
    ;;
  ""|openclaw|openclaw-gateway|deterministic)
    select_runtime_image "burble-openclaw-nemoclaw-openclaw-cli:dev"
    selected_runtime_image_service="openclaw-nemoclaw-image"
    selected_runtime_image_label="$(runtime_image_family "${AGENT_RUNTIME_ENGINE:-openclaw}")"
    ;;
  *)
    echo "Unsupported AGENT_RUNTIME_ENGINE: ${runtime_engine}" >&2
    echo "Expected openclaw, openclaw-gateway, hermes, burble-native, or deterministic." >&2
    exit 2
    ;;
esac

if [[ "${custom_runtime_image}" == "true" ]]; then
  add_runtime_image_build "${selected_runtime_image_label}" "${AGENT_RUNTIME_IMAGE}" "${selected_runtime_image_service}"
else
  add_runtime_image_build "openclaw" "burble-openclaw-nemoclaw-openclaw-cli:dev" "openclaw-nemoclaw-image"
  add_runtime_image_build "hermes" "burble-nemo-hermes:dev" "nemo-hermes-image"
  add_runtime_image_build "burble-native" "burble-native-runtime:dev" "burble-native-image"
fi

for i in "${!runtime_build_images[@]}"; do
  previous_runtime_image_ids+=("$(image_id "${runtime_build_images[$i]}")")
done

for i in "${!runtime_build_images[@]}"; do
  echo "Building personal runtime image: ${runtime_build_images[$i]} (${runtime_build_labels[$i]}; ${runtime_build_services[$i]})"
  AGENT_RUNTIME_IMAGE="${runtime_build_images[$i]}" docker compose "${compose_files[@]}" --profile runtime-image build "${runtime_build_services[$i]}"
  current_runtime_image_ids+=("$(image_id "${runtime_build_images[$i]}")")
done

docker compose "${compose_files[@]}" up -d --build

if [[ "${use_agentgateway}" == "true" ]]; then
  docker compose "${compose_files[@]}" up -d --force-recreate --no-deps agentgateway
fi

if [[ "${recycle_runtimes}" == "true" ]]; then
  runtime_images_changed=false
  for i in "${!runtime_build_images[@]}"; do
    previous_runtime_image_id="${previous_runtime_image_ids[$i]}"
    current_runtime_image_id="${current_runtime_image_ids[$i]}"
    if [[ -z "${previous_runtime_image_id}" || "${previous_runtime_image_id}" == "${current_runtime_image_id}" ]]; then
      continue
    fi

    runtime_images_changed=true
    runtime_image_family_label="$(runtime_image_family "${runtime_build_labels[$i]}")"
    mapfile -t runtime_containers < <(
      docker ps -aq --filter "name=burble-rt-" |
        while IFS= read -r container_id; do
          container_image_id="$(docker inspect --format '{{.Image}}' "${container_id}" 2>/dev/null || true)"
          container_engine="$(container_runtime_engine "${container_id}")"
          container_image_family="$(runtime_image_family "${container_engine}")"

          if [[ -n "${container_engine}" && "${container_image_family}" == "${runtime_image_family_label}" && "${container_image_id}" != "${current_runtime_image_id}" ]]; then
            echo "${container_id}"
            continue
          fi

          if [[ -z "${container_engine}" && -n "${previous_runtime_image_id}" && "${container_image_id}" == "${previous_runtime_image_id}" ]]; then
            echo "${container_id}"
          fi
        done
    )
    if [[ "${#runtime_containers[@]}" -gt 0 ]]; then
      echo "Runtime image changed for ${runtime_build_images[$i]}; recycling ${#runtime_containers[@]} runtime container(s) from previous image."
      docker stop "${runtime_containers[@]}" >/dev/null || true
      docker rm "${runtime_containers[@]}" >/dev/null || true
    else
      echo "Runtime image changed for ${runtime_build_images[$i]}, but no burble-rt-* containers use the previous image."
    fi
  done

  if [[ "${runtime_images_changed}" == "false" ]]; then
    echo "Runtime images unchanged; keeping existing burble-rt-* containers."
  else
    echo "Finished recycling changed runtime images."
  fi
else
  echo "Keeping existing burble-rt-* containers because --keep-runtimes was set."
fi

docker compose "${compose_files[@]}" ps
echo
echo "Tail logs with:"
echo "docker compose ${compose_files[*]} logs -f burble-app agentgateway"
