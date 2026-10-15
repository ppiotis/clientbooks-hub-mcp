FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 \
    XERO_AGG_TOKEN_FILE=/data/tokens.enc XERO_AGG_EXPORT_DIR=/data/exports
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/serve-http.js"]
