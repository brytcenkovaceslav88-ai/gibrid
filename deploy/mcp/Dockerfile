FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# index.html сайта монтируется в /app/site (см. docker-compose.yml)
ENV INDEX_HTML_PATH=/app/site/index.html
EXPOSE 8000
USER node
CMD ["node", "src/server.js"]
