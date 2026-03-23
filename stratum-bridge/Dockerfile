# Use official Ubuntu image to support p2pool binary
FROM ubuntu:22.04

# Install Node.js, wget, tar, and dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    tar \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Download and install P2Pool
RUN wget https://github.com/SChernykh/p2pool/releases/download/v4.1/p2pool-v4.1-linux-x64.tar.gz \
    && tar -xvzf p2pool-v4.1-linux-x64.tar.gz \
    && mv p2pool-v4.1-linux-x64/p2pool /usr/local/bin/ \
    && rm -rf p2pool-v4.1-linux-x64*

# Set working directory
WORKDIR /app

# Copy dependency definitions
COPY package.json ./

# Install dependencies
RUN npm install --only=production

# Copy source code and start script
COPY bridge.js ./
COPY start.sh ./
RUN chmod +x start.sh

# Cloud Run defines PORT env variable, defaulting to 8080
ENV PORT=8080

# Start script as entrypoint
CMD [ "./start.sh" ]

