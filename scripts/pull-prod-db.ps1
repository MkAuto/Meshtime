# Debug only: copies the prod database to .\data\prod.db
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$cfg = @{}
Get-Content "$root\.env" | ForEach-Object { if ($_ -match '^\s*(MESHTIME_\w+)\s*=\s*(.+?)\s*$') { $cfg[$Matches[1]] = $Matches[2] } }
foreach ($k in 'MESHTIME_SSH', 'MESHTIME_PORT', 'MESHTIME_DIR') { if (-not $cfg[$k]) { throw "Set $k in .env" } }
$ssh = $cfg.MESHTIME_SSH; $port = $cfg.MESHTIME_PORT; $dir = $cfg.MESHTIME_DIR

$js = @'
const fs = require('node:fs');
try { fs.unlinkSync('/data/prod-copy.db'); } catch {}
new (require('node:sqlite').DatabaseSync)('/data/app.db').exec("VACUUM INTO '/data/prod-copy.db'");
'@

# VACUUM INTO gives a consistent snapshot even while the app writes (same as the README backup).
$js | ssh -p $port $ssh "cd $dir && sudo docker compose exec -T app node - && sudo docker compose cp app:/data/prod-copy.db ./prod-copy.db && sudo docker compose exec -T app rm /data/prod-copy.db"
if ($LASTEXITCODE) { throw 'Remote snapshot failed.' }

New-Item -ItemType Directory -Force "$root\data" | Out-Null
scp -P $port "${ssh}:$dir/prod-copy.db" "$root\data\prod.db"
if ($LASTEXITCODE) { throw 'scp failed.' }
ssh -p $port $ssh "sudo rm $dir/prod-copy.db"
Write-Host 'Saved data\prod.db'
