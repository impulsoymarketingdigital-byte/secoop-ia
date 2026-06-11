# 🚀 Guía de Despliegue JIREHAI en VPS con Dokploy

## Resumen de lo que se va a hacer
1. Preparar el código para el servidor (Git)
2. Instalar Dokploy en tu VPS
3. Crear la aplicación en Dokploy
4. Configurar variables de entorno
5. Configurar el dominio con HTTPS
6. Primer despliegue
7. Verificar que todo funciona

---

## PARTE 1 — Preparar el código en GitHub/GitLab

### Paso 1.1 — Asegúrate de que `.env` NO está en el repositorio

Verifica que `backend/.env` está ignorado:
```
# En la carpeta jieredai, ejecuta:
cat .gitignore
```
Debe tener estas líneas (ya las tiene):
```
.env
backend/.env
*.db
```
⚠️ **NUNCA subas el archivo `.env` a GitHub. Contiene contraseñas reales.**

### Paso 1.2 — Crear el repositorio en GitHub

1. Ve a https://github.com/new
2. Nombre del repo: `jirehai` (o el que prefieras)
3. Visibilidad: **Private** (recomendado)
4. Haz clic en **Create repository**

### Paso 1.3 — Subir el código

Desde la carpeta `jieredai/` en tu PC:
```bash
git init
git add .
git commit -m "Initial commit - JIREHAI v1.0"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/jirehai.git
git push -u origin main
```

---

## PARTE 2 — Instalar Dokploy en tu VPS

### Requisitos del VPS
- Ubuntu 20.04 o 22.04 (recomendado)
- Mínimo 2 GB RAM (recomendado 4 GB por el motor IA + Playwright)
- Mínimo 20 GB de disco
- Acceso SSH como root o con sudo

### Paso 2.1 — Conectar al VPS por SSH

```bash
ssh root@IP_DE_TU_VPS
```

### Paso 2.2 — Instalar Dokploy

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Este comando instala Docker, Docker Compose y el panel de Dokploy automáticamente.

### Paso 2.3 — Acceder al panel de Dokploy

Una vez instalado, abre en el navegador:
```
http://IP_DE_TU_VPS:3000
```

Crea tu cuenta de administrador la primera vez que entras.

---

## PARTE 3 — Crear la aplicación en Dokploy

### Paso 3.1 — Conectar tu cuenta de GitHub

1. En Dokploy, ve a **Settings** → **Git Providers**
2. Haz clic en **Add GitHub Provider**
3. Sigue las instrucciones para autorizar Dokploy en tu cuenta de GitHub

### Paso 3.2 — Crear la aplicación

1. Haz clic en **Create Project** → **Application**
2. Nombre: `jirehai`
3. En **Source**, selecciona **GitHub**
4. Selecciona el repositorio `jirehai`
5. Branch: `main`
6. Build Type: **Dockerfile** (detecta automáticamente el `Dockerfile`)
7. Haz clic en **Create**

### Paso 3.3 — Configurar el puerto

En la sección **Ports** de la aplicación:
- Container Port: `8000`
- Published Port: `8000`

---

## PARTE 4 — Configurar Variables de Entorno

En la pestaña **Environment** de tu aplicación en Dokploy, agrega estas variables:

