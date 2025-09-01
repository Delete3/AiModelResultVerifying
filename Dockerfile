# 使用官方 Node.js 映像檔
FROM node:20

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json
COPY package.json ./
# 若有 package-lock.json 也一併複製
COPY package-lock.json ./

# 安裝依賴
RUN npm install

# 複製所有專案檔案
COPY . .

# 對外開放 5173 port (Vite 預設)
EXPOSE 5173

# 啟動 Vite 開發伺服器
CMD ["npm", "run", "dev"]