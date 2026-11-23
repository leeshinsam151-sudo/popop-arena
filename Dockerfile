# 어떤 호스팅이든 컨테이너로 배포할 때 사용 (Fly.io, Railway, 개인 서버 등)
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
