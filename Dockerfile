FROM node:20-bookworm-slim AS deps

WORKDIR /app

# better-sqlite3 needs build tools when prebuilt binaries are unavailable
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

# ---- runtime image ----
FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY db.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

EXPOSE 3000
USER node

CMD ["node", "server.js"]
