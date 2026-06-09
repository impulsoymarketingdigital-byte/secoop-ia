FROM node:20-alpine

WORKDIR /app/backend

# Copia package.json y package-lock si existe
COPY backend/package*.json ./

# Instala dependencias de producción
RUN npm install --production

# Copia backend y frontend completos
COPY backend ./backend
COPY frontend ../frontend

# Exponer el puerto que usa el backend
ENV PORT=3000
EXPOSE 3000

# Ejecuta la app desde la carpeta backend
WORKDIR /app/backend
CMD ["npm", "start"]
