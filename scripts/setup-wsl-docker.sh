#!/usr/bin/env bash
# Windows dev setup: run Docker Engine + k3d + helm + kubectl natively inside WSL2 Ubuntu.
# Why: Docker Desktop on this machine cannot create/remove AF_UNIX socket files under
# C:\Users\<name>\AppData (Windows error 1920), so it crashes on start. Running the engine
# inside WSL keeps every socket on the Linux filesystem and mirrors the k3s VPS setup.
#
# Usage (from an Ubuntu WSL terminal):  bash /mnt/<drive>/<path-to-repo>/scripts/setup-wsl-docker.sh
set -euo pipefail

K3D_VERSION="v5.9.0"
HELM_VERSION="v4.3.0"
KUBECTL_VERSION="v1.36.5"   # matches k3s v1.36.5 (local k3d image + VPS)
ARCH="$(dpkg --print-architecture)"   # amd64

# Docker Desktop's WSL integration links its own docker CLI and socket into this distro (symlinks into
# /mnt/wsl/docker-desktop). A second engine on the same paths fights it, so stop before installing anything.
# Plain readlink, not -f: when Docker Desktop is not running the links dangle, and -f would then fail.
for link in /usr/bin/docker /var/run/docker.sock; do
  if readlink "$link" 2>/dev/null | grep -q docker-desktop; then
    echo "Docker Desktop's WSL integration is on for this distro ($link). Turn it off first:" >&2
    echo "  Docker Desktop > Settings > Resources > WSL integration: untick this distro, then quit Docker Desktop." >&2
    exit 1
  fi
done

echo "==> Docker Engine (official apt repo)"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> kubectl ${KUBECTL_VERSION} (checksum verified)"
curl -fsSLo "$tmp/kubectl" "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl"
echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256")  $tmp/kubectl" | sha256sum --check
sudo install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl

echo "==> helm ${HELM_VERSION} (checksum verified)"
curl -fsSLo "$tmp/helm.tgz" "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz"
echo "$(curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz.sha256sum" | awk '{print $1}')  $tmp/helm.tgz" | sha256sum --check
tar -xzf "$tmp/helm.tgz" -C "$tmp"
sudo install -m 0755 "$tmp/linux-${ARCH}/helm" /usr/local/bin/helm

echo "==> k3d ${K3D_VERSION} (official install script, pinned tag)"
curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | TAG="${K3D_VERSION}" bash

echo
echo "Done. Versions:"
docker --version; kubectl version --client | head -1; helm version --short; k3d version | head -1
echo
echo "NEXT: so the docker group applies, close this terminal and run 'wsl --shutdown' from Windows once"
echo "      (on plain Linux: log out and back in, or run 'newgrp docker')."
echo "      Keep Docker Desktop quit (or its WSL integration off) so it doesn't fight this engine."
