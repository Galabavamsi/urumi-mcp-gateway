#!/usr/bin/env bash
# Turns the fresh Ubuntu 24.04 EC2 instance into a one-node k3s cluster. Runs ON the VPS as the ubuntu
# user (it calls sudo itself) and is safe to re-run. Started from your machine with:
#   VPS_HOST=<elastic-ip> bash scripts/vps/bootstrap.sh
# which sends this file over ssh with the host key provision-aws.sh pinned. Optional settings (environment,
# passed on by bootstrap.sh):
#   PUBLIC_IP   put on the API server certificate (default: the instance's public IP from EC2 metadata)
#   NODE_NAME   Kubernetes node name (default urumi-vps)
#
# What it does:
#   1. host hardening that is safe on a Kubernetes node: automatic SECURITY updates (no automatic reboot),
#      SSH keys only, no root login, no remote port forwarding. The host firewall (ufw) stays OFF on
#      purpose, see below.
#   2. /etc/rancher/k3s/config.yaml: node name, kubeconfig readable by root only, Secrets encrypted at
#      rest, the public IP on the API certificate.
#   3. k3s v1.36.5+k3s1 (the same build as the local k3d cluster) with the official installer, fetched
#      from that release's tag and checked against a pinned SHA-256.
#   4. waits for the node, CoreDNS and Traefik, and prints the next steps.
#
# Why no ufw: k3s programs iptables itself (kube-proxy for Services, flannel for pod traffic, kube-router
# for NetworkPolicies). ufw's default "deny incoming / drop forwarded" policy then silently drops pod and
# Service traffic unless you add allow rules for the pod and Service ranges (10.42.0.0/16, 10.43.0.0/16),
# and the two rule sets fight over the same chains on every reload. The AWS security group already
# filters inbound traffic outside the machine (80/443 from anywhere, 22 from your IP, nothing else; 6443
# is never open), so ufw would add breakage risk and no protection. k3s's own docs recommend turning it off.
set -euo pipefail

K3S_VERSION="v1.36.5+k3s1"
# install.sh exactly as tagged in that release (the "+" is URL-encoded); a different script is refused.
K3S_INSTALL_URL="https://raw.githubusercontent.com/k3s-io/k3s/v1.36.5%2Bk3s1/install.sh"
K3S_INSTALL_SHA256="46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad"
NODE_NAME="${NODE_NAME:-urumi-vps}"
K3S_CONFIG=/etc/rancher/k3s/config.yaml

step() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
kc() { sudo k3s kubectl "$@"; }

# One value from the EC2 instance metadata service. IMDSv2: get a short-lived session token with a PUT,
# then send it with the GET. (The instance requires v2, and its hop limit of 1 means only the host
# itself, not a pod behind the CNI bridge, ever gets an answer.)
imds() {
  local token
  token="$(curl -fsS --max-time 5 -X PUT http://169.254.169.254/latest/api/token \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" || return
  curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}

harden_host() {
  step "host: automatic security updates"
  # < /dev/null on everything that might read stdin: this script itself arrives on stdin ('bash -s').
  # (dpkg's progress lines go to /dev/null; errors still show on stderr.)
  sudo apt-get update -qq < /dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades curl ca-certificates \
    < /dev/null > /dev/null
  # Ubuntu's 50unattended-upgrades already limits automatic installs to the -security pocket and never
  # reboots by itself (a reboot would interrupt the demo; kernel updates wait for a manual
  # `sudo reboot`, after which k3s and every pod come back on their own). This file switches it on daily.
  sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  echo "  unattended-upgrades: security updates daily, no automatic reboot"

  step "host: SSH"
  # sshd keeps the FIRST value it reads for each setting and reads sshd_config.d/ in name order, so
  # "10-" wins over the image's own 60-cloudimg-settings.conf.
  sudo tee /etc/ssh/sshd_config.d/10-urumi.conf >/dev/null <<'EOF'
# Written by scripts/vps/bootstrap-k3s.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
# tunnel.sh needs local forwarding (ssh -L) to reach the kube API; nothing needs the reverse direction.
AllowTcpForwarding local
X11Forwarding no
EOF
  sudo sshd -t || die "the new sshd settings do not parse; fix /etc/ssh/sshd_config.d/10-urumi.conf"
  sudo systemctl reload ssh 2>/dev/null || sudo systemctl restart ssh   # open sessions survive either
  echo "  keys only, no root login, local port forwarding only"

  step "host: firewall"
  if sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    echo "  ! ufw is ACTIVE: it can drop pod and Service traffic. Consider 'sudo ufw disable' (see the header)."
  else
    echo "  ufw inactive (on purpose; the AWS security group filters inbound traffic)"
  fi
}

write_k3s_config() { # public-ip -> sets CONFIG_CHANGED=yes|no
  local public_ip=$1 new
  new="$(cat <<EOF
# Written by scripts/vps/bootstrap-k3s.sh. k3s reads it on every start (keys = the CLI flags).
node-name: $NODE_NAME
# /etc/rancher/k3s/k3s.yaml holds cluster-admin credentials: readable by root only.
write-kubeconfig-mode: "0600"
# Kubernetes Secrets are encrypted (AES-CBC) before they are written to the datastore on disk; the key
# lives in /var/lib/rancher/k3s/server/cred/. Check: sudo k3s secrets-encrypt status
secrets-encryption: true
# Extra name on the API server certificate. kubectl normally comes in through the SSH tunnel to
# 127.0.0.1 (always on the certificate); this keeps the public IP valid too. Port 6443 itself is never
# open in the security group.
tls-san:
  - "$public_ip"
EOF
)"
  if [ "$(sudo cat "$K3S_CONFIG" 2>/dev/null || true)" = "$new" ]; then
    CONFIG_CHANGED=no
    echo "  = $K3S_CONFIG (unchanged)"
  else
    sudo install -d -m 755 /etc/rancher/k3s
    printf '%s\n' "$new" | sudo tee "$K3S_CONFIG" >/dev/null
    sudo chmod 600 "$K3S_CONFIG"
    CONFIG_CHANGED=yes
    echo "  + $K3S_CONFIG"
  fi
}

