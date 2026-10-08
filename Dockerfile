# Stage 1: build the frontend assets (de-comment / minify, no obfuscation)
FROM node:20-alpine AS build
WORKDIR /build
COPY mine-crypto.html miner.js sha256.js miner-worker.js ./
# Strip comments and collapse whitespace with terser; no identifier mangling.
RUN npx --yes terser@5 miner.js -c -o miner.min.js && mv miner.min.js miner.js \
 && npx --yes terser@5 sha256.js -c -o sha256.min.js && mv sha256.min.js sha256.js \
 && npx --yes terser@5 miner-worker.js -c -o miner-worker.min.js && mv miner-worker.min.js miner-worker.js

# Stage 2: serve the static frontend only. All mining traffic goes straight to
# the WebSocket stratum bridge on the VPS, so this container never proxies,
# computes or holds long-lived connections - it just serves a few cacheable files.
FROM nginx:alpine
COPY --from=build /build/mine-crypto.html /usr/share/nginx/html/index.html
COPY --from=build /build/miner.js /usr/share/nginx/html/miner.js
COPY --from=build /build/sha256.js /usr/share/nginx/html/sha256.js
COPY --from=build /build/miner-worker.js /usr/share/nginx/html/miner-worker.js
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Nginx serves on port 80; deploy to Cloud Run with --port 80.
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

