FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev

# Native Stockfish (latest official release). If the download or the CPU check fails,
# the server falls back to the bundled Stockfish WASM build.
FROM node:22-bookworm-slim AS engine
ARG SF_URL=https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64-avx2.tar
RUN mkdir -p /opt/sf && cd /tmp \
 && (node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('sf.tar',Buffer.from(b)))" "$SF_URL" \
     && tar xf sf.tar && find . -type f -name 'stockfish-ubuntu-x86-64-avx2' -exec cp {} /opt/sf/stockfish \; \
     && echo quit | /opt/sf/stockfish | head -1 && echo "native stockfish ready") \
 || (rm -f /opt/sf/stockfish; echo "native stockfish unavailable, WASM will be used")

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data STOCKFISH_PATH=/opt/sf/stockfish
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=engine /opt/sf /opt/sf
COPY package.json tsconfig.json ./
COPY server ./server
COPY shared ./shared
RUN mkdir -p /data
EXPOSE 3000
CMD ["sh", "-c", "[ -x \"$STOCKFISH_PATH\" ] || unset STOCKFISH_PATH; exec node --import tsx server/index.ts"]
