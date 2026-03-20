FROM node:18-alpine

WORKDIR /app

# 安装 pnpm
RUN npm install -g pnpm

# 先复制依赖文件以利用 Docker 层缓存
COPY package.json ./
RUN pnpm install --prod

# 复制源码
COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
