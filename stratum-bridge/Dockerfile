# BTC-only WebSocket -> Stratum TCP bridge
FROM node:20-slim

WORKDIR /app

# Install production dependencies (ws)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Application code
COPY bridge.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "bridge.js"]
