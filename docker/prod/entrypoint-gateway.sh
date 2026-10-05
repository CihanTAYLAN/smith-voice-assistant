#!/bin/sh
# Gateway entrypoint (prod): provision -> migrate -> start.
# Herhangi bir adim duserse container baslamaz (set -e); Dokploy restart eder.
set -e
echo "[entrypoint] provision..."
node ./docker/prod/provision.mjs
echo "[entrypoint] prisma migrate deploy..."
# Yol COZUMLEMEsi pnpm'e birakildi: pnpm paketin kendi .bin shim'ini bulur.
# Elle yazilan yollar (node_modules/.bin/prisma) pnpm'in ./.pnpm/<paket>@<hash>
# duzeninde calismiyor ve sessizce "not found" veriyordu.
pnpm --filter @smith/db exec prisma migrate deploy
# Super kullanici baglantisi ve uygulama rolunun sifresi yalniz provision/migrate icin
# gerekti. Uzun omurlu gateway surecinin ortaminda (process.env, /proc/<pid>/environ,
# hata dokumu) kalmasin: surec ici kod calistirma smith_app sinirini asamasin.
# DATABASE_URL (smith_app) kalir; gateway onu kullanir.
unset MIGRATE_DATABASE_URL SMITH_APP_PASSWORD
echo "[entrypoint] gateway start..."
exec node apps/gateway/dist/index.js
