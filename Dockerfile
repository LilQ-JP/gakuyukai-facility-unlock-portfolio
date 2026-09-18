FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "src/server.js"]
