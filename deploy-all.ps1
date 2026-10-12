# One-shot deploy: push to GitHub -> Cloud Run frontend -> VPS bridge.
# Run from this folder in PowerShell:  .\deploy-all.ps1
# You only type the VPS password once, when ssh asks for it.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "`n[1/3] Pushing to GitHub..." -ForegroundColor Cyan
git push origin main

Write-Host "`n[2/3] Deploying frontend to Cloud Run..." -ForegroundColor Cyan
gcloud run deploy miner --source . --region us-central1 --allow-unauthenticated --port 80 --min-instances 0 --max-instances 3 --memory 128Mi --cpu 1

Write-Host "`n[3/3] Setting up the bridge on the VPS (enter the server password when asked)..." -ForegroundColor Cyan
$remote = @'
set -e
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
swapon --show | grep -q . || { fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab; }
if [ -d /opt/bcm ]; then git -C /opt/bcm pull; else git clone https://github.com/kenedii/Browser-Crypto-Miner.git /opt/bcm; fi
cd /opt/bcm/stratum-bridge && docker compose up -d --build && docker compose ps
'@
($remote -replace "`r","") | ssh root@192.3.10.130 "bash -s"

Write-Host "`nDone. Tell Claude and it will verify the live site and bridge." -ForegroundColor Green
