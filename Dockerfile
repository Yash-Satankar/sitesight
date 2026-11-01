# SiteSight on Railway: ONE service. The API serves the built web app (same origin) and runs the worker in the same
# process (shared storage volume). glibc base: sharp and @napi-rs/canvas ship prebuilt linux-x64-gnu binaries.

# ---- build the web app ----
FROM node:22-bookworm-slim AS web
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@sitesight/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @sitesight/web build

# ---- runtime: API + worker, serving apps/web/dist ----
FROM node:22-bookworm-slim
# A base font so PDF pages that rely on standard fonts still render text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@sitesight/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY --from=web /app/apps/web/dist apps/web/dist

ENV NODE_ENV=production
WORKDIR /app/apps/api
# Same command as `pnpm start:prod` (migrations → API + worker), run directly so Node is PID 1 and gets SIGTERM.
CMD ["node", "--import", "tsx", "src/prod.ts"]
