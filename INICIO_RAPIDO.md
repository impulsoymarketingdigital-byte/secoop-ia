# 🚀 JIREHAI – Guía de Inicio Rápido

**Asistente de Inteligencia para Licitaciones SECOP II Colombia**

---

## ⚡ OPCIÓN 1: Arranque Automático (Recomendado — Windows)

1. **Haz doble clic** en `INICIAR.bat` (en esta carpeta)
2. Espera a que aparezca el mensaje: `🚀 JIREHAI Backend corriendo en http://localhost:3001`
3. Abre tu navegador en: **http://localhost:3001/JIREHAI.html**

> La primera vez instala dependencias automáticamente (~2 min). Las siguientes veces arranca en segundos.

---

## 🖥️ OPCIÓN 2: Arranque Manual (Cualquier sistema)

### Requisitos
- **Node.js 18+** → [nodejs.org](https://nodejs.org)
- Terminal (CMD, PowerShell, Terminal, etc.)

### Pasos

```bash
# 1. Abrir terminal en la carpeta jieredai/backend/
cd jieredai/backend

# 2. Instalar dependencias (solo la primera vez)
npm install

# 3. Iniciar el servidor
node server.js
```

### 4. Abrir la app en el navegador
- **App Principal:** http://localhost:3001/JIREHAI.html
- **Panel Admin:** http://localhost:3001/admin.html
- **Landing Page:** http://localhost:3001/index.html

---

## 🔑 Credenciales de Prueba

| Rol | Email | Contraseña |
|-----|-------|------------|
| **Admin** | admin@jirehai.com | admin2025 |
| **Demo** | Cualquier email | Cualquier contraseña (modo offline) |

> **Modo offline:** Si el backend no está corriendo, la app sigue funcionando con datos locales. Puedes iniciar sesión con cualquier email/contraseña.

---

## ⚙️ Configuración del `.env`

Archivo: `jieredai/backend/.env`

| Variable | Descripción | Estado |
|----------|-------------|--------|
| `PORT` | Puerto (default: **3001**) | ✅ Configurado |
| `JWT_SECRET` | Clave de seguridad JWT | ✅ Configurado |
| `OPENAI_API_KEY` | Para análisis IA real con GPT-4 | ⚙️ Opcional |
| `SMTP_USER` / `SMTP_PASS` | Gmail para notificaciones por email | ⚙️ Opcional |
| `SECOP_BASE_URL` | URL API SECOP II | ✅ Configurado |

> **Nota Gmail:** Para que las notificaciones de email funcionen, necesitas usar una "Contraseña de Aplicación" de Gmail (no tu contraseña normal). Ve a: Mi Cuenta → Seguridad → Verificación en 2 pasos → Contraseñas de aplicación.

---

## 🎯 Funciones Principales

### 🔍 Procesos SECOP II
- Busca licitaciones en tiempo real desde la API oficial del SECOP II
- Filtra por modalidad, departamento, cuantía, palabras clave
- **Aplica** a procesos y guárdalos para seguimiento
- **Detalle** muestra análisis completo del pliego

### ✅ Procesos Aplicables
- Todos los procesos a los que has aplicado
- Exporta a **Excel** o **PDF** con un clic
- Análisis de cumplimiento por proceso

### 📅 Fechas Clave
- Calendario de vencimientos de los procesos aplicados
- Semáforo visual: 🔴 urgente / 🟡 próximo / 🟢 a tiempo

### 📁 Mis Documentos
- Registro de 10 documentos clave con fechas de vencimiento
- Alertas automáticas cuando un documento está próximo a expirar

### 📋 Formularios SECOP
- Guía completa para los 6 formularios del SECOP II
- Asistencia IA para completar cada campo

### 🔔 Notificaciones
- Alertas de nuevos procesos según tus filtros
- Notificaciones de vencimiento de documentos

---

## 📁 Estructura del Proyecto

```
jieredai/
├── INICIAR.bat              ← Arrancar en Windows (doble clic)
├── iniciar.sh               ← Arrancar en Mac/Linux
├── INICIO_RAPIDO.md         ← Este archivo
├── frontend/
│   ├── JIREHAI.html         ← App principal (React SPA)
│   ├── api.js               ← Cliente API (conecta al backend)
│   ├── index.html           ← Landing page comercial
│   └── admin.html           ← Panel de administración
└── backend/
    ├── server.js            ← API Express (32+ endpoints)
    ├── db.js                ← Base de datos SQLite (sql.js)
    ├── package.json         ← Dependencias Node.js
    ├── .env                 ← Variables de entorno (EDITAR AQUÍ)
    └── jirehai.db           ← Base de datos (se crea automático)
```

---

## 🔧 Endpoints del Backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Crear cuenta |
| POST | `/api/auth/login` | Iniciar sesión |
| GET/PUT | `/api/config` | Configuración del usuario |
| GET | `/api/procesos` | Búsqueda proxy SECOP II |
| POST | `/api/procesos/apply` | Aplicar a proceso |
| PUT | `/api/procesos/:id/analysis` | Guardar análisis |
| GET | `/api/documentos` | Lista de documentos |
| GET | `/api/notificaciones` | Notificaciones del usuario |
| GET | `/api/unspsc` | Códigos UNSPSC |
| GET | `/api/admin/stats` | Estadísticas admin |
| GET | `/api/health` | Health check |

---

## 🆘 Solución de Problemas

**El servidor no inicia**
→ Verifica que Node.js está instalado: `node --version`
→ Ejecuta `npm install` de nuevo en la carpeta `backend/`

**"No se encontraron procesos" en SECOP II**
→ Verifica tu conexión a internet
→ La API del SECOP II puede estar lenta — intenta de nuevo en unos minutos

**El backend arranca pero la app no conecta**
→ Verifica que abres la app en `http://localhost:3001/JIREHAI.html` (no con doble clic en el archivo)
→ El puerto debe ser **3001** (no 3000)

**El email de notificaciones no llega**
→ Configura `SMTP_PASS` con una "Contraseña de Aplicación" de Gmail (no tu contraseña normal)
→ Activa verificación en 2 pasos en tu cuenta Gmail primero

**Error al instalar dependencias (npm install)**
→ Verifica conexión a internet
→ Ejecuta CMD como administrador en Windows
→ Si falla `better-sqlite3`, ya está usando `sql.js` como alternativa compatible con Windows

---

**JIREHAI © 2026** · Inteligencia para Contratación Pública · Colombia 🇨🇴
