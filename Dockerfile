# Stage 1: build the frontend assets (de-comment / minify, no obfuscation)
FROM node:20-alpine AS build
WORKDIR /build
# web/randomx.wasm* is optional (gitignored build artefact of WebRandomX/): the glob
# lets the image build without it, in which case Monero reports the VM as missing.
COPY web/mine-crypto.html web/miner.js web/lattice.js web/sha256.js web/scrypt.js web/randomx.js web/miner-worker.js web/scrypt-worker.js web/xmr-worker.js web/randomx.wasm* ./
# Strip comments and collapse whitespace with terser; no identifier mangling.
RUN for f in miner lattice sha256 scrypt randomx miner-worker scrypt-worker xmr-worker; do \
      npx --yes terser@5 $f.js -c -o $f.min.js && mv $f.min.js $f.js; \
    done
# Collect exactly the files the site serves (plus randomx.wasm when it exists).
RUN mkdir -p dist && cp mine-crypto.html dist/index.html && cp *.js dist/ && \
    ( cp randomx.wasm dist/ 2>/dev/null || \
      echo 'randomx.wasm not built - Monero mining will report it as missing' )

# Stage 2: serve the static frontend only. All mining traffic goes straight to
# the WebSocket stratum bridge on the VPS, so this container never proxies,
# computes or holds long-lived connections - it just serves a few cacheable files.
FROM nginx:alpine
COPY --from=build /build/dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Nginx serves on port 80; deploy to Cloud Run with --port 80.
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