install_k3s() {
  local installed tmp
  installed="$(k3s --version 2>/dev/null | awk 'NR == 1 { print $3 }' || true)"
  if [ "$installed" = "$K3S_VERSION" ]; then
    echo "  = k3s $K3S_VERSION already installed"
    if [ "$CONFIG_CHANGED" = yes ]; then
      sudo systemctl restart k3s
      echo "  ~ k3s restarted to load the new config"
    fi
    return
  fi
  [ -z "$installed" ] || echo "  ! replacing k3s $installed with $K3S_VERSION"
  tmp="$(mktemp -d)"
  curl -fsSL --retry 5 --retry-all-errors -o "$tmp/install.sh" "$K3S_INSTALL_URL"
  echo "$K3S_INSTALL_SHA256  $tmp/install.sh" | sha256sum --check --quiet \
    || die "install.sh does not match the pinned SHA-256; refusing to run it"
  # Run as ubuntu: the installer calls sudo itself. It downloads the k3s binary of exactly this version
  # from the GitHub release and checks it against the release's sha256sum file before installing it.
  # It does not retry, and GitHub's release downloads do fail now and then (seen while testing: HTTP 500
  # for a minute), so the whole installer is retried; re-running it is safe.
  local attempt
  for attempt in 1 2 3 4 5; do
    INSTALL_K3S_VERSION="$K3S_VERSION" sh "$tmp/install.sh" < /dev/null && break
    [ "$attempt" -lt 5 ] || die "the k3s installer failed 5 times"
    echo "  ! installer failed (attempt $attempt of 5); retrying in $((attempt * 10)) s"
    sleep $((attempt * 10))
  done
  rm -rf "$tmp"
  echo "  + k3s $K3S_VERSION installed (systemd unit k3s, starts on boot)"
}

wait_for_cluster() {
  local i
  for i in $(seq 1 90); do
    kc get node "$NODE_NAME" >/dev/null 2>&1 && break
    [ "$i" -lt 90 ] || die "the node did not register within 3 minutes (sudo journalctl -u k3s)"
    sleep 2
  done
  kc wait --for=condition=Ready "node/$NODE_NAME" --timeout=180s >/dev/null
  echo "  node $NODE_NAME Ready"
  kc -n kube-system rollout status deploy/coredns --timeout=180s >/dev/null
  echo "  CoreDNS ready"
  # Traefik is installed by k3s's helm-controller a little after the node starts.
  for i in $(seq 1 90); do
    kc -n kube-system get deploy/traefik >/dev/null 2>&1 && break
    [ "$i" -lt 90 ] || die "Traefik was not installed within 3 minutes (sudo k3s kubectl -n kube-system get pods)"
    sleep 2
  done
  kc -n kube-system rollout status deploy/traefik --timeout=300s >/dev/null
  echo "  Traefik ready"
  sudo k3s secrets-encrypt status | sed -n 's/^Encryption Status: /  Secrets encryption at rest: /p'
}

main() {
  local public_ip
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "expected Ubuntu, found ${PRETTY_NAME:-unknown}"
  [ "${VERSION_ID:-}" = 24.04 ] || echo "  ! tested on Ubuntu 24.04, this is $PRETTY_NAME"
  [ "$(uname -m)" = x86_64 ] || die "expected an amd64 (x86_64) machine, found $(uname -m)"
  sudo -n true 2>/dev/null || die "the ubuntu user needs passwordless sudo (the default on EC2 Ubuntu images)"

  public_ip="${PUBLIC_IP:-$(imds public-ipv4 || true)}"
  [[ "$public_ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
    || die "could not find the public IP (got '$public_ip'); pass it: PUBLIC_IP=<elastic-ip> bash scripts/vps/bootstrap.sh"
  echo "VPS $(hostname), public IP $public_ip, k3s $K3S_VERSION"

  harden_host
  step "k3s configuration"
  write_k3s_config "$public_ip"
  step "k3s"
  install_k3s
  step "waiting for the cluster"
  wait_for_cluster

  cat <<EOF

Done. Next, on YOUR machine (WSL), from the repo root (docs/VPS.md):
  export VPS_HOST=$public_ip
  bash scripts/vps/kubeconfig.sh        # fetches the kubeconfig to ~/.kube/urumi-vps.yaml
  bash scripts/vps/tunnel.sh            # in its own terminal: 127.0.0.1:16443 -> the API on the VPS
  bash scripts/vps/install-addons.sh    # namespaces, cert-manager, Let's Encrypt issuers, HTTPS redirect
  bash scripts/vps/deploy.sh            # the three Helm releases with the GHCR images
EOF
}

# Everything runs from main(): bash has then read the whole script before the first command runs, so
# nothing below can accidentally consume the rest of it from stdin ('bash -s').
main "$@"
