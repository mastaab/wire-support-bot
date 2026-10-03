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
files load numbers as floats, and 1000000 would otherwise become 1e+06); fractions such as 0.5 as they are.
*/}}
{{- define "wire-support-bot.envValue" -}}
{{- if and (kindIs "float64" .) (eq (float64 (int64 .)) .) }}
{{- int64 . | toString | quote }}
{{- else }}
{{- toString . | quote }}
{{- end }}
{{- end }}

{{/*
Environment variables for the Postgres connection (see database.* in values.yaml). Mode A, when
database.url.secretName is set: DATABASE_URL from that Secret. Mode B: DATABASE_HOST, DATABASE_PORT,
DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD, each from database.secretName when the part
names a secretKey, else as a plain value; DATABASE_URL is set empty, so a key of that name in
existingSecret cannot take precedence over the parts. Both modes set DATABASE_OPTIONS when
database.options is not empty. The entry point builds the URL (src/app/databaseUrl.ts).
*/}}
{{- define "wire-support-bot.databaseEnv" -}}
{{- $db := .Values.database }}
{{- $urlSecret := $db.url.secretName }}
{{- if $urlSecret }}
{{- if $db.secretName }}
{{- fail "database: set either database.url.secretName (a complete URL) or database.secretName (the parts), not both" }}
{{- end }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $urlSecret | quote }}
      key: {{ required "database.url.secretKey is required with database.url.secretName: the key of the URL in that Secret, for example uri" $db.url.secretKey | quote }}
{{- else }}
{{- $secret := required "database: set database.url.secretName (the Secret with a complete URL) or database.secretName (the Secret with the password and the parts that name a secretKey)" $db.secretName }}
{{- if not (or $db.host.secretKey $db.host.value) }}
{{- fail "database.host: set database.host.value (the Postgres host) or database.host.secretKey (its key in database.secretName, for example host)" }}
{{- end }}
- name: DATABASE_URL
  value: ""
{{- range $part := list (list "DATABASE_HOST" "host" $db.host) (list "DATABASE_PORT" "port" $db.port) (list "DATABASE_NAME" "name" $db.name) (list "DATABASE_USER" "user" $db.user) }}
{{- $env := index $part 0 }}
{{- $field := index $part 1 }}
{{- $p := index $part 2 }}
{{- if $p.secretKey }}
- name: {{ $env }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret | quote }}
      key: {{ $p.secretKey | quote }}
{{- else if and (not (kindIs "invalid" $p.value)) (ne (toString $p.value) "") }}
- name: {{ $env }}
  value: {{ include "wire-support-bot.envValue" $p.value }}
{{- else if ne $field "port" }}
{{- fail (printf "database.%s: set database.%s.value or database.%s.secretKey (its key in database.secretName)" $field $field $field) }}
{{- end }}
{{- end }}
- name: DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret | quote }}
      key: {{ required "database.password.secretKey is required: the key of the password in database.secretName, for example password" $db.password.secretKey | quote }}
{{- end }}
{{- with $db.options }}
- name: DATABASE_OPTIONS
  value: {{ . | quote }}
{{- end }}
{{- end }}
