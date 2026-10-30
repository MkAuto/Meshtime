#!/usr/bin/env bash
# Debug only: copies the prod database to ./data/prod.db
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; source <(grep -E '^\s*MESHTIME_\w+\s*=' "$root/.env" | tr -d '\r'); set +a
: "${MESHTIME_SSH:?Set MESHTIME_SSH in .env}" "${MESHTIME_PORT:?Set MESHTIME_PORT in .env}" "${MESHTIME_DIR:?Set MESHTIME_DIR in .env}"
ssh_host=$MESHTIME_SSH port=$MESHTIME_PORT dir=$MESHTIME_DIR

js=$(cat <<'EOF'
const fs = require('node:fs');
try { fs.unlinkSync('/data/prod-copy.db'); } catch {}
new (require('node:sqlite').DatabaseSync)('/data/app.db').exec("VACUUM INTO '/data/prod-copy.db'");
EOF
)

# VACUUM INTO gives a consistent snapshot even while the app writes (same as the README backup).
printf '%s\n' "$js" | ssh -p "$port" "$ssh_host" "cd $dir && sudo docker compose exec -T app node - && sudo docker compose cp app:/data/prod-copy.db ./prod-copy.db && sudo docker compose exec -T app rm /data/prod-copy.db"

mkdir -p "$root/data"
scp -P "$port" "$ssh_host:$dir/prod-copy.db" "$root/data/prod.db"
ssh -p "$port" "$ssh_host" "sudo rm $dir/prod-copy.db"
echo 'Saved data/prod.db'
