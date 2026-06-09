# JIREHAI Backend

Backend API para JIREHAI - Asistente IA para licitaciones SECOP II en Colombia.

Construido con **Node.js, Express, SQLite** y integración con **SECOP II API** para búsqueda de procesos de contratación pública.

## Características

- Autenticación JWT segura
- Base de datos SQLite con transacciones
- API proxy para SECOP II
- Gestión de procesos aplicados y análisis
- Sistema de notificaciones con email
- Gestión de documentos (RUP, SOA, etc.)
- Códigos UNSPSC para clasificación
- Panel de administrador
- Tareas automáticas (CRON) para monitoreo
- Rate limiting y seguridad con Helmet

## Instalación Rápida

### 1. Clonar repositorio

```bash
cd /ruta/del/proyecto/jirehai
```

### 2. Instalar dependencias

```bash
cd backend
npm install
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env` con tus valores:

```bash
PORT=3000
JWT_SECRET=tu_secreto_super_seguro_cambiar_en_produccion
DB_PATH=./jirehai.db
SECOP_API_URL=https://www.datos.gov.co/resource/p6dx-8zbt.json
FRONTEND_URL=http://localhost:8080
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu_email@gmail.com
SMTP_PASS=contraseña_de_aplicación
```

### 4. Iniciar servidor

**Desarrollo (con auto-reload):**
```bash
npm run dev
```

**Producción:**
```bash
npm start
```

El servidor estará disponible en `http://localhost:3000`

## Wompi (pagos)

Configura estas variables en `backend/.env` para habilitar Wompi:

```bash
WOMPI_PUBLIC_KEY=pub_test_XXXXXXXXXXXXXXXXXXXXXX
WOMPI_INTEGRITY_KEY=test_integrity_XXXXXXXXXXXXXXXX
WOMPI_EVENTS_SECRET=test_events_XXXXXXXXXXXXXXXX
WOMPI_PRICE_PROFESIONAL=7900000
WOMPI_PRICE_EMPRESARIAL=14900000
FRONTEND_URL=https://tu-dominio.com
```

- `WOMPI_PUBLIC_KEY`: llave pública de Wompi
- `WOMPI_INTEGRITY_KEY`: llave de integridad para generar la firma del checkout
- `WOMPI_EVENTS_SECRET`: secreto para validar los webhooks
- `FRONTEND_URL`: dominio público donde se mostrará la app después del pago

**Webhook en Wompi**
- URL: `https://tu-dominio.com/api/wompi/webhook`
- Método: `POST`
- Asegúrate de usar HTTPS

## Estructura de Carpetas

```
backend/
├── server.js           # Servidor Express principal con todas las rutas
├── db.js               # Inicialización SQLite y seed de datos
├── package.json        # Dependencias Node.js
├── .env.example        # Template de variables de entorno
├── .env                # Archivo local (no versionar)
├── jirehai.db          # Base de datos SQLite (generado)
└── README.md           # Este archivo
```

## API Endpoints

### Autenticación

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/auth/register` | Registrar nuevo usuario |
| POST | `/api/auth/login` | Iniciar sesión |
| GET | `/api/auth/me` | Obtener datos del usuario autenticado |
| PUT | `/api/auth/password` | Cambiar contraseña |

### Procesos SECOP II

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/procesos` | Buscar procesos en SECOP II |
| GET | `/api/procesos/applied` | Listar procesos aplicados del usuario |
| POST | `/api/procesos/apply` | Agregar proceso a aplicaciones |
| PUT | `/api/procesos/:processNumber/analysis` | Guardar análisis de proceso |
| DELETE | `/api/procesos/:processNumber` | Eliminar proceso de aplicaciones |

### Configuración

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/config` | Obtener configuración del usuario |
| PUT | `/api/config` | Actualizar configuración |

### Documentos

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/documentos` | Listar documentos del usuario |
| PUT | `/api/documentos/:docType` | Actualizar documento |

### Notificaciones

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/notificaciones` | Obtener notificaciones |
| PUT | `/api/notificaciones/read` | Marcar notificaciones como leídas |
| GET | `/api/notificaciones/settings` | Obtener configuración de notificaciones |
| PUT | `/api/notificaciones/settings` | Actualizar configuración de notificaciones |

### UNSPSC

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/unspsc` | Listar códigos UNSPSC |
| POST | `/api/unspsc/suggest` | Sugerir códigos basado en texto |

### Admin (requiere rol admin)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/admin/stats` | Estadísticas del sistema |
| GET | `/api/admin/users` | Listar usuarios |
| POST | `/api/admin/users` | Crear usuario |
| PUT | `/api/admin/users/:id` | Actualizar usuario |
| DELETE | `/api/admin/users/:id` | Eliminar usuario |
| GET | `/api/admin/unspsc` | Listar códigos UNSPSC |
| POST | `/api/admin/unspsc` | Crear código UNSPSC |
| PUT | `/api/admin/unspsc/:id` | Actualizar código UNSPSC |
| DELETE | `/api/admin/unspsc/:id` | Eliminar código UNSPSC |
| GET | `/api/admin/subscriptions` | Listar suscripciones |

