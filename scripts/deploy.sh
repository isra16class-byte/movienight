#!/usr/bin/env bash
# Fase 5 del plan de producción: "documentar y automatizar el despliegue".
#
# Para un VPS propio SIN Docker (con Docker, ver docker-compose.yml en su lugar). Junta
# en un solo comando los pasos que hasta ahora había que acordarse y correr a mano en el
# servidor después de aplicar un patch (ver docs/MEMORIA.md, "Cómo se trabaja en este
# repo"): traer el código nuevo, reinstalar dependencias si cambiaron, correr los checks
# que ya corre CI, y reiniciar el proceso supervisado por PM2 sin downtime.
#
# Uso, parado en el checkout del proyecto en el servidor:
#   ./scripts/deploy.sh
#
# Qué asume:
#   - El repo ya está clonado en el servidor y trackea la rama que se quiere desplegar
#     (normalmente "main" — no asume cuál, usa la que esté activa).
#   - PM2 ya corrió `npm run pm2:start` al menos una vez (ver README, "Proceso
#     supervisado") — este script reinicia el proceso, no lo crea de cero.
#   - Node/npm y PM2 (`npm install -g pm2`) ya están instalados en la máquina.
#
# Qué NO hace (a propósito, fuera del alcance de este script):
#   - No hace push por vos. El flujo de cómo el cambio llega a este repo (hoy manual con
#     git format-patch/git am, ver docs/MEMORIA.md) es un paso previo, aparte.
#   - No toca .env ni ninguna variable de entorno — se asume ya configurado en el server.

set -euo pipefail

# Falla temprano y con un mensaje claro en vez de un error críptico de git/pm2 a mitad
# de camino si falta algo.
command -v pm2 >/dev/null 2>&1 || { echo "❌ pm2 no está instalado (npm install -g pm2). Ver README, sección 'Proceso supervisado'." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm no está instalado." >&2; exit 1; }
[ -f package.json ] && [ -f server.js ] || { echo "❌ Este script se corre parado en la raíz del checkout de movienight." >&2; exit 1; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "▶ Desplegando rama '$BRANCH'..."

# Working tree sucio = alguien tocó algo a mano en el server, o quedó basura de una
# corrida anterior — mejor frenar y que lo revise una persona antes de pisarlo con git.
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Hay cambios sin commitear en el working tree del servidor. Revisalos antes de desplegar (git status)." >&2
  exit 1
fi

echo "▶ Trayendo el último commit de origin/$BRANCH..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "▶ Instalando dependencias (npm ci, incluye devDependencies para poder correr lint/tests abajo)..."
npm ci

# Mismos checks que corre CI (.github/workflows/ci.yml) antes de fusionar a main — se
# repiten acá porque "pasó en CI" y "es lo que realmente está corriendo en el server
# ahora mismo" no son necesariamente el mismo commit (ej. un despliegue manual fuera de
# orden, o una rama que no pasó por PR). Frenar acá evita reiniciar el proceso en vivo
# con algo roto.
echo "▶ Corriendo lint y tests antes de reiniciar el proceso en vivo..."
if ! npm run lint || ! npm test; then
  echo "❌ Lint o tests fallaron contra el código que se acaba de traer — NO se reinicia el proceso en vivo. Revisá el commit antes de reintentar." >&2
  exit 1
fi

echo "▶ Reiniciando movienight con PM2 (reload sin downtime si hay más de una instancia; restart si es una sola)..."
pm2 reload ecosystem.config.js --update-env || pm2 restart ecosystem.config.js --update-env

echo "✅ Deploy terminado. Ver estado: npm run pm2:status — logs: npm run pm2:logs"
