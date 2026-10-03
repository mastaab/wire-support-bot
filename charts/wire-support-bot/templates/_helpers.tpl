{{/*
Chart name, overridable with nameOverride.
*/}}
{{- define "wire-support-bot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full resource name: fullnameOverride, or the release name plus the chart name (just the release
name when it already contains the chart name), at most 63 characters.
*/}}
{{- define "wire-support-bot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version for the helm.sh/chart label.
*/}}
{{- define "wire-support-bot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Standard labels.
*/}}
{{- define "wire-support-bot.labels" -}}
helm.sh/chart: {{ include "wire-support-bot.chart" . }}
{{ include "wire-support-bot.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "wire-support-bot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "wire-support-bot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the service account the pod uses.
*/}}
{{- define "wire-support-bot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "wire-support-bot.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret with the credentials: existingSecret, or the one the chart creates.
*/}}
{{- define "wire-support-bot.secretName" -}}
{{- default (include "wire-support-bot.fullname" .) .Values.existingSecret }}
{{- end }}

{{/*
Name of the PersistentVolumeClaim for the SDK store: persistence.existingClaim, or the one the
chart creates.
*/}}
{{- define "wire-support-bot.claimName" -}}
{{- default (include "wire-support-bot.fullname" .) .Values.persistence.existingClaim }}
{{- end }}

{{/*
A setting as a quoted environment value. Whole numbers are printed without an exponent (values
files load numbers as floats, and 1000000 would otherwise become 1e+06).
*/}}
{{- define "wire-support-bot.envValue" -}}
{{- if kindIs "float64" . }}
{{- int64 . | toString | quote }}
{{- else }}
{{- toString . | quote }}
{{- end }}
{{- end }}
