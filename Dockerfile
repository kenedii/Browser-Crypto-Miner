# Stage 1: build the frontend asset (de-comment / minify, no obfuscation)
FROM node:20-alpine AS build
WORKDIR /build
COPY mine-crypto.html miner.js ./
# Strip comments and collapse whitespace with terser; no identifier mangling.
RUN npx --yes terser@5 miner.js -c -o miner.min.js && mv miner.min.js miner.js

# Stage 2: serve the static frontend
FROM nginx:alpine
COPY --from=build /build/mine-crypto.html /usr/share/nginx/html/index.html
COPY --from=build /build/miner.js /usr/share/nginx/html/miner.js

# Nginx serves on port 80; deploy to Cloud Run with --port 80.
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

