# SiteSight API + worker, one process (Railway). The web app deploys separately (Vercel, see DEPLOY.md).
# glibc base: sharp and @napi-rs/canvas (PDF pages) ship prebuilt linux-x64-gnu binaries.
FROM node:22-bookworm-slim

# A base font so PDF pages that rely on standard fonts still render text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
# Manifests first so dependency installs are cached between deploys.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@sitesight/api..."

COPY packages/shared packages/shared
COPY apps/api apps/api

ENV NODE_ENV=production
WORKDIR /app/apps/api
# Node as PID 1 (not `pnpm run`), so SIGTERM reaches prod.ts and shutdown is graceful.
CMD ["node", "--import", "tsx", "src/prod.ts"]
