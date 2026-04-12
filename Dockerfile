FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy pre-compiled build (no TypeScript compilation needed)
COPY build/ ./build/

EXPOSE 8000

CMD ["node", "build/api.js"]
