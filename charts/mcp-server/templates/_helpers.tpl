{{/*
Name of every object in this release AND the app.kubernetes.io/name label (docs/CONTRACTS.md:
"app.kubernetes.io/name: <component>"). Defaults to the release name; an instance file pins it with
nameOverride so the Service DNS name never depends on how the release was named.
*/}}
{{- define "mcp-server.name" -}}
{{- .Values.nameOverride | default .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels used to find this release's pods (Deployment selector, Service, NetworkPolicy). Never change after install. */}}
{{- define "mcp-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Full label set for every object and pod. */}}
{{- define "mcp-server.labels" -}}
{{ include "mcp-server.selectorLabels" . }}
app.kubernetes.io/component: {{ include "mcp-server.component" . }}
app.kubernetes.io/part-of: urumi
{{- /* toString: `--set image.tag=1234567` (an all-digit short SHA) arrives as a number, which trunc rejects. */}}
app.kubernetes.io/version: {{ .Values.image.tag | toString | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/*
Upstream NetworkPolicies trust "component=gateway in namespace platform". An MCP server wearing that
label could reach every other upstream, so the chart refuses it outright.
*/}}
{{- define "mcp-server.component" -}}
{{- if eq .Values.component "gateway" -}}
{{- fail "component must not be \"gateway\": that label is the gateway's network identity" -}}
{{- end -}}
{{- .Values.component -}}
{{- end -}}

{{/* <registry>/<repository>:<tag>. The tag is required and may not be "latest" (no silent upgrades). */}}
{{- define "mcp-server.image" -}}
{{- $repository := required "image.repository is required" .Values.image.repository -}}
{{- $tag := required "image.tag is required (a version or git SHA, set per environment)" .Values.image.tag | toString -}}
{{- if eq $tag "latest" -}}
{{- fail "image.tag must not be \"latest\": pin a version or git SHA" -}}
{{- end -}}
{{- if .Values.image.registry -}}
{{- printf "%s/%s:%s" .Values.image.registry $repository $tag -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}
