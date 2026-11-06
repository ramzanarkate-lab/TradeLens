# Optional: run the TradeLens server in a container. Not needed for normal development.
#   docker build -t tradelens-server .
#   docker run --rm -p 4000:4000 --env-file .env -v tradelens-data:/app/data tradelens-server
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 4000
# NODE_ENV=production requires JWT_SECRET (pass it with --env-file or -e). Secrets are never baked into the image.
CMD ["node", "dist/index.js"]
