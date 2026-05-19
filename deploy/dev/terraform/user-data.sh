#!/bin/bash
# cloud-init for the Burble dev host. Bare minimum to land on a host with
# docker + docker compose available; the actual stack is brought up by
# the operator following the steps in outputs.next_steps.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl git gnupg

# Docker from Docker's own apt repo, signed-by their gpg key. Ubuntu's
# distro `docker.io` package lags badly and doesn't ship the compose v2
# plugin under the name `docker-compose-plugin`.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# Canonical Ubuntu AMIs ship snapd and the amazon-ssm-agent snap by
# default since 18.04. Keep it explicit so a future image change can't
# leave us locked out.
snap install amazon-ssm-agent --classic || true
snap start amazon-ssm-agent || true
