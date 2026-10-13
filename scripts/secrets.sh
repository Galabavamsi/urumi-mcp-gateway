#!/usr/bin/env bash
# Creates every Kubernetes Secret the Helm charts reference (the charts only use `existingSecret`
# names and never generate or embed secrets).
#
#  - Internal secrets (DB passwords, WordPress salts, WooCommerce API keys, internal MCP tokens,
#    gateway keys) are generated randomly ONCE and never overwritten: rotating a DB password while
#    the PVC keeps the old one would lock the app out of its own data.
#  - External secrets (LLM key, upstream API keys, bootstrap admin) are read from .env and
#    re-applied on every run, so editing .env + re-running rotates them.
#  - Secret values are never printed.
#
# Usage (inside WSL, current kube context = target cluster):  bash scripts/secrets.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

rand_hex() { openssl rand -hex "${1:-24}"; }
salt() { openssl rand -base64 64 | tr -d '\n/+=' | head -c 64; }
exists() { kubectl -n "$1" get secret "$2" >/dev/null 2>&1; }
read_key() { kubectl -n "$1" get secret "$2" -o "jsonpath={.data.$3}" | base64 -d; }

create_once() { # ns name --from-literal=...
  local ns=$1 name=$2; shift 2
  if exists "$ns" "$name"; then
    echo "  = $ns/$name (kept)"
  else
    kubectl -n "$ns" create secret generic "$name" "$@" >/dev/null
    echo "  + $ns/$name (created)"
  fi
}

apply_from_env() { # ns name --from-literal=...
  local ns=$1 name=$2; shift 2
  # Server-side apply with our own field manager. A plain (client-side) `kubectl apply` would copy the
  # whole Secret, values included, into the kubectl.kubernetes.io/last-applied-configuration annotation,
  # where any tool that hides .data but shows metadata would display it. --force-conflicts takes over
  # fields an earlier client-side apply owned, so a rotated value never fails with a conflict.
  kubectl -n "$ns" create secret generic "$name" "$@" --dry-run=client -o yaml \
    | kubectl apply --server-side --field-manager=urumi-secrets --force-conflicts -f - >/dev/null
  # Secrets applied by older versions of this script still carry that annotation (with the old values);
  # remove it. A no-op when it is not there.
  kubectl -n "$ns" annotate secret "$name" kubectl.kubernetes.io/last-applied-configuration- >/dev/null
  echo "  ~ $ns/$name (from .env)"
}

env_get() { # KEY -> value from .env (quotes and trailing comments stripped), empty if missing
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^[[:space:]]*$1[[:space:]]*=" "$ENV_FILE" | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

shared_token() { # name nsA nsB -> same random token in both namespaces
  local name=$1 a=$2 b=$3 token
  if exists "$a" "$name"; then token=$(read_key "$a" "$name" token)
  elif exists "$b" "$name"; then token=$(read_key "$b" "$name" token)
  else token=$(rand_hex 32); fi
  create_once "$a" "$name" --from-literal=token="$token"
  create_once "$b" "$name" --from-literal=token="$token"
}

echo "==> namespaces"
kubectl apply -f "$ROOT/cluster/namespaces.yaml" >/dev/null && echo "  store, platform, mcp-upstreams"

echo "==> store (WordPress + WooCommerce + woo-mcp)"
create_once store woo-store-db \
  --from-literal=root-password="$(rand_hex 24)" \
  --from-literal=password="$(rand_hex 24)"
create_once store woo-store-wp \
  --from-literal=admin-password="$(rand_hex 12)" \
  --from-literal=auth-key="$(salt)" --from-literal=secure-auth-key="$(salt)" \
  --from-literal=logged-in-key="$(salt)" --from-literal=nonce-key="$(salt)" \
  --from-literal=auth-salt="$(salt)" --from-literal=secure-auth-salt="$(salt)" \
  --from-literal=logged-in-salt="$(salt)" --from-literal=nonce-salt="$(salt)"
# WooCommerce REST API key pair for the woo-mcp bot user (same format WooCommerce itself generates).
create_once store woo-store-api \
  --from-literal=consumer-key="ck_$(rand_hex 20)" \
  --from-literal=consumer-secret="cs_$(rand_hex 20)"
# Token the gateway must present to woo-mcp; needed in both namespaces.
shared_token woo-mcp-auth store platform

echo "==> mcp-upstreams (supplier)"
shared_token supplier-mcp-auth mcp-upstreams platform

echo "==> platform (gateway)"
create_once platform gateway-postgres --from-literal=password="$(rand_hex 24)"
create_once platform gateway-internal \
  --from-literal=api-key-pepper="$(rand_hex 32)" \
  --from-literal=credentials-key="$(openssl rand -base64 32)" \
  --from-literal=chat-jwt-key="$(rand_hex 32)" \
  --from-literal=session-secret="$(rand_hex 32)"

missing=()
admin_email=$(env_get BOOTSTRAP_ADMIN_EMAIL); admin_pw=$(env_get BOOTSTRAP_ADMIN_PASSWORD)
if [ -n "$admin_email" ] && [ -n "$admin_pw" ]; then
  apply_from_env platform gateway-bootstrap-admin --from-literal=email="$admin_email" --from-literal=password="$admin_pw"
else missing+=(BOOTSTRAP_ADMIN_EMAIL/PASSWORD); fi

anthropic=$(env_get ANTHROPIC_API_KEY)
if [ -n "$anthropic" ]; then apply_from_env platform gateway-llm --from-literal=anthropic-api-key="$anthropic"
else missing+=(ANTHROPIC_API_KEY); fi

firecrawl=$(env_get FIRECRAWL_API_KEY); agentmail=$(env_get AGENTMAIL_API_KEY)
seed_args=()
[ -n "$firecrawl" ] && seed_args+=(--from-literal=firecrawl-api-key="$firecrawl") || missing+=(FIRECRAWL_API_KEY)
[ -n "$agentmail" ] && seed_args+=(--from-literal=agentmail-api-key="$agentmail") || missing+=(AGENTMAIL_API_KEY)
[ ${#seed_args[@]} -gt 0 ] && apply_from_env platform gateway-upstream-seed "${seed_args[@]}"

if [ ${#missing[@]} -gt 0 ]; then
  echo "  ! not set in $ENV_FILE (skipped): ${missing[*]}"
fi
echo "done."
