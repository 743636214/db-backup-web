FROM node:22-bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       default-mysql-client postgresql-client tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY db.js server.js ./
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=3080 \
    TZ=Asia/Shanghai

EXPOSE 3080
VOLUME ["/backups"]
CMD ["node", "server.js"]
