# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS native-build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src/native/db-connector
COPY native/db-connector/Cargo.toml native/db-connector/Cargo.lock ./
COPY native/db-connector/src ./src
RUN cargo test --locked && cargo build --release --locked

FROM node:24-bookworm-slim AS client-build
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
ENV VITE_API_BASE=/ VITE_DEPLOYMENT=cloud
RUN npm run build

FROM node:24-bookworm-slim AS server-build
WORKDIR /src/migration-gateway
COPY migration-gateway/package.json migration-gateway/package-lock.json ./
RUN npm ci
COPY migration-gateway/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    DBF_SESSION_DIR=/data/sessions DBF_CLIENT_DIR=/app/client \
    DBF_CONNECTOR_BIN=/app/bin/db-connector
WORKDIR /app
COPY --from=server-build /src/migration-gateway/node_modules ./node_modules
COPY --from=server-build /src/migration-gateway/dist ./dist
COPY --from=client-build /src/client/dist ./client
COPY --from=native-build /src/native/db-connector/target/release/db-connector ./bin/db-connector
RUN mkdir -p /data/sessions && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/web-main.js"]
