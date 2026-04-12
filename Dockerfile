# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005

# Healthcheck para o Easypanel monitorar o estado
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3005/api/health || exit 1

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/build ./build

EXPOSE 3005

CMD ["node", "build/api.js"]
