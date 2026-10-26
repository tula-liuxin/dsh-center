FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY web ./web
USER node
CMD ["node","server.js"]
