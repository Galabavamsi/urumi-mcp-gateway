{{/*
Labels (docs/CONTRACTS.md). Called with a dict: (dict "root" $ "component" "wordpress").
  selectorLabels  name + instance: what Services, workloads and NetworkPolicies match on
  podLabels       selectorLabels + part-of: put on every pod
  labels          podLabels + Helm bookkeeping: put on every object's metadata
*/}}
{{- define "woo-store.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{- define "woo-store.podLabels" -}}
{{ include "woo-store.selectorLabels" . }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{- define "woo-store.labels" -}}
{{ include "woo-store.podLabels" . }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end }}

{{/*
"repository:tag" for an image block. Called with (dict "name" "wordpress.image" "image" .Values.wordpress.image).
Fails the render when the tag is empty or "latest": every deployed image must be pinned.
*/}}
{{- define "woo-store.image" -}}
{{- $tag := toString (required (printf "%s.tag is required (pin a version, e.g. --set %s.tag=<git-sha>)" .name .name) .image.tag) -}}
{{- if eq $tag "latest" -}}
{{- fail (printf "%s.tag must not be 'latest'" .name) -}}
{{- end -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end }}

{{/*
The store's public home URL (WP_HOME, WP_SITEURL, woo-mcp's WOO_HOME_URL). https when the Ingress
terminates TLS. The host is validated because it is also written into PHP (WORDPRESS_CONFIG_EXTRA).
*/}}
{{- define "woo-store.homeUrl" -}}
{{- $host := required "ingress.host is required" .Values.ingress.host -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$" $host) -}}
{{- fail (printf "ingress.host %q is not a valid lowercase hostname" $host) -}}
{{- end -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) $host -}}
{{- end }}

{{/*
Secret-backed env shared by every container that loads WordPress (bootstrap, Apache, cron):
the DB password and the 8 auth keys/salts that wp-config.php reads. Stable salts matter: if they
changed per pod, every restart would log everyone out and break checkout nonces.
*/}}
{{- define "woo-store.wordpressSecretEnv" -}}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secrets.db }}
      key: password
{{- $salts := dict
  "WORDPRESS_AUTH_KEY" "auth-key" "WORDPRESS_SECURE_AUTH_KEY" "secure-auth-key"
  "WORDPRESS_LOGGED_IN_KEY" "logged-in-key" "WORDPRESS_NONCE_KEY" "nonce-key"
  "WORDPRESS_AUTH_SALT" "auth-salt" "WORDPRESS_SECURE_AUTH_SALT" "secure-auth-salt"
  "WORDPRESS_LOGGED_IN_SALT" "logged-in-salt" "WORDPRESS_NONCE_SALT" "nonce-salt" }}
{{- range $env, $key := $salts }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ $.Values.secrets.wordpress }}
      key: {{ $key }}
{{- end }}
{{- end }}

{{/* Container hardening shared by every container in the chart (all run as non-root users). */}}
{{- define "woo-store.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* Pod-level hardening; called with the uid/gid the image is built for. */}}
{{- define "woo-store.podSecurityContext" -}}
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
