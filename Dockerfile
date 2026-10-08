# node:24-bookworm-slim, deliberately NOT alpine.
# sharp and better-sqlite3 both ship glibc/linux-x64 prebuilds; on musl they fall back
# to a source build that needs python3 + a compiler toolchain in the image.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/app/data/squareforge.db \
    TZ=Asia/Shanghai

WORKDIR /app

# Dependencies first so a source edit does not reinstall the world.
# devDependencies stay on purpose: the sources import each other with explicit `.ts`
# extensions (allowImportingTsExtensions), and TypeScript refuses to emit under that
# flag — there is no compiled build to copy out, so tsx is a runtime requirement.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

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
