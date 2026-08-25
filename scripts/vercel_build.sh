#!/usr/bin/env bash
set -euo pipefail

npm --prefix packages/schema run build
npx --yes esbuild@0.25.9 apps/mcp-http/src/hosted.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile=api/hosted.bundle.mjs
rm -rf migrations
cp -R packages/persistence-postgres/migrations migrations
mkdir -p public
printf 'agent-feed-mcp' > public/.vercel-output-sentinel
