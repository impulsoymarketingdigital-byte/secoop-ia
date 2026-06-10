FROM node:20-alpine

WORKDIR /app

# Copia los package.json para instalar dependencias de workspace
COPY package.json ./
COPY backend/package.json ./backend/

# Instala dependencias de producción para el workspace backend
RUN npm install --production

# Copia el resto de la aplicación
COPY . ./

# Usamos el mismo puerto que debe configurar Dockploy en env vars
ENV PORT=8000
EXPOSE 8000

CMD ["npm", "start"]
