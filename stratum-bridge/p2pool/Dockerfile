# P2Pool (Monero decentralized pool) - runs the official release binary against a
# REMOTE monerod, so no blockchain is stored on this server.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# Latest official release (resolved from the /releases/latest redirect, e.g. v4.x),
# or pin one with --build-arg P2POOL_VERSION=v4.3
ARG P2POOL_VERSION=latest
RUN set -eux; \
    if [ "$P2POOL_VERSION" = "latest" ]; then \
      TAG="$(curl -fsSIL -o /dev/null -w '%{url_effective}' https://github.com/SChernykh/p2pool/releases/latest | sed 's#.*/tag/##')"; \
    else TAG="$P2POOL_VERSION"; fi; \
    echo "Installing P2Pool $TAG"; \
    curl -fsSL -o /tmp/p2pool.tar.gz "https://github.com/SChernykh/p2pool/releases/download/${TAG}/p2pool-${TAG}-linux-x64.tar.gz"; \
    mkdir -p /opt/p2pool && tar -xzf /tmp/p2pool.tar.gz -C /opt/p2pool --strip-components=1; \
    rm /tmp/p2pool.tar.gz; test -x /opt/p2pool/p2pool

WORKDIR /opt/p2pool
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3333
ENTRYPOINT ["/entrypoint.sh"]
