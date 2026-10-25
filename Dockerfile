# syntax=docker/dockerfile:1
# Production image: runtime dependencies only, non-root user, data on a volume.
#   docker build -t car-rental .
#   docker run -p 3000:3000 -v car-rental-data:/data --env-file .env car-rental

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-alpine
RUN apk add --no-cache tzdata
ENV NODE_ENV=production \
    APP_ENV=production \
    TZ=Asia/Jerusalem \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts/create-admin.js ./scripts/create-admin.js
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings", "src/server.js"]
