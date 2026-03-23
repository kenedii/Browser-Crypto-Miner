FROM nginx:alpine

# Copy static frontend files to NGINX HTML directory
COPY mine-crypto.html /usr/share/nginx/html/index.html
COPY miner.js /usr/share/nginx/html/miner.js

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
