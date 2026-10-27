# FairShift container for Google Cloud Run.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    STORAGE=firestore \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Run as the unprivileged user that ships with the Node image.
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
