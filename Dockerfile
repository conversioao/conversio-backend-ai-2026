FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3005

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy pre-compiled build (no TypeScript compilation needed)
COPY build/ ./build/

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3005/api/health || exit 1

EXPOSE 3005

CMD ["node", "build/api.js"]
