FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    npm_config_update_notifier=false \
    npm_config_fund=false

# ffmpeg لازم للبث، tini لتنظيف العمليات، ca-certificates لاتصالات Discord
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-optional --no-audit --no-fund \
 && npm cache clean --force

COPY . .

RUN mkdir -p assets logs && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
