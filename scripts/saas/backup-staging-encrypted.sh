#!/usr/bin/env bash
# Authorized staging only. Encrypt every dump before it reaches backup storage.
set -euo pipefail
umask 077
ROOT=/opt/productspy-staging
test "$(id -u)" = 0
test -f "$ROOT/.productspy-staging"
test -f "$ROOT/.application-initialized"
test "$(realpath "$ROOT")" = "$ROOT"
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; do
  test -z "${!name:-}" || { echo 'Docker endpoint overrides forbidden.' >&2; exit 1; }
done
test "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" = unix:///var/run/docker.sock
cd "$ROOT"
test -s backup-recipient.pub
install -d -m 700 backups
test ! -L backups
test "$(realpath backups)" = "$ROOT/backups"
exec 9>backup.lock
flock -n 9 || { echo 'Another staging backup holds the lock.' >&2; exit 1; }
AVAILABLE_KB="$(df -Pk backups | awk 'NR==2 {print $4}')"
test "$AVAILABLE_KB" -ge 1048576 || { echo 'Insufficient disk; no automatic backup deletion.' >&2; exit 1; }
RUN_ID="$(date -u +%Y%m%dT%H%M%S%NZ)"
OUTPUT="$ROOT/backups/daily-$RUN_ID.dump.age"
test ! -e "$OUTPUT"
# noclobber protects the partial file as well. A failed pipeline keeps its partial
# ciphertext for diagnosis and exits nonzero; it never labels it a finished dump.
set -o noclobber
docker --context default compose --env-file .env.compose -p productspy-staging -f compose.yaml -f compose.images.yaml exec -T db pg_dump -U productspy_migrate -d productspy --format=custom |
  age --encrypt -R backup-recipient.pub > "$OUTPUT.partial"
test -s "$OUTPUT.partial"
mv -n -- "$OUTPUT.partial" "$OUTPUT"
test ! -e "$OUTPUT.partial"
sha256sum "$OUTPUT" > "$OUTPUT.sha256"
printf 'Encrypted staging backup completed: %s\n' "$OUTPUT"
# Deliberately no retention deletion, plaintext dump, private key, or external upload.
