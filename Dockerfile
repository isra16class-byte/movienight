# Fase 5 del plan de producción ("documentar y automatizar el despliegue").
#
# Pensado para funcionar igual en cualquier hosting basado en Docker (VPS propio,
# Railway, Render, Fly.io) — ver docs/PLAN-PRODUCCION.md, Fase 0: "mantener el trabajo
# de infraestructura agnóstico de proveedor". No asume Redis/Postgres/R2 en la imagen:
# esas son variables de entorno en runtime (ver README y .env.example), no algo que se
# hornea en el build.
#
# Sin dependencias nativas que compilar (bcryptjs es JS puro, no bcrypt; pg usa su
# driver JS por default), así que alcanza una sola etapa de Node liviano — pero se usa
# multi-stage igual para que la imagen final no cargue devDependencies (eslint, etc.).

FROM node:22-alpine AS deps
WORKDIR /app
# Solo los manifiestos primero: capa de Docker cacheable, no se reinstala todo en cada
# cambio de server.js si package.json no cambió.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Usuario sin privilegios (la imagen base ya trae "node", uid 1000) — el proceso no
# corre como root dentro del contenedor.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# public/uploads/ es donde vive el video en modo disco local (sin R2 configurado, ver
# README). server.js lo crea solo si falta, pero se prepara acá con los permisos
# correctos para el usuario "node" — y queda declarado como volumen para que, si el
# hosting lo pisa con un volumen real, los videos sobrevivan a que se recree el
# contenedor (en modo R2 esta carpeta no se usa para nada, así que no molesta tenerla).
RUN mkdir -p public/uploads && chown -R node:node /app
VOLUME ["/app/public/uploads"]

USER node

EXPOSE 3000

# El mismo endpoint que ya usa el resto del proyecto como healthcheck (README, sección
# "Proceso supervisado"). node:22-alpine no trae curl instalado por default y sumarlo
# infla la imagen sin necesidad — un healthcheck de una línea con el módulo http nativo
# alcanza.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
