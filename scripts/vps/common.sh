# Shared settings and helpers for the scripts in scripts/vps/ that run on YOUR machine (WSL, Linux or macOS).
# Sourced by them, never run on its own. (bootstrap-k3s.sh runs on the VPS itself and stands alone.)
#
# Settings, all overridable from the environment:
#   VPS_SSH_VIA      ssm: ssh through AWS Systems Manager Session Manager, port 22 closed  default ssm
#                    direct: ssh to the Elastic IP on port 22 (break-glass, see provision-aws.sh allow-my-ip)
#   VPS_SSH_KEY      private key for ubuntu@ on the VPS                 default ~/.ssh/urumi-vps.pem
#   VPS_KNOWN_HOSTS  the VPS's pinned SSH host key (provision-aws.sh)  default <repo>/.vps/known_hosts
#   VPS_INSTANCE_ID  the instance, for VPS_SSH_VIA=ssm                  default: the one named in VPS_KNOWN_HOSTS
#   VPS_HOST         its address, for VPS_SSH_VIA=direct                default: the Elastic IP in VPS_KNOWN_HOSTS
#   URUMI_REGION     AWS region of the instance                         default ap-south-1
#   TUNNEL_PORT      local end of the SSH tunnel to the kube API        default 16443
#   KUBECONFIG_FILE  kubeconfig written by kubeconfig.sh                default ~/.kube/urumi-vps.yaml
#   KUBE_CONTEXT     context every kubectl/helm call is pinned to       default urumi-vps
# Over Session Manager, the shell that runs ssh needs the AWS CLI v2, the session-manager-plugin and AWS
# credentials that may start a session on the instance (e.g. `export AWS_PROFILE=aws-main`).
# shellcheck shell=bash

VPS_SSH_VIA="${VPS_SSH_VIA:-ssm}"
VPS_REGION="${URUMI_REGION:-ap-south-1}"
VPS_SSH_USER=ubuntu
VPS_SSH_KEY="${VPS_SSH_KEY:-$HOME/.ssh/urumi-vps.pem}"
# Inside the repo (gitignored), so Git Bash, where provision-aws.sh writes it, and WSL, where ssh reads it,
# see the same file. A host key is public, not a secret. provision-aws.sh writes it as
#   # instance i-0123456789abcdef0
#   i-0123456789abcdef0,203.0.113.10 ssh-ed25519 AAAA...
# filing the key under both names ssh may connect to: the instance id (Session Manager) and the Elastic IP.
VPS_KNOWN_HOSTS="${VPS_KNOWN_HOSTS:-$ROOT/.vps/known_hosts}"
TUNNEL_PORT="${TUNNEL_PORT:-16443}"
KUBECONFIG_FILE="${KUBECONFIG_FILE:-$HOME/.kube/urumi-vps.yaml}"
KUBE_CONTEXT="${KUBE_CONTEXT:-urumi-vps}"
# The laptop's k3d cluster. The VPS scripts refuse to act on it (they install cluster add-ons and
# production values that would break the local http setup).
LOCAL_DEV_CONTEXT=k3d-urumi

step() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
need() { local tool; for tool in "$@"; do command -v "$tool" >/dev/null || die "$tool not found"; done; }

# --- SSH to the VPS ------------------------------------------------------------------------------
# The host key is pinned, never trusted on first use: provision-aws.sh reads it from the instance's console
# output through the EC2 API and writes VPS_KNOWN_HOSTS. With StrictHostKeyChecking=yes ssh accepts only
# that key, so nothing else can pose as the VPS, not even on the very first connection (which is the one
# that would hand over the kubeconfig and, through deploy.sh, every Secret).
# The quotes inside the value keep a repo path with spaces in one piece (ssh splits the value on spaces).
SSH_OPTS=(-i "$VPS_SSH_KEY" -o IdentitiesOnly=yes
          -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=\"$VPS_KNOWN_HOSTS\"" -o GlobalKnownHostsFile=/dev/null
          -o ServerAliveInterval=30 -o ServerAliveCountMax=3)
# Over Session Manager ssh never opens a connection to the VPS. Its ProxyCommand asks AWS for a session to
# port 22 of the instance (document AWS-StartSSHSession), and the SSM agent on the VPS, which holds an
# outbound HTTPS connection to AWS, connects it to sshd on localhost. So port 22 stays closed in the security
# group and your IP does not matter. AWS credentials allowed ssm:StartSession decide who may connect; CloudTrail
# records each session start, and ssh on top still checks the pinned host key and logs in with the key. The keepalives
# above also keep the session from hitting Session Manager's idle timeout (20 minutes by default).
if [ "$VPS_SSH_VIA" = ssm ]; then
  SSH_OPTS+=(-o "ProxyCommand=aws ssm start-session --region $VPS_REGION --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p")
fi