```env
# ── Puerto (requerido) ──────────────────────────────────────
PORT=8000

# ── Modo ───────────────────────────────────────────────────
NODE_ENV=production

# ── JWT (cambia esto por una cadena larga y aleatoria) ─────
JWT_SECRET=pon_aqui_una_clave_muy_larga_y_aleatoria_32_chars_minimo

# ── Base de datos ──────────────────────────────────────────
DB_PATH=/app/backend/data/jirehai.db

# ── OpenAI (motor de IA SECOP) ─────────────────────────────
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ── Email (Gmail SMTP) ─────────────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=impulsoymarketingdigital@gmail.com
SMTP_PASS=xxxx_xxxx_xxxx_xxxx   # Contraseña de aplicación de Gmail (16 chars)

# ── URL del frontend (tu dominio) ──────────────────────────
FRONTEND_URL=https://tu-dominio.com

# ── Wompi (pagos Colombia) ─────────────────────────────────
WOMPI_PUBLIC_KEY=pub_test_xxxxxxxxxxxxxxxxxxxxxxxx
WOMPI_PRIVATE_KEY=prv_test_xxxxxxxxxxxxxxxxxxxxxxxx
WOMPI_INTEGRITY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WOMPI_EVENTS_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### ⚠️ Cómo obtener cada variable

**JWT_SECRET** — Genera una en tu PC:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**EMAIL_PASS** — Contraseña de aplicación de Gmail (no tu contraseña normal):
1. Ve a https://myaccount.google.com/security
2. Activa **Verificación en 2 pasos** si no la tienes
3. Busca **Contraseñas de aplicaciones**
4. Crea una nueva → selecciona "Correo" → copia la contraseña de 16 caracteres

**WOMPI** — Ve a https://comercios.wompi.co
1. Inicia sesión en tu cuenta de comercio
2. Ve a **Desarrolladores** → **Llaves de API**
3. Copia las 4 claves (pública, privada, integridad, eventos)

---

## PARTE 5 — Configurar Volumen para la Base de Datos

Esto es **crítico** — sin volumen, la base de datos se borra cada vez que se redespliega.

En la pestaña **Volumes** de tu aplicación en Dokploy:

1. Haz clic en **Add Volume**
2. Type: **Named Volume** (o Bind Mount si prefieres)
3. Container Path: `/app/backend/data`
4. Volume Name: `jirehai_db`
5. Guarda

Agrega un segundo volumen para las salidas del motor IA:
1. Container Path: `/app/backend/ai/outputs`
2. Volume Name: `jirehai_ai_outputs`

---

## PARTE 6 — Configurar Dominio y HTTPS

### Paso 6.1 — Apuntar tu dominio al VPS

En el panel DNS de tu proveedor de dominio (GoDaddy, Cloudflare, etc.):

| Tipo | Nombre | Valor              |
|------|--------|--------------------|
| A    | @      | IP_DE_TU_VPS       |
| A    | www    | IP_DE_TU_VPS       |

Espera 5-15 minutos para que se propague.

### Paso 6.2 — Configurar dominio en Dokploy

1. En la pestaña **Domains** de tu aplicación
2. Haz clic en **Add Domain**
3. Host: `tu-dominio.com`
4. HTTPS: ✅ activado (Dokploy usa Let's Encrypt automáticamente)
5. Path: `/`
6. Guarda

### Paso 6.3 — Actualizar FRONTEND_URL

Vuelve a **Environment** y actualiza:
```
FRONTEND_URL=https://tu-dominio.com
```

---

## PARTE 7 — Primer Despliegue

### Paso 7.1 — Iniciar el build

1. Ve a la pestaña **Deployments** de tu aplicación
2. Haz clic en **Deploy**
3. Dokploy descargará el código, construirá la imagen Docker y arrancará el contenedor

⏱️ El primer build tarda **5-10 minutos** porque:
- Descarga la imagen base de Node (20-slim)
- Instala Python y Tesseract OCR
- Instala paquetes Python (motor IA)
- Instala Playwright Chromium

Los siguientes builds son mucho más rápidos (usa caché de capas Docker).

### Paso 7.2 — Verificar los logs

En la pestaña **Logs** verás algo como:
```
🚀 JIREHAI Backend corriendo en puerto 8000
🗄️  Base de datos inicializada correctamente
👤 Super admin verificado: impulsoymarketingdigital@gmail.com
```

Si ves errores, los más comunes son:
- **"JWT_SECRET not set"** → verifica la variable de entorno
- **"Cannot connect to DB"** → verifica que el volumen está configurado
- **"OpenAI API error"** → verifica OPENAI_API_KEY

### Paso 7.3 — Verificar que funciona

Abre en el navegador:
```
https://tu-dominio.com/api/health
```
Debe responder:
```json
{"status": "ok", "timestamp": "..."}
```

Luego abre la app:
```
https://tu-dominio.com/
```

---

## PARTE 8 — Actualizaciones futuras

Cuando hagas cambios en tu código:

```bash
# En tu PC, desde la carpeta jieredai/
git add .
git commit -m "Descripción del cambio"
git push origin main
```

Luego en Dokploy:
- Haz clic en **Deploy** → Dokploy detecta el nuevo commit y redespliegue automáticamente

O configura **Auto Deploy**: En **Settings** de tu app → activa **Auto Deploy on Push** y Dokploy desplegará automáticamente cada vez que hagas `git push`.

---

## Resumen de URLs una vez desplegado

| Recurso | URL |
|---------|-----|
| Aplicación principal | `https://tu-dominio.com/` |
| Panel Admin | `https://tu-dominio.com/admin.html` |
| API Health Check | `https://tu-dominio.com/api/health` |
| Panel Dokploy | `http://IP_VPS:3000` |

---

## Credenciales del Super Admin

- **Email**: impulsoymarketingdigital@gmail.com
- **Contraseña**: M@riate2026*
- **Rol**: admin (plan empresarial sin fecha de vencimiento)

---

## ¿Problemas frecuentes?

**El contenedor arranca pero la app no carga:**
→ Revisa los logs en Dokploy → pestaña Logs
→ Verifica que el puerto 8000 no está bloqueado por el firewall del VPS

**La base de datos se resetea en cada deploy:**
→ El volumen no está configurado → repite el Paso 5

**Los emails no se envían:**
→ Verifica SMTP_HOST, SMTP_USER y SMTP_PASS
→ Asegúrate de usar Contraseña de Aplicación de Gmail, no tu contraseña normal

**La IA no funciona:**
→ Verifica OPENAI_API_KEY
→ En los logs busca errores de Python

**Wompi no procesa pagos:**
→ Verifica que las 4 variables WOMPI_* están correctas
→ Para pruebas usa las llaves de prueba (pub_test_ / prv_test_)
→ Para producción real usa las llaves de producción (pub_prod_ / prv_prod_)
