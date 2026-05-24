FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ src/
COPY packages/dashboard/dist/ packages/dashboard/dist/

EXPOSE 3847

ENV NODE_ENV=production
ENV BRIDGE_PORT=3847

CMD ["node", "--import", "tsx", "src/index.ts"]