# Sets VPS_TARGET, the name ssh connects to: the instance id over Session Manager, the Elastic IP directly.
# Both come from VPS_KNOWN_HOSTS unless VPS_INSTANCE_ID / VPS_HOST say otherwise, so nothing has to be set.
require_vps_host() {
  local names
  [ -f "$VPS_SSH_KEY" ] || die "SSH key $VPS_SSH_KEY not found (set VPS_SSH_KEY)"
  [ -f "$VPS_KNOWN_HOSTS" ] || die "no pinned host key in $VPS_KNOWN_HOSTS: run scripts/vps/provision-aws.sh status to pin it"
  names="$(awk '$2 == "ssh-ed25519" { print $1; exit }' "$VPS_KNOWN_HOSTS")"   # <instance-id>,<elastic-ip>
  case "$VPS_SSH_VIA" in
    ssm)
      VPS_TARGET="${VPS_INSTANCE_ID:-${names%%,*}}"
      [[ "$VPS_TARGET" =~ ^i-[0-9a-f]+$ ]] \
        || die "$VPS_KNOWN_HOSTS does not name the instance (an older provision-aws.sh wrote it): run scripts/vps/provision-aws.sh status"
      if ! command -v aws >/dev/null || ! command -v session-manager-plugin >/dev/null; then
        die "ssh over Session Manager needs the AWS CLI v2 and session-manager-plugin on PATH (docs/VPS.md, Prerequisites)"
      fi
      ;;
    direct)
      VPS_TARGET="${VPS_HOST:-${names#*,}}"
      [ -n "$VPS_TARGET" ] || die "set VPS_HOST to the VPS's Elastic IP"
      ;;
    *) die "VPS_SSH_VIA must be ssm or direct, not '$VPS_SSH_VIA'" ;;
  esac
}

# "i-0123... over Session Manager" or "203.0.113.10:22", for messages. Call require_vps_host first.
vps_route() { if [ "$VPS_SSH_VIA" = ssm ]; then echo "$VPS_TARGET over Session Manager"; else echo "$VPS_TARGET:22"; fi; }

# The arguments are the remote command line (e.g. 'sudo cat /etc/rancher/k3s/k3s.yaml'); no arguments, a shell.
# shellcheck disable=SC2029
vps_ssh() { require_vps_host; ssh "${SSH_OPTS[@]}" "$VPS_SSH_USER@$VPS_TARGET" "$@"; }

# --- kubectl and helm, pinned to the VPS ----------------------------------------------------------
# Every call names the kubeconfig file and the context explicitly, so whatever context your main
# kubeconfig has selected (e.g. the local k3d-urumi) is never touched by these scripts.
kube() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$KUBE_CONTEXT" "$@"; }
helm_vps() { helm --kubeconfig "$KUBECONFIG_FILE" --kube-context "$KUBE_CONTEXT" "$@"; }

# Stops unless KUBE_CONTEXT is a reachable cluster that is not the local dev cluster.
require_vps_cluster() {
  [ "$KUBE_CONTEXT" != "$LOCAL_DEV_CONTEXT" ] \
    || die "refusing to run against $LOCAL_DEV_CONTEXT (the local dev cluster); these scripts are for the VPS"
  [ -f "$KUBECONFIG_FILE" ] || die "$KUBECONFIG_FILE not found (run scripts/vps/kubeconfig.sh first)"
  kube get --raw /readyz >/dev/null 2>&1 \
    || die "the API of context $KUBE_CONTEXT does not answer (is scripts/vps/tunnel.sh running in another terminal?)"
  echo "  cluster: context $KUBE_CONTEXT in $KUBECONFIG_FILE ($(kube get nodes -o name | tr '\n' ' '))"
}

# Runs a command with KUBECONFIG set to a temporary file that holds ONLY KUBE_CONTEXT, as its current
# context. For scripts that act on "the current context" (scripts/secrets.sh): they can then reach the
# VPS and nothing else. The file holds the cluster's credentials, so it lives in a private temp dir
# that is removed afterwards.
with_vps_kubeconfig() {
  local dir rc=0
  dir="$(mktemp -d)"
  chmod 700 "$dir"
  kube config view --minify --flatten > "$dir/config"
  KUBECONFIG="$dir/config" "$@" || rc=$?
  rm -rf "$dir"
  return "$rc"
}

# KEY -> its value from the repo's .env (quotes and trailing comments stripped), empty if missing.
# The same parsing as scripts/secrets.sh, including the CRLF fix for a .env saved on Windows.
env_get() {
  local file="${ENV_FILE:-$ROOT/.env}"
  [ -f "$file" ] || return 0
  # "|| true": a key that is not in the file is just empty. (grep exits 1 when nothing matches, and with
  # pipefail that would stop the calling script.)
  { tr -d '\r' < "$file" | grep -E "^[[:space:]]*$1[[:space:]]*=" || true; } | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/(^|[[:space:]]+)#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
