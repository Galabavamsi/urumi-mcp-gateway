#!/usr/bin/env bash
# Lints every Helm chart and validates the manifests it renders against the Kubernetes API schemas,
# once with values-local.yaml and once with values-prod.yaml. Release names, namespaces, values files
# and --set-string image tags are the ones scripts/dev-up.sh and a production deploy use.
#
#   helm lint --strict   chart metadata, template syntax, rendered YAML; warnings fail too. Lint runs the
#                        templates in a lenient mode where `required` and `fail` only log, so it
#                        cannot be the only check
#   helm template        renders exactly what `helm upgrade --install` would send, with the templates'
#                        own checks enforced (a missing image tag, a "latest" tag, a bad host all fail)
#   kubeconform -strict  every rendered object against the schema of its kind for our Kubernetes
#                        version; unknown fields (a typo, a field from a newer version) fail
# pipefail matters: when `helm template` fails, kubeconform reads nothing and exits 0, and without
# pipefail a pipe's status is only that of its last command.
#
# Run by the "charts" job of .github/workflows/ci.yml. Runs the same way locally, inside WSL:
#   bash .github/scripts/check-charts.sh          (TAG=<tag> renders with another image tag)
# Needs helm (v4) and kubeconform on PATH, and network access (kubeconform downloads the schemas).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

for tool in helm kubeconform; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done

# The Kubernetes version of the local k3d cluster and of the VPS (k3s v1.36.5+k3s1). Helm renders for it
# (the charts' kubeVersion constraint is checked against it) and kubeconform validates against it.
KUBE_VERSION=1.36.5

# JSON schemas of the built-in Kubernetes kinds, from github.com/yannh/kubernetes-json-schema pinned to a
# commit (kubeconform's default location follows that repo's master branch). With -strict, kubeconform
# picks the "-strict" schema variant, which forbids properties the schema does not define.
SCHEMA_LOCATION='https://raw.githubusercontent.com/yannh/kubernetes-json-schema/817113f21a2643311cbc3e992bb44ffe1c416c54/{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json'

# Kinds that have no schema in that repository because they come from CRDs. Only cert-manager's are
# expected (production TLS). They are skipped by name rather than with -ignore-missing-schemas: that
# flag would also skip an object whose apiVersion or kind is misspelled (it has no schema either), so
# the check could pass while validating nothing. A new CRD kind in a chart fails here until it is added.
SKIP_KINDS='cert-manager.io/v1/Certificate,cert-manager.io/v1/Issuer,cert-manager.io/v1/ClusterIssuer'

# Each schema is downloaded once and reused by all six runs below (deleted on exit).
SCHEMA_CACHE="$(mktemp -d)"
trap 'rm -rf "$SCHEMA_CACHE"' EXIT

# Any pinned tag renders the same manifests; by default the one a deploy of this commit would pass.
# --set-string, as in scripts/dev-up.sh: a short SHA can be all digits, which --set would make a number.
TAG="${TAG:-$(git rev-parse --short HEAD)}"

check() { # release namespace chart, then the values arguments (-f ..., --set-string ...)
  local release=$1 namespace=$2 chart=$3
  shift 3
  printf '\n==> %s (release %s, namespace %s)\n    %s\n' "$chart" "$release" "$namespace" "$*"
  helm lint --strict "$chart" --namespace "$namespace" --kube-version "$KUBE_VERSION" "$@"
  helm template "$release" "$chart" --namespace "$namespace" --kube-version "$KUBE_VERSION" "$@" \
    | kubeconform -strict -summary -kubernetes-version "$KUBE_VERSION" \
        -schema-location "$SCHEMA_LOCATION" -cache "$SCHEMA_CACHE" -skip "$SKIP_KINDS"
}

for env in local prod; do
  check woo-store store charts/woo-store \
    -f "charts/woo-store/values-$env.yaml" \
    --set-string wordpress.image.tag="$TAG" --set-string wooMcp.image.tag="$TAG"
  check supplier-mcp mcp-upstreams charts/mcp-server \
    -f "charts/mcp-server/values-$env.yaml" -f charts/mcp-server/instances/supplier.yaml \
    --set-string image.tag="$TAG"
  check platform platform charts/platform \
    -f "charts/platform/values-$env.yaml" \
    --set-string gateway.image.tag="$TAG" --set-string dashboard.image.tag="$TAG"
done

printf '\nAll charts passed (Kubernetes %s, image tag %s).\n' "$KUBE_VERSION" "$TAG"