### Health Check

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/health` | Estado del servidor |

## Autenticación

Todas las rutas (excepto `/api/auth/register` y `/api/auth/login`) requieren el header:

```
Authorization: Bearer <JWT_TOKEN>
```

## Credenciales por Defecto

Al iniciar por primera vez, se crea un usuario administrador:

```
Email: admin@jirehai.com
Password: admin2025
Plan: empresarial
Role: admin
```

**Importante:** Cambiar estas credenciales en producción.

## Base de Datos

### Tablas principales

- **users** - Usuarios registrados
- **user_configs** - Configuración personalizada de cada usuario
- **applied_processes** - Procesos en los que el usuario se ha aplicado
- **user_documents** - Documentos del usuario (RUP, SOA, etc.)
- **unspsc_codes** - Catálogo de códigos UNSPSC
- **notifications** - Notificaciones del sistema
- **notification_settings** - Preferencias de notificación
- **subscriptions** - Suscripciones de usuarios
- **scan_log** - Log de búsquedas/escaneos

## Tareas Automáticas (CRON)

### Escaneo diario a las 7:00 AM

```
0 7 * * *
```

Verifica:
- Documentos próximos a vencer (30 días)
- Envía notificaciones por email si está habilitado

Puedes modificar la hora en `server.js` línea con `cron.schedule`.

## Configuración de Email

### Opción 1: Gmail SMTP

1. Habilitar autenticación de dos factores en Google
2. Generar contraseña de aplicación (App Password)
3. En `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu_email@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # 16 caracteres sin espacios
FROM_EMAIL=noreply@jirehai.com
```

### Opción 2: Otro proveedor SMTP

Reemplazar `SMTP_HOST` y credenciales según proveedor.

Si no está configurado, los emails se simulan en consola.

## Variabilidades SECOP II

El dataset de SECOP II puede variar entre versiones. El código normaliza automáticamente nombres de campo:

- `id_del_proceso` / `referencia_del_proceso`
- `descripcion_del_proceso` / `objeto_a_contratar`
- `cuantia_proceso` / `precio_base`
- `fecha_de_publicacion_del` / `fecha_publicacion`
- `fecha_limite_de_recepcion_d` / `fecha_limite_recepcion_de`

## Despliegue

### Option 1: Railway (Recomendado)

1. Conectar repositorio GitHub a Railway
2. Agregar variables de entorno en Railway dashboard
3. Deploy automático

```bash
# Railway detecta automaticamente:
npm install
npm start
```

### Option 2: Render

1. Crear nuevo Web Service en Render
2. Conectar repositorio
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Agregar variables de entorno

### Option 3: Docker / VPS con Dockploy

La app ya tiene un `Dockerfile` raíz, por lo que puedes desplegarla como contenedor.

1. Construye la imagen desde la raíz del proyecto:

```bash
docker build -t jirehai-app .
```

2. Prueba el contenedor localmente:

```bash
docker run -d --name jirehai-app -p 3000:3000 --env-file backend/.env jirehai-app
```

3. Si usas Dockploy en tu VPS, usa la imagen generada o el mismo `Dockerfile`.

4. Configura el webhook en Wompi:

   - URL: `https://tu-dominio.com/api/wompi/webhook`
   - Método: `POST`
   - Usa HTTPS para que Wompi pueda enviar eventos correctamente.

5. Asegúrate de que `backend/.env` tenga los valores de Wompi y `FRONTEND_URL` apuntando a tu dominio público.

### Option 4: VPS con PM2 + Nginx

```bash
# 1. Instalar PM2
npm install -g pm2

# 2. Iniciar con PM2
cd /ruta/del/backend
pm2 start server.js --name "jirehai-api"
pm2 save
pm2 startup

# 3. Crear config Nginx
sudo nano /etc/nginx/sites-available/jirehai
```

Configuración Nginx:

```nginx
server {
    listen 80;
    server_name api.jirehai.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# Activar sitio
sudo ln -s /etc/nginx/sites-available/jirehai /etc/nginx/sites-enabled/
sudo systemctl restart nginx
```

### Variables de Entorno en Producción

```bash
NODE_ENV=production
PORT=3000
JWT_SECRET=generar_con: openssl rand -base64 32
DB_PATH=/var/lib/jirehai/jirehai.db
FRONTEND_URL=https://jirehai.com
SECOP_API_URL=https://www.datos.gov.co/resource/p6dx-8zbt.json
```

## Monitoreo

### Logs en Producción

```bash
# Ver logs en tiempo real
pm2 logs jirehai-api

# Guardar logs
pm2 logs jirehai-api --raw > /var/log/jirehai.log
```

### Health Check

```bash
curl http://localhost:3000/api/health
```

Respuesta:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-04-14T10:30:00.000Z"
}
```

## Seguridad

- **HTTPS en producción:** Usar Let's Encrypt o certificado válido
- **JWT_SECRET:** Cambiar a valor aleatorio seguro
- **Rate Limiting:** Activado para `/api/` (300 req/15 min)
- **Helmet:** Headers de seguridad HTTP
- **CORS:** Configurado con `FRONTEND_URL`
- **SQLi Prevention:** Prepared statements con better-sqlite3
- **Password Hashing:** bcryptjs con salt 10

## Troubleshooting

### Error: "Cannot find module 'better-sqlite3'"

```bash
npm install
npm rebuild better-sqlite3
```

### Puerto 3000 en uso

```bash
# Cambiar en .env
PORT=3001
```

### Email no se envía

- Verificar credenciales SMTP en `.env`
- Check app password en Gmail (no contraseña normal)
- Ver logs en consola para error detallado

### Database locked

```bash
# SQLite WAL mode activado en db.js
# Si persiste, eliminar archivos -wal y -shm
rm jirehai.db-wal jirehai.db-shm
```

## Desarrollo

### Crear migraciones

Editar `db.js` función `initDB()` con nuevas tablas.

### Agregar rutas

Agregar en `server.js` debajo de secciones comentadas.

### Testing

```bash
# Hacer request de prueba
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@jirehai.com","password":"admin2025"}'
```

## Licencia

JIREHAI Backend - 2026

## Soporte

Para reportar issues o solicitar features, contactar al equipo de desarrollo.
