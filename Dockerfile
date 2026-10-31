FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev

# Stockfish 19: pinned official universal Linux binary, verified before use.
FROM node:22-bookworm-slim AS engine
ARG SF_URL=https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz
ARG SF_SHA256=9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f
RUN mkdir -p /opt/sf /tmp/sf && cd /tmp \
 && node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('sf.tar.gz',Buffer.from(b)))" "$SF_URL" \
 && echo "$SF_SHA256  sf.tar.gz" | sha256sum -c - \
 && tar xzf sf.tar.gz -C /tmp/sf \
 && find /tmp/sf -type f -name 'stockfish*' -perm /111 -exec cp {} /opt/sf/stockfish \; \
 && test -x /opt/sf/stockfish \
 && echo quit | /opt/sf/stockfish

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data STOCKFISH_PATH=/opt/sf/stockfish
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=engine /opt/sf /opt/sf
COPY package.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY scripts/native-benchmark.mjs ./scripts/native-benchmark.mjs
RUN mkdir -p /data
EXPOSE 3000
CMD ["node", "--import", "tsx", "scripts/native-benchmark.mjs"]
