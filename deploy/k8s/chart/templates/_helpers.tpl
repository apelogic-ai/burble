{{/* Common name/label helpers. */}}

{{- define "burble.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "burble.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "burble.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "burble.selectorLabels" -}}
app.kubernetes.io/name: {{ include "burble.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "burble.appSelectorLabels" -}}
{{ include "burble.selectorLabels" . }}
app.kubernetes.io/component: app
{{- end -}}

{{- define "burble.labels" -}}
helm.sh/chart: {{ include "burble.chart" . }}
{{ include "burble.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "burble.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "burble.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "burble.image" -}}
{{- $repo := required "image.repository is required" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- $tag := required "image.tag or image.digest is required" .Values.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{- define "burble.secretName" -}}
{{- if .Values.externalSecret.enabled -}}
{{- include "burble.fullname" . -}}
{{- else -}}
{{- required "Provide secret.existingSecret or enable externalSecret; Slack and provider credentials must come from a Secret" .Values.secret.existingSecret -}}
{{- end -}}
{{- end -}}

{{- define "burble.litellm.fullname" -}}
{{- printf "%s-litellm" (include "burble.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "burble.agentgateway.fullname" -}}
{{- printf "%s-agentgateway" (include "burble.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "burble.litellm.baseUrl" -}}
{{- if eq .Values.litellm.mode "managed" -}}
{{- printf "http://%s:%v/v1" (include "burble.litellm.fullname" .) .Values.litellm.service.port -}}
{{- else if eq .Values.litellm.mode "external" -}}
{{- required "litellm.externalBaseUrl is required when litellm.mode=external" .Values.litellm.externalBaseUrl -}}
{{- else -}}
{{- "" -}}
{{- end -}}
{{- end -}}

{{- define "burble.agentgateway.url" -}}
{{- if eq .Values.agentgateway.mode "managed" -}}
{{- printf "http://%s:%v/mcp" (include "burble.agentgateway.fullname" .) .Values.agentgateway.service.port -}}
{{- else if eq .Values.agentgateway.mode "external" -}}
{{- required "agentgateway.externalUrl is required when agentgateway.mode=external" .Values.agentgateway.externalUrl -}}
{{- else -}}
{{- "" -}}
{{- end -}}
{{- end -}}
