# Multi-stage: build both the SPA (vite) and the server (tsc), then ship
# only production deps + compiled output. Build tools never reach the
# runtime image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
