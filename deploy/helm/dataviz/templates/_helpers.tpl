{{/* Common labels */}}
{{- define "dataviz.labels" -}}
app.kubernetes.io/part-of: dataviz
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Image ref for a service. Usage: include "dataviz.image" (dict "ctx" $ "name" "viz-service") */}}
{{- define "dataviz.image" -}}
{{- $img := .ctx.Values.image -}}
{{- printf "%s/%s/%s:%s" $img.registry $img.org .name (toString $img.tag) -}}
{{- end -}}

{{/* wait-for-controlplane initContainer (single list item) */}}
{{- define "dataviz.waitForControlplane" -}}
- name: wait-for-controlplane
  image: {{ .Values.ordering.image | quote }}
  command:
    - /bin/sh
    - -c
    - "until curl -sf http://aggregation-controlplane:8091/health; do echo waiting for controlplane; sleep 3; done"
{{- end -}}

{{/* wait-for-schema initContainer: gate pod startup on Alembic schema being at head.

     Usage: include "dataviz.schemaCheckInitContainer" (dict "ctx" $)

     Uses the synodic-upgrade image (separate from viz/worker/etc.).
     Exits 0 only when alembic_version matches every script-directory head.
     If the upgrade Job hasn't completed yet, the initContainer retries up to
     upgrade.checkWaitSecs seconds, then the pod restarts and tries again. */}}
{{- define "dataviz.schemaCheckInitContainer" -}}
- name: wait-for-schema
  image: {{ include "dataviz.image" (dict "ctx" .ctx "name" "synodic-upgrade") | quote }}
  imagePullPolicy: {{ .ctx.Values.image.pullPolicy }}
  args: ["check", "--wait", {{ .ctx.Values.upgrade.checkWaitSecs | default 60 | quote }}]
  envFrom:
    - configMapRef:
        name: dataviz-config
    - secretRef:
        name: {{ include "dataviz.secretName" .ctx }}
{{- end -}}

{{/* Name of the Secret to reference (existingSecret wins) */}}
{{- define "dataviz.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
dataviz-secrets
{{- end -}}
{{- end -}}

{{/* TCP forwarder sidecars for managed Postgres / Redis via a proxy VM.

     Rendered as Kubernetes native sidecars (initContainer with
     restartPolicy: Always — GA in 1.29) so socat is Ready before any
     subsequent initContainer (wait-for-schema, wait-for-controlplane)
     or the app container attempts to connect to 127.0.0.1.

     `upstream` is the proxy VM's NIC0 address in host:port form. */}}
{{- define "dataviz.dbProxySidecar" -}}
- name: db-proxy
  image: {{ .Values.proxy.postgres.image | quote }}
  imagePullPolicy: IfNotPresent
  restartPolicy: Always
  args:
    - "TCP-LISTEN:5432,fork,reuseaddr,bind=127.0.0.1"
    - "TCP:{{ required "proxy.postgres.upstream must be set (e.g. \"10.0.0.5:5432\") when proxy.postgres.enabled" .Values.proxy.postgres.upstream }}"
  resources:
    {{- toYaml .Values.proxy.postgres.resources | nindent 4 }}
{{- end -}}

{{- define "dataviz.redisProxySidecar" -}}
- name: redis-proxy
  image: {{ .Values.proxy.redis.image | quote }}
  imagePullPolicy: IfNotPresent
  restartPolicy: Always
  args:
    - "TCP-LISTEN:6379,fork,reuseaddr,bind=127.0.0.1"
    - "TCP:{{ required "proxy.redis.upstream must be set (e.g. \"10.0.0.5:6379\") when proxy.redis.enabled" .Values.proxy.redis.upstream }}"
  resources:
    {{- toYaml .Values.proxy.redis.resources | nindent 4 }}
{{- end -}}
