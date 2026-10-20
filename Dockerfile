# Native SQLite binaries may be unavailable for a Node version / CPU architecture.
# Keep the fallback compiler toolchain out of the runtime image.
FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# tsx is needed at runtime because the application runs TypeScript directly.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/app/data/squareforge.db \
    TZ=Asia/Shanghai

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules

COPY tsconfig.json ./
COPY src ./src

# The panel holds the Square posting keys and writes its SQLite file and chart PNGs here,
# so it runs unprivileged and the whole directory is a mounted volume.
RUN groupadd --system squareforge \
 && useradd --system --gid squareforge --create-home --home-dir /home/squareforge squareforge \
 && mkdir -p /app/data/charts \
 && chown -R squareforge:squareforge /app /home/squareforge
USER squareforge

EXPOSE 8787
VOLUME ["/app/data"]

# node, not curl/wget: the slim image has neither, and this avoids installing one just
# to answer a health probe.
HEALTHCHECK --interval=60s --timeout=6s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Direct node process as PID 1 so SIGTERM reaches the server; run compose with
# `init: true` if you need a reaper for the tsx loader's children.
CMD ["node", "--import", "tsx", "src/server/app.ts"]
