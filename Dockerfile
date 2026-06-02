FROM node:24.16.0-alpine

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/src/server.js"]
