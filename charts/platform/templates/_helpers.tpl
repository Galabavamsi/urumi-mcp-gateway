{{/*
Labels (docs/CONTRACTS.md). Called with a dict: (dict "root" $ "component" "gateway").
  selectorLabels  name + instance: what Services, workloads and NetworkPolicies match on
  podLabels       selectorLabels + part-of: put on every pod
  labels          podLabels + Helm bookkeeping: put on every object's metadata
*/}}
{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{- define "platform.podLabels" -}}
{{ include "platform.selectorLabels" . }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{- define "platform.labels" -}}
{{ include "platform.podLabels" . }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end }}

{{/*
The gateway's network identity. woo-mcp, supplier-mcp and Postgres let in exactly the pods that carry
this label (and, for the upstreams, also live in namespace platform). Defined once so the gateway pods
and the Postgres policy can never drift apart.
*/}}
{{- define "platform.gatewayIdentityLabels" -}}
app.kubernetes.io/component: gateway
{{- end }}

{{/*
"repository:tag" for an image block. Called with (dict "name" "gateway.image" "image" .Values.gateway.image).
Fails the render when the tag is empty or "latest": every deployed image must be pinned.
*/}}
{{- define "platform.image" -}}
{{- $tag := toString (required (printf "%s.tag is required (pin a version, e.g. --set-string %s.tag=<git-sha>)" .name .name) .image.tag) -}}
{{- if eq $tag "latest" -}}
{{- fail (printf "%s.tag must not be 'latest'" .name) -}}
{{- end -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end }}

{{/*
PUBLIC_BASE_URL, checked. The gateway appends "/mcp" to it for the MCP URL it shows users, so it must be
scheme://host[:port] with no path and no trailing slash. COOKIE_SECURE must match the scheme: a Secure
cookie is dropped by browsers on plain http (nobody could log in), and a non-Secure cookie on https would
let the session leak over any plain-http request.
*/}}
{{- define "platform.publicBaseUrl" -}}
{{- $url := required "gateway.publicBaseUrl is required" .Values.gateway.publicBaseUrl -}}
{{- if not (regexMatch "^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$" $url) -}}
{{- fail (printf "gateway.publicBaseUrl %q must look like https://app.example.com (no path, no trailing slash)" $url) -}}
{{- end -}}
{{- if ne (toString (hasPrefix "https://" $url)) (toString .Values.gateway.cookieSecure) -}}
{{- fail "gateway.cookieSecure must be true exactly when gateway.publicBaseUrl starts with https://" -}}
{{- end -}}
{{- $url -}}
{{- end }}

{{/*
One env var read from a Secret key. Called with (dict "env" "PGPASSWORD" "secret" "gateway-postgres"
"key" "password" "optional" false). optional=true lets the pod start while the Secret or key is missing
(the variable is then simply unset); use it only for credentials the app can run without.
*/}}
{{- define "platform.envFromSecret" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end }}

{{/* Container hardening shared by every container in the chart (all run as non-root users). */}}
{{- define "platform.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* Pod-level hardening; called with the uid/gid the image is built for. */}}
{{- define "platform.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
{{- if .fsGroup }}
# Volumes that support ownership management (e.g. EBS) are made group-writable for this gid.
fsGroup: {{ .uid }}
fsGroupChangePolicy: OnRootMismatch
{{- end }}
seccompProfile:
  type: RuntimeDefault
{{- end }}
