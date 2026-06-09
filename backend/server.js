require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const dbModule = require('./db');

let db; // Se asigna después de initDB()

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'jirehai_dev_secret_2025';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const SECOP_API = process.env.SECOP_API_URL || 'https://www.datos.gov.co/resource/p6dx-8zbt.json';

// ── MIDDLEWARE ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Wompi webhook recibe body raw para verificar firma ──
app.use('/api/wompi/webhook', express.raw({ type: 'application/json' }));

// Rate limiter for auth
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

// ── AUTH MIDDLEWARE ──
function authMiddleware(req, res, next) {
  // Accept token from Authorization header OR ?token= query param (needed for <a href> file downloads)
  const auth = req.headers.authorization;
  const queryToken = req.query.token;
  let token = null;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.substring(7);
  } else if (queryToken) {
    token = queryToken;
  }
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado — solo administradores' });
  next();
}

// ── EMAIL SERVICE ──
let transporter = null;

function buildTransporter() {
  if (!process.env.SMTP_HOST && !process.env.SMTP_USER) return null;
  const port = parseInt(process.env.SMTP_PORT) || 587;
  const secure = port === 465; // true solo para SSL/465, false para STARTTLS/587
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    requireTLS: !secure,           // obliga STARTTLS en puerto 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false } // necesario en hosting compartido
  });
}

transporter = buildTransporter();

// Verificar conexión SMTP al arrancar (no bloquea)
if (transporter) {
  transporter.verify().then(() => {
    console.log('✅ SMTP listo — emails habilitados');
  }).catch(err => {
    console.warn('⚠️  SMTP no disponible:', err.message);
    console.warn('   → Verifica SMTP_HOST, SMTP_USER, SMTP_PASS en .env');
    transporter = null; // fallback a modo simulado
  });
} else {
  console.log('📧 Email en modo simulado — configura SMTP_HOST y SMTP_USER en .env');
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`📧 Email (simulado) a ${to}: ${subject}`);
    return true;
  }
  try {
    const info = await transporter.sendMail({
      from: `"JIREHAI" <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
      to,
      subject,
      html
    });
    console.log(`📧 Email enviado a ${to} → MessageId: ${info.messageId}`);
    return true;
  } catch (e) {
    console.error(`❌ Error enviando email a ${to}:`, e.message);
    return false;
  }
}

// ── HELPERS ──
function getUserConfig(userId) {
  const row = db.prepare('SELECT config_json FROM user_configs WHERE user_id = ?').get(userId);
  return row ? JSON.parse(row.config_json) : {};
}

function saveUserConfig(userId, config) {
  const exists = db.prepare('SELECT id FROM user_configs WHERE user_id = ?').get(userId);
  if (exists) {
    db.prepare('UPDATE user_configs SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
      .run(JSON.stringify(config), userId);
  } else {
    db.prepare('INSERT INTO user_configs (user_id, config_json) VALUES (?, ?)').run(userId, JSON.stringify(config));
  }
}

function addNotification(userId, type, title, message) {
  db.prepare('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)').run(userId, type, title, message);
}

// ═══════════════════════════════════════
// SUSCRIPCIÓN & LÍMITES DE USO
// ═══════════════════════════════════════

// Límites diarios de análisis IA por plan
const DAILY_LIMITS = {
  basico:       5,   // prueba gratuita (3 días)
  profesional:  30,  // plan pagado mensual
  empresarial:  100, // plan empresarial
  admin:        Infinity,
};

/**
 * Devuelve el estado de suscripción del usuario.
 * { allowed, reason, plan, trialDaysLeft, planDaysLeft }
 */
function getUserSubscriptionStatus(userId) {
  const user = db.prepare(
    'SELECT id, role, plan, trial_expires_at, plan_expires_at FROM users WHERE id = ?'
  ).get(userId);
  if (!user) return { allowed: false, reason: 'Usuario no encontrado' };

  // Administradores: siempre permitido, sin límites
  if (user.role === 'admin') return { allowed: true, plan: 'admin', role: 'admin' };

  const now = new Date();

  // ¿Tiene suscripción activa pagada?
  if (user.plan_expires_at) {
    const expPaid = new Date(user.plan_expires_at);
    if (expPaid > now) {
      const planDaysLeft = Math.ceil((expPaid - now) / 86400000);
      return { allowed: true, plan: user.plan, planDaysLeft };
    }
    // Plan pagado vencido
    return {
      allowed: false,
      reason: 'Tu suscripción venció. Renueva para continuar.',
      plan: user.plan,
      expired: true,
    };
  }

  // ¿Está en período de prueba?
  if (user.trial_expires_at) {
    const expTrial = new Date(user.trial_expires_at);
    if (expTrial > now) {
      const trialDaysLeft = Math.ceil((expTrial - now) / 86400000);
      return { allowed: true, plan: 'basico', trialDaysLeft };
    }
    return {
      allowed: false,
      reason: 'Tu período de prueba de 3 días ha vencido. Suscríbete para continuar.',
      plan: 'basico',
      trialExpired: true,
    };
  }

  // Sin trial y sin plan pagado → usuario antiguo, se le da acceso (sin corte)
  return { allowed: true, plan: user.plan || 'basico' };
}

/** Middleware: bloquea acceso a rutas de IA si la suscripción expiró */
function subscriptionMiddleware(req, res, next) {
  const status = getUserSubscriptionStatus(req.user.id);
  if (!status.allowed) {
    return res.status(402).json({
      error: status.reason,
      code: status.trialExpired ? 'TRIAL_EXPIRED' : 'SUBSCRIPTION_EXPIRED',
      subscriptionRequired: true,
    });
  }
  req.subscriptionStatus = status;
  next();
}

/** Devuelve el uso de análisis de IA del día actual para un usuario */
function getDailyUsage(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    'SELECT analyses_used, tokens_used FROM daily_token_usage WHERE user_id = ? AND usage_date = ?'
  ).get(userId, today);
  return row || { analyses_used: 0, tokens_used: 0 };
}

/** Incrementa el contador diario de análisis */
function incrementDailyUsage(userId, tokenCount = 0) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_token_usage (user_id, usage_date, analyses_used, tokens_used, updated_at)
    VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, usage_date) DO UPDATE SET
      analyses_used = analyses_used + 1,
      tokens_used   = tokens_used + excluded.tokens_used,
      updated_at    = CURRENT_TIMESTAMP
  `).run(userId, today, tokenCount);
}

/** Middleware: verifica que el usuario no superó el límite diario de análisis */
function dailyLimitMiddleware(req, res, next) {
  const user = db.prepare('SELECT role, plan FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.role === 'admin') return next();

  const limit = DAILY_LIMITS[user.plan] ?? DAILY_LIMITS.basico;
  if (!isFinite(limit)) return next();

  const { analyses_used } = getDailyUsage(req.user.id);
  if (analyses_used >= limit) {
    return res.status(429).json({
      error: `Alcanzaste el límite diario de ${limit} análisis para el plan ${user.plan}. Vuelve mañana o actualiza tu plan.`,
      code: 'DAILY_LIMIT_EXCEEDED',
      limitReached: true,
      analysesUsed: analyses_used,
      dailyLimit: limit,
    });
  }
  next();
}

// ═══════════════════════════════════════
// WOMPI — Pasarela de pagos colombiana
// ═══════════════════════════════════════

/** Precios por plan en centavos de COP */
const WOMPI_PRICES = {
  profesional: parseInt(process.env.WOMPI_PRICE_PROFESIONAL || '7900000'),   // $ 79,000 COP
  empresarial: parseInt(process.env.WOMPI_PRICE_EMPRESARIAL || '14900000'),  // $149,000 COP
};

/**
 * Genera la firma de integridad para el enlace de pago Wompi.
 * SHA256(reference + amount_in_cents + currency + integrity_secret)
 */
function wompiIntegritySignature(reference, amountCents, currency, integritySecret) {
  const str = `${reference}${amountCents}${currency}${integritySecret}`;
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Verifica la firma del evento de webhook Wompi.
 * SHA256(transaction.id + transaction.status + transaction.amount_in_cents + timestamp + events_secret)
 */
function verifyWompiWebhook(body, secret) {
  try {
    const event = typeof body === 'string' ? JSON.parse(body) : body;
    const tx = event?.data?.transaction;
    if (!tx) return null;
    const str = `${tx.id}${tx.status}${tx.amount_in_cents}${event.timestamp}${secret}`;
    const expected = crypto.createHash('sha256').update(str, 'utf8').digest('hex');
    const checksum = event.signature?.checksum || '';
    return checksum === expected ? event : null;
  } catch { return null; }
}

// ═══════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════
app.post('/api/auth/register', authLimiter, (req, res) => {
  const { name, email, password, plan } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(409).json({ error: 'Este email ya está registrado' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(`INSERT INTO users (name, email, password_hash, plan, trial_expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+3 days'))`).run(name, email, hash, plan || 'basico');
  const userId = result.lastInsertRowid;
  db.prepare('INSERT INTO notification_settings (user_id, notification_email) VALUES (?, ?)').run(userId, email);
  const token = jwt.sign({ id: userId, email, role: 'user', plan: plan || 'basico' }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  sendEmail(email, '¡Bienvenido a JIREHAI!', `
    <h2>¡Bienvenido a JIREHAI, ${name}!</h2>
    <p>Tu cuenta ha sido creada exitosamente.</p>
    <p><strong>⏳ Período de prueba gratuita: 3 días</strong> — aprovecha para explorar todas las funciones.</p>
    <p>Al finalizar, elige un plan para continuar accediendo sin interrupciones.</p>
    <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3001'}/JIREHAI.html">Ir a la aplicación →</a></p>
  `);
  addNotification(userId, 'system', '¡Bienvenido a JIREHAI!', 'Tu cuenta ha sido creada. Tienes 3 días de prueba gratuita. Configura tu empresa para comenzar.');
  res.status(201).json({ token, user: { id: userId, name, email, plan: plan || 'basico', role: 'user' }, trialDays: 3 });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Credenciales inválidas' });
  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, plan: user.plan }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, role: user.role } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, name, email, plan, role, created_at, last_login FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(user);
});

app.put('/api/auth/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Contraseñas requeridas' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 6 caracteres' });
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ success: true, message: 'Contraseña actualizada' });
});

// POST /api/auth/forgot-password — genera token y envía email de recuperación
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });

  // Respuesta genérica para no revelar si el email existe
  const successMsg = { success: true, message: 'Si ese correo existe, recibirás un enlace de recuperación.' };

  const user = db.prepare('SELECT id, name FROM users WHERE email = ? AND active = 1').get(email);
  if (!user) return res.json(successMsg); // silently ignore

  // Limpiar tokens anteriores del mismo usuario
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);

  // Generar token seguro (64 hex chars)
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES (?, ?, datetime('now', '+1 hour'))`).run(user.id, token);

  const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3001';
  const resetLink = `${frontendBase}/JIREHAI.html?reset_token=${token}`;

  await sendEmail(email, 'JIREHAI — Recupera tu contraseña', `
    <h2>Recuperación de contraseña</h2>
    <p>Hola <strong>${user.name}</strong>,</p>
    <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta.</p>
    <p>Haz clic en el siguiente enlace (válido por <strong>1 hora</strong>):</p>
    <p><a href="${resetLink}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
      Restablecer contraseña
    </a></p>
    <p style="color:#666;font-size:12px;">Si no solicitaste esto, ignora este mensaje. Tu contraseña no cambiará.</p>
    <p style="color:#666;font-size:12px;">Enlace: ${resetLink}</p>
  `);

  res.json(successMsg);
});

// POST /api/auth/reset-password — verifica token y actualiza contraseña
app.post('/api/auth/reset-password', authLimiter, (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Token y nueva contraseña requeridos' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });

  const record = db.prepare(`SELECT * FROM password_reset_tokens
    WHERE token = ? AND used = 0 AND expires_at > CURRENT_TIMESTAMP`).get(token);

  if (!record) return res.status(400).json({ error: 'El enlace de recuperación es inválido o ha expirado. Solicita uno nuevo.' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, record.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);

  addNotification(record.user_id, 'system', 'Contraseña actualizada', 'Tu contraseña fue cambiada exitosamente.');
  res.json({ success: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });
});

// GET /api/auth/validate-reset-token — verifica si el token sigue vigente (para el frontend)
app.get('/api/auth/validate-reset-token', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });
  const record = db.prepare(`SELECT id FROM password_reset_tokens
    WHERE token = ? AND used = 0 AND expires_at > CURRENT_TIMESTAMP`).get(token);
  res.json({ valid: !!record });
});

// ═══════════════════════════════════════
// CONFIG ROUTES
// ═══════════════════════════════════════
app.get('/api/config', authMiddleware, (req, res) => {
  const config = getUserConfig(req.user.id);
  res.json(config);
});

app.put('/api/config', authMiddleware, (req, res) => {
  saveUserConfig(req.user.id, req.body);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// SECOP II — AUTO-DISCOVERY DE COLUMNAS
// ═══════════════════════════════════════
// El dataset p6dx-8zbt en datos.gov.co Socrata tiene nombres de columna que
// varían y NO están bien documentados. Descubrimos las columnas reales
// haciendo una petición de 1 registro al arrancar y cacheamos el resultado.
let secopSchema = {
  dateColumn:   null,   // columna de fecha de cierre (contiene 'cierre')
  pubColumn:    null,   // columna de fecha de publicación
  estadoColumn: null,   // columna de estado del proceso (Publicado, Abierto, etc.)
  descColumn:   null,   // columna de descripción/objeto del proceso
  discovered:   false,
  discovering:  false,
  allColumns:   []      // todas las columnas, para debug
};

async function discoverSecopSchema() {
  if (secopSchema.discovered || secopSchema.discovering) return;
  secopSchema.discovering = true;
  console.log('🔍 Auto-discovering SECOP II column names…');
  try {
    const r = await axios.get(SECOP_API + '?$limit=1', {
      timeout: 15000,
      headers: { Accept: 'application/json' }
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      secopSchema.allColumns = keys;
      console.log('📋 SECOP II columns:', keys.join(', '));

      // Columna de fecha de cierre: buscar 'cierre' en el nombre
      secopSchema.dateColumn =
        keys.find(k => /cierre/i.test(k)) ||
        keys.find(k => /limite.*recepci/i.test(k)) ||
        null;

      // Columna de fecha de publicación
      secopSchema.pubColumn =
        keys.find(k => /fecha/i.test(k) && /publicaci/i.test(k)) ||
        keys.find(k => /publicaci/i.test(k) && /fecha/i.test(k)) ||
        keys.find(k => /^fecha_de_publicaci/i.test(k)) ||
        null;

      // Columna de estado del proceso
      secopSchema.estadoColumn =
        keys.find(k => /^estado_del_proc/i.test(k)) ||
        keys.find(k => /^estado_del_proced/i.test(k)) ||
        keys.find(k => /^estado/i.test(k)) ||
        null;

      // Columna de descripción/objeto: buscar variantes con y sin tildes
      secopSchema.descColumn =
        keys.find(k => /descripci/i.test(k)) ||           // descripcion_del_proceso, descripci_n...
        keys.find(k => /objeto.*contrat/i.test(k)) ||     // objeto_del_contrato
        keys.find(k => /nombre.*proc/i.test(k)) ||        // nombre_del_procedimiento
        keys.find(k => k === 'objeto') ||
        null;

      console.log(`✅ dateColumn="${secopSchema.dateColumn}" | pubColumn="${secopSchema.pubColumn}" | estadoColumn="${secopSchema.estadoColumn}" | descColumn="${secopSchema.descColumn}"`);
    } else {
      console.log('⚠️  Discovery: no records returned from SECOP II');
    }
  } catch (e) {
    console.error('❌ SECOP schema discovery failed:', e.message);
  }
  secopSchema.discovered   = true;
  secopSchema.discovering  = false;
}

// Normaliza un registro crudo de Socrata agregando campos con prefijo _
// para que el frontend no dependa de los nombres de columna de Socrata.
function normalizeSecopRecord(proc) {
  const dc = secopSchema.dateColumn;
  const pc = secopSchema.pubColumn;
  const sc = secopSchema.descColumn;
  const ec = secopSchema.estadoColumn;
  return {
    ...proc,
    _entidad:          proc.entidad || proc.nombre_entidad || '',
    _descripcion:      (sc ? proc[sc] : '') ||
                       proc.descripcion_del_proceso ||
                       proc.descripci_n_del_procedimiento ||
                       proc.nombre_del_procedimiento ||
                       proc.objeto ||
                       '',
    _fechaCierre:      (dc ? proc[dc] : '') ||
                       proc.fecha_de_cierre ||
                       '',
    _fechaPublicacion: (pc ? proc[pc] : '') ||
                       proc.fecha_de_publicacion_del ||
                       proc.fecha_de_publicacion ||
                       '',
    _estado:           (ec ? proc[ec] : '') ||
                       proc.estado_del_proceso ||
                       proc.estado_del_procedimiento ||
                       proc.estado ||
                       '',
    _cuantia:          parseFloat(proc.precio_base || proc.cuantia_proceso || 0) || 0,
    _modalidad:        proc.modalidad_de_contratacion || proc.modalidad || '',
    _departamento:     proc.departamento_entidad || proc.departamento || proc.ciudad_entidad || '',
    _url:              proc.url_proceso || proc.urlproceso || '',
    _referencia:       proc.referencia_del_proceso || proc.numero_del_proceso || proc.id_del_proceso || ''
  };
}

// ═══════════════════════════════════════
// SECOP II PROXY ROUTES
// ═══════════════════════════════════════
app.get('/api/procesos', authMiddleware, async (req, res) => {
  try {
    // ── Asegurar que tengamos el schema descubierto ────────────────────────
    if (!secopSchema.discovered) {
      await discoverSecopSchema();
    }

    const PAGE_SIZE = 2000;
    const limit  = Math.min(parseInt(req.query.limit  || PAGE_SIZE, 10), PAGE_SIZE);
    const offset = parseInt(req.query.offset || '0', 10);
    const now    = new Date();
    const today  = now.toISOString().slice(0, 10);
    // Ventana de publicación: máximo 60 días antes de hoy
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // ── Build $where clause (SoQL) ─────────────────────────────────────────
    // DO NOT use upper() — not supported on datos.gov.co Socrata.
    // DO NOT use URLSearchParams — encodes spaces as '+' which Socrata rejects.
    const whereParts = [];
    if (secopSchema.dateColumn) {
      // Solo procesos vigentes (cierre >= hoy)
      whereParts.push(`${secopSchema.dateColumn} >= '${today}T00:00:00'`);
    }
    if (secopSchema.pubColumn) {
      // Solo procesos publicados en los últimos 60 días (descarta procesos de 2025)
      whereParts.push(`${secopSchema.pubColumn} >= '${sixtyDaysAgo}T00:00:00'`);
    }
    if (req.query.nombre_entidad) {
      whereParts.push(`entidad = '${req.query.nombre_entidad.replace(/'/g, "''")}'`);
    }
    if (req.query.departamento) {
      whereParts.push(`departamento_entidad = '${req.query.departamento.replace(/'/g, "''")}'`);
    }
    if (req.query.unspscFilter) {
      whereParts.push(`codigo_unspsc = '${req.query.unspscFilter.replace(/'/g, "''")}'`);
    }

    // ── Build URL manually ─────────────────────────────────────────────────
    let apiUrl = `${SECOP_API}?$limit=${limit}&$offset=${offset}`;

    // Ordenar por fecha de publicación descendente (más recientes primero)
    if (secopSchema.pubColumn) {
      apiUrl += `&$order=${encodeURIComponent(secopSchema.pubColumn + ' DESC')}`;
    } else if (secopSchema.dateColumn) {
      apiUrl += `&$order=${encodeURIComponent(secopSchema.dateColumn + ' ASC')}`;
    }
    if (whereParts.length > 0) {
      apiUrl += `&$where=${encodeURIComponent(whereParts.join(' AND '))}`;
    }
    if (req.query.keywords) {
      apiUrl += `&$q=${encodeURIComponent(req.query.keywords)}`;
    }
    if (req.query.modalidad_de_contratacion) {
      apiUrl += `&modalidad_de_contratacion=${encodeURIComponent(req.query.modalidad_de_contratacion)}`;
    }

    console.log('SECOP II query:', apiUrl.substring(0, 250));

    const response = await axios.get(apiUrl, {
      timeout: 30000,
      headers: { 'Accept': 'application/json' }
    });

    let data = (response.data || []).map(normalizeSecopRecord);

    // ── Filtrar por estado: solo Publicado / Abierto / Activo ─────────────
    if (secopSchema.estadoColumn) {
      const ESTADOS_VALIDOS = ['publicado', 'abierto', 'activo', 'convocado'];
      data = data.filter(p => {
        const est = (p[secopSchema.estadoColumn] || '').toLowerCase().trim();
        return ESTADOS_VALIDOS.some(v => est.includes(v));
      });
    }

    // ── Filtro adicional de año: descartar cualquier remanente de 2025 ─────
    data = data.filter(p => {
      const fechaPub = p._fechaPublicacion || '';
      if (!fechaPub) return true; // si no hay fecha, dejarlo pasar
      return !fechaPub.startsWith('2025') && !fechaPub.startsWith('2024') && !fechaPub.startsWith('2023');
    });

    // Apply value-range filters server-side
    if (req.query.minVal) data = data.filter(p => p._cuantia >= parseFloat(req.query.minVal));
    if (req.query.maxVal) data = data.filter(p => p._cuantia <= parseFloat(req.query.maxVal));

    // Log scan
    db.prepare('INSERT INTO scan_log (user_id, scan_type, processes_found) VALUES (?, ?, ?)').run(req.user.id, 'manual', data.length);

    res.json({
      data,
      total: data.length,
      hasMore: data.length === limit,
      schema: { dateColumn: secopSchema.dateColumn, descColumn: secopSchema.descColumn }
    });
  } catch (error) {
    console.error('SECOP API error:', error.message);
    console.error('Status:', error.response?.status, '| Response:', JSON.stringify(error.response?.data)?.substring(0, 400));
    res.status(502).json({ error: 'Error consultando SECOP II. Intenta nuevamente.', detail: error.message });
  }
});

// ═══════════════════════════════════════
// APPLIED PROCESSES ROUTES
// ═══════════════════════════════════════
app.get('/api/procesos/applied', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM applied_processes WHERE user_id = ? ORDER BY applied_at DESC').all(req.user.id);
  const result = rows.map(r => ({
    ...r,
    process_data: JSON.parse(r.process_data_json || '{}'),
    analysis: r.analysis_json ? JSON.parse(r.analysis_json) : null
  }));
  res.json(result);
});

app.post('/api/procesos/apply', authMiddleware, (req, res) => {
  const { processNumber, processData } = req.body;
  if (!processNumber) return res.status(400).json({ error: 'Número de proceso requerido' });
  try {
    db.prepare(`INSERT INTO applied_processes (user_id, process_number, process_data_json)
                VALUES (?, ?, ?) ON CONFLICT(user_id, process_number) DO NOTHING`)
      .run(req.user.id, processNumber, JSON.stringify(processData || {}));
    addNotification(req.user.id, 'proceso', 'Proceso aplicado', `Proceso ${processNumber} agregado a tus aplicaciones`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/procesos/:processNumber/analysis', authMiddleware, (req, res) => {
  const { analysis, observations, cumple } = req.body;
  db.prepare(`UPDATE applied_processes
              SET analysis_json = ?, observations = ?, cumple = ?, analyzed_at = CURRENT_TIMESTAMP
              WHERE user_id = ? AND process_number = ?`)
    .run(JSON.stringify(analysis || {}), observations || '', cumple || 'pendiente', req.user.id, req.params.processNumber);
  res.json({ success: true });
});

app.delete('/api/procesos/:processNumber', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM applied_processes WHERE user_id = ? AND process_number = ?').run(req.user.id, req.params.processNumber);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// ANALISIS DE PLIEGOS (PDF → MD → IA)
// ═══════════════════════════════════════

// Extrae una sección del texto PDF buscando encabezados clave
function extractSection(text, keywords, maxChars = 600) {
  const upper = text.toUpperCase();
  for (const kw of keywords) {
    const idx = upper.indexOf(kw.toUpperCase());
    if (idx !== -1) {
      const start = idx;
      const end = Math.min(start + maxChars, text.length);
      return text.slice(start, end).trim().replace(/\n{3,}/g, '\n\n');
    }
  }
  return null;
}

// Convierte texto plano de PDF a Markdown estructurado
function textToMarkdown(rawText, processData) {
  const entidad = processData._entidad || processData.nombre_entidad || processData.entidad || '';
  const objeto  = processData._descripcion || processData.descripcion_del_proceso || processData.object || processData.objeto || '';
  const cuantia = processData._cuantia || processData.precio_base || processData.cuantía || 0;
  const modalidad = processData._modalidad || processData.modalidad_de_contratacion || processData.modalidad || '';
  const referencia = processData._referencia || processData.referencia_del_proceso || processData.numero_del_proceso || '';
  const fechaCierre = processData._fechaCierre || processData.fecha_de_cierre_del_proceso || processData.fecha_de_cierre || '';
  const urlSecop = processData._url || processData.url_proceso || processData.urlSecop || '';

  let md = `# Pliego de Condiciones\n\n`;
  md += `**Entidad:** ${entidad}\n`;
  md += `**Referencia:** ${referencia}\n`;
  md += `**Objeto:** ${objeto}\n`;
  md += `**Modalidad:** ${modalidad}\n`;
  md += `**Cuantía:** $${parseFloat(cuantia || 0).toLocaleString('es-CO')}\n`;
  if (fechaCierre) md += `**Fecha de Cierre:** ${fechaCierre.slice(0, 10)}\n`;
  if (urlSecop)    md += `**URL SECOP:** ${urlSecop}\n`;
  md += `\n---\n\n`;
  md += `## Contenido del Documento\n\n`;
  // Normalizar saltos de línea y conservar estructura
  md += rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .substring(0, 12000);
  return md;
}

// Análisis básico por extracción de texto (sin IA)
function analyzeByExtraction(text, processData) {
  const entidad    = processData._entidad    || processData.nombre_entidad    || processData.entidad    || 'la entidad';
  const objeto     = (processData._descripcion || processData.descripcion_del_proceso || processData.object || processData.objeto || '').substring(0, 150);
  const modalidad  = processData._modalidad  || processData.modalidad_de_contratacion  || processData.modalidad  || '';
  const referencia = processData._referencia || processData.referencia_del_proceso || processData.numero_del_proceso || '';
  const cuantia    = processData._cuantia    || processData.precio_base || processData.cuantía || 0;
  const urlSecop   = processData._url        || processData.url_proceso || processData.urlSecop || '';
  const fechaCierre = processData._fechaCierre || processData.fecha_de_cierre_del_proceso || processData.fecha_de_cierre || '';
  const fechaPub    = processData._fechaPublicacion || processData.fecha_de_publicacion_del || processData.fecha_de_publicacion || '';

  // Calcular días restantes
  let diasRestantes = '';
  if (fechaCierre) {
    const diff = Math.ceil((new Date(fechaCierre) - Date.now()) / 86400000);
    diasRestantes = diff > 0 ? `${diff} días` : 'Vencido';
  }

  const cuantiaFmt = cuantia ? `$${parseFloat(cuantia).toLocaleString('es-CO')}` : 'No especificada';

  return {
    resumenEjecutivo: `Proceso de ${modalidad} convocado por ${entidad}. Objeto: ${objeto}. Cuantía: ${cuantiaFmt}. Cierre: ${fechaCierre ? fechaCierre.slice(0,10) : 'Ver SECOP II'} (${diasRestantes || 'N/A'}).`,
    requisitosHabilitantes: extractSection(text, ['REQUISITOS HABILITANTES','HABILITACIÓN','CONDICIONES DE PARTICIPACIÓN','CAPACIDAD JURÍDICA']) ||
      'RUT actualizado, Cámara de Comercio vigente, Certificados de experiencia, Paz y salvo de parafiscales, Garantía de seriedad.',
    criteriosEvaluacion: extractSection(text, ['CRITERIOS DE EVALUACIÓN','FACTORES DE EVALUACIÓN','PUNTAJE','CALIFICACIÓN','PROPUESTA TÉCNICA']) ||
      'Propuesta económica, Experiencia específica del proponente, Capacidad técnica y residual de contratación.',
    analisisRiesgos: extractSection(text, ['ANÁLISIS DE RIESGO','RIESGOS','GESTIÓN DEL RIESGO','MATRIZ DE RIESGO']) ||
      'Proceso competitivo. Verificar requisitos habilitantes antes de presentar propuesta. Revisar pliego completo en SECOP II.',
    documentosHabilitantes: extractSection(text, ['DOCUMENTOS HABILITANTES','DOCUMENTOS REQUERIDOS','CERTIFICADOS','ANEXOS REQUERIDOS']) ||
      'RUT, Cámara de Comercio, Certificados de experiencia, Estados financieros, Garantía de seriedad de la oferta.',
    cuestionarioAnexos: extractSection(text, ['CUESTIONARIO','ANEXO','FORMATO','FORMULARIO']) ||
      'Ver anexos y formularios específicos en el pliego de condiciones publicado en SECOP II.',
    cronograma: extractSection(text, ['CRONOGRAMA','CALENDARIO','FECHAS DEL PROCESO','ETAPAS DEL PROCESO']) ||
      `Publicación: ${fechaPub ? fechaPub.slice(0,10) : 'Ver SECOP II'} | Cierre: ${fechaCierre ? fechaCierre.slice(0,10) : 'Ver SECOP II'} | Días restantes: ${diasRestantes || 'N/A'}`,
    capacidadFinanciera: extractSection(text, ['CAPACIDAD FINANCIERA','INDICADORES FINANCIEROS','CAPITAL DE TRABAJO','PATRIMONIO']) ||
      'Según los índices financieros definidos en el pliego de condiciones del proceso.',
    // Campos clave del proceso
    numeroProceso:  referencia,
    cuantiaTotal:   cuantiaFmt,
    fechaCierre:    fechaCierre ? fechaCierre.slice(0, 10) : '',
    diasRestantes:  diasRestantes,
    urlSecop:       urlSecop,
    cumplimiento:   'Parcial'
  };
}

app.post('/api/procesos/analyze-pliego', authMiddleware, async (req, res) => {
  const { processData, referencia } = req.body;
  if (!processData) return res.status(400).json({ error: 'Datos del proceso requeridos' });

  let pdfText = '';
  let documentsFound = 0;
  let pdfSource = 'ninguno';

  try {
    // ─── PASO 1: Buscar documentos del proceso en datos.gov.co ───
    const procRef = referencia ||
      processData._referencia ||
      processData.referencia_del_proceso ||
      processData.numero_del_proceso ||
      processData.id_del_proceso ||
      processData.id || '';

    if (procRef) {
      try {
        // Dataset de documentos SECOP II
        const docsUrl = `https://www.datos.gov.co/resource/jbjy-vk9h.json?$where=referencia_del_proceso='${encodeURIComponent(procRef)}'&$limit=10`;
        const docsRes = await axios.get(docsUrl, { timeout: 10000 });
        const docs = docsRes.data || [];
        documentsFound = docs.length;

        // ─── PASO 2: Descargar y parsear cada PDF ───
        for (const doc of docs.slice(0, 4)) {
          const pdfUrl = doc.url_del_documento || doc.url || '';
          if (!pdfUrl) continue;
          try {
            const pdfRes = await axios.get(pdfUrl, {
              responseType: 'arraybuffer',
              timeout: 20000,
              headers: { 'User-Agent': 'Mozilla/5.0 JIREHAI/1.0' }
            });
            const parsed = await pdfParse(Buffer.from(pdfRes.data));
            if (parsed.text && parsed.text.length > 50) {
              pdfText += parsed.text + '\n\n---\n\n';
              pdfSource = 'secop_api';
            }
          } catch (pdfErr) {
            console.log(`⚠️  No se pudo descargar/parsear PDF: ${pdfUrl} — ${pdfErr.message}`);
          }
        }
      } catch (docsErr) {
        console.log('⚠️  No se encontraron documentos via API:', docsErr.message);
      }
    }

    // ─── PASO 3: Intentar URL directa del proceso si no hubo PDFs ───
    const urlProceso = processData._url || processData.url_proceso || processData.urlproceso || processData.urlSecop || '';
    if (!pdfText && urlProceso) {
      try {
        const pageRes = await axios.get(urlProceso, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        // Extraer texto básico de la página HTML
        const htmlText = pageRes.data.replace(/<[^>]+>/g, ' ').replace(/\s{3,}/g, '\n');
        if (htmlText.length > 200) {
          pdfText = htmlText.substring(0, 8000);
          pdfSource = 'html_page';
        }
      } catch (urlErr) {
        console.log('⚠️  No se pudo acceder a la URL del proceso:', urlErr.message);
      }
    }

    // ─── PASO 4: Generar Markdown del contenido extraído ───
    const markdownContent = pdfText.length > 100
      ? textToMarkdown(pdfText, processData)
      : null;

    // ─── PASO 5: Análisis — OpenAI si hay clave y texto, si no extracción básica ───
    let analysis;
    const hasOpenAI = !!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('sk-');
    const hasText = pdfText.length > 200;

    // Extraer campos clave del proceso (normalizados primero, raw como fallback)
    const _entidad    = processData._entidad    || processData.nombre_entidad    || processData.entidad    || '';
    const _objeto     = processData._descripcion || processData.descripcion_del_proceso || processData.object || processData.objeto || '';
    const _modalidad  = processData._modalidad  || processData.modalidad_de_contratacion  || processData.modalidad  || '';
    const _referencia = processData._referencia || processData.referencia_del_proceso || processData.numero_del_proceso || procRef || '';
    const _cuantia    = processData._cuantia    || processData.precio_base || processData.cuantía || 0;
    const _urlSecop   = processData._url        || processData.url_proceso || processData.urlproceso || processData.urlSecop || '';
    const _fechaCierre = processData._fechaCierre || processData.fecha_de_cierre_del_proceso || processData.fecha_de_cierre || '';
    const _fechaPub    = processData._fechaPublicacion || processData.fecha_de_publicacion_del || processData.fecha_de_publicacion || '';
    const _estado      = processData._estado    || processData.estado_del_proceso || processData.estado || '';
    const _depto       = processData._departamento || processData.departamento_entidad || processData.departamento || '';
    const _cuantiaFmt  = _cuantia ? `$${parseFloat(_cuantia).toLocaleString('es-CO')}` : 'No especificada';

    // Calcular días restantes
    let _diasRestantes = '';
    if (_fechaCierre) {
      const diff = Math.ceil((new Date(_fechaCierre) - Date.now()) / 86400000);
      _diasRestantes = diff > 0 ? `${diff} días` : 'Vencido';
    }

    if (hasText && hasOpenAI) {
      // Análisis completo con IA sobre el texto real del pliego
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{
            role: 'system',
            content: 'Eres un experto en contratación pública colombiana. Analiza pliegos de condiciones SECOP II y extrae información estructurada en JSON válido.'
          }, {
            role: 'user',
            content: `Analiza este pliego de condiciones y responde ÚNICAMENTE con JSON válido (sin markdown, sin texto adicional):

NÚMERO DE PROCESO: ${_referencia}
ENTIDAD: ${_entidad}
DEPARTAMENTO: ${_depto}
OBJETO: ${_objeto}
MODALIDAD: ${_modalidad}
ESTADO: ${_estado}
CUANTÍA ESTIMADA: ${_cuantiaFmt}
FECHA DE CIERRE: ${_fechaCierre ? _fechaCierre.slice(0,10) : 'Ver SECOP II'}
DÍAS RESTANTES: ${_diasRestantes || 'N/A'}
FECHA PUBLICACIÓN: ${_fechaPub ? _fechaPub.slice(0,10) : 'N/A'}
LINK SECOP II: ${_urlSecop || 'No disponible'}

TEXTO DEL PLIEGO:
${pdfText.substring(0, 6500)}

JSON a retornar (incluye TODOS estos campos):
{
  "numeroProceso": "número o referencia del proceso tal como aparece",
  "resumenEjecutivo": "resumen ejecutivo del proceso en 3-4 oraciones incluyendo cuantía y fecha límite",
  "requisitosHabilitantes": "requisitos habilitantes completos (jurídicos, financieros, técnicos, de experiencia)",
  "criteriosEvaluacion": "criterios de evaluación y puntajes si los hay",
  "analisisRiesgos": "análisis de riesgos del proceso y recomendaciones",
  "documentosHabilitantes": "lista de documentos requeridos para presentar propuesta",
  "cuestionarioAnexos": "cuestionarios, formatos y anexos requeridos",
  "cronograma": "fechas y etapas del proceso extraídas del pliego",
  "capacidadFinanciera": "índices y requisitos financieros específicos",
  "cuantiaTotal": "valor exacto del contrato o estimación",
  "fechaCierre": "fecha de cierre del proceso (YYYY-MM-DD)",
  "diasRestantes": "días restantes para el cierre",
  "urlSecop": "link del proceso en SECOP II",
  "cumplimiento": "Sí o Parcial o No — evaluación de viabilidad de participación"
}`
          }],
          max_tokens: 2500,
          temperature: 0.2
        });

        const raw = completion.choices[0].message.content.trim();
        // Limpiar posibles bloques de markdown alrededor del JSON
        const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
        analysis = JSON.parse(jsonStr);
        pdfSource = 'openai_' + pdfSource;
      } catch (aiErr) {
        console.log('⚠️  OpenAI error, usando extracción básica:', aiErr.message);
        analysis = analyzeByExtraction(pdfText, processData);
      }
    } else if (hasText) {
      // Texto disponible pero sin OpenAI — extracción por regex
      analysis = analyzeByExtraction(pdfText, processData);
    } else {
      // Sin texto — análisis basado solo en metadatos del proceso
      analysis = analyzeByExtraction('', processData);
      pdfSource = 'metadata_only';
    }

    // Asegurar que los campos clave siempre estén presentes (rellenar si el AI los omitió)
    if (!analysis.numeroProceso)  analysis.numeroProceso  = _referencia;
    if (!analysis.cuantiaTotal)   analysis.cuantiaTotal   = _cuantiaFmt;
    if (!analysis.fechaCierre)    analysis.fechaCierre    = _fechaCierre ? _fechaCierre.slice(0, 10) : '';
    if (!analysis.diasRestantes)  analysis.diasRestantes  = _diasRestantes;
    if (!analysis.urlSecop)       analysis.urlSecop       = _urlSecop;

    analysis.analyzedAt = new Date().toISOString();
    analysis.pdfSource = pdfSource;
    analysis.documentsFound = documentsFound;
    analysis.textLength = pdfText.length;

    // ─── PASO 6: Guardar análisis en base de datos ───
    const procNumber = procRef || (processData.nombre_entidad + '_' + Date.now());
    db.prepare(`
      UPDATE applied_processes
      SET analysis_json = ?, cumple = ?, analyzed_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND process_number = ?
    `).run(JSON.stringify(analysis), analysis.cumplimiento || 'parcial', req.user.id, procNumber);

    res.json({
      success: true,
      analysis,
      markdown: markdownContent,
      meta: {
        pdfSource,
        documentsFound,
        textLength: pdfText.length,
        usedOpenAI: hasOpenAI && hasText
      }
    });

  } catch (err) {
    console.error('Error en analyze-pliego:', err);
    res.status(500).json({ error: 'Error analizando el pliego', detail: err.message });
  }
});

// ═══════════════════════════════════════
// DOCUMENTS ROUTES
// ═══════════════════════════════════════
app.get('/api/documentos', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM user_documents WHERE user_id = ?').all(req.user.id);
  res.json(rows);
});

app.put('/api/documentos/:docType', authMiddleware, (req, res) => {
  const { expiryDate, notes } = req.body;
  const exists = db.prepare('SELECT id FROM user_documents WHERE user_id = ? AND doc_type = ?').get(req.user.id, req.params.docType);
  if (exists) {
    db.prepare('UPDATE user_documents SET expiry_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND doc_type = ?')
      .run(expiryDate || null, notes || '', req.user.id, req.params.docType);
  } else {
    db.prepare('INSERT INTO user_documents (user_id, doc_type, expiry_date, notes) VALUES (?, ?, ?, ?)').run(req.user.id, req.params.docType, expiryDate || null, notes || '');
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════
// NOTIFICATIONS ROUTES
// ═══════════════════════════════════════
app.get('/api/notificaciones', authMiddleware, (req, res) => {
  const notifs = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const unreadCount = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id).cnt;
  res.json({ notifications: notifs, unreadCount });
});

app.put('/api/notificaciones/read', authMiddleware, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

app.get('/api/notificaciones/settings', authMiddleware, (req, res) => {
  const settings = db.prepare('SELECT * FROM notification_settings WHERE user_id = ?').get(req.user.id);
  res.json(settings || {});
});

app.put('/api/notificaciones/settings', authMiddleware, (req, res) => {
  const { emailEnabled, notifyNewProcesses, notifyClosingSoon, notifyDocsExpiring, notifyUnspscMatch, scanInterval, notificationEmail } = req.body;
  const exists = db.prepare('SELECT id FROM notification_settings WHERE user_id = ?').get(req.user.id);
  if (exists) {
    db.prepare(`UPDATE notification_settings SET
      email_enabled=?, notify_new_processes=?, notify_closing_soon=?, notify_docs_expiring=?,
      notify_unspsc_match=?, scan_interval=?, notification_email=?, updated_at=CURRENT_TIMESTAMP
      WHERE user_id=?`).run(emailEnabled?1:0, notifyNewProcesses?1:0, notifyClosingSoon?1:0, notifyDocsExpiring?1:0, notifyUnspscMatch?1:0, scanInterval||4, notificationEmail||'', req.user.id);
  } else {
    db.prepare(`INSERT INTO notification_settings (user_id, email_enabled, notify_new_processes, notify_closing_soon, notify_docs_expiring, notify_unspsc_match, scan_interval, notification_email) VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.user.id, emailEnabled?1:0, notifyNewProcesses?1:0, notifyClosingSoon?1:0, notifyDocsExpiring?1:0, notifyUnspscMatch?1:0, scanInterval||4, notificationEmail||'');
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════
// UNSPSC ROUTES
// ═══════════════════════════════════════
app.get('/api/unspsc', authMiddleware, (req, res) => {
  const { search } = req.query;
  let codes;
  if (search) {
    codes = db.prepare(`SELECT * FROM unspsc_codes WHERE active=1 AND (code LIKE ? OR description LIKE ? OR keywords LIKE ?) LIMIT 50`).all(`%${search}%`, `%${search}%`, `%${search}%`);
  } else {
    codes = db.prepare('SELECT * FROM unspsc_codes WHERE active = 1 ORDER BY category, code').all();
  }
  res.json(codes);
});

app.post('/api/unspsc/suggest', authMiddleware, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto requerido' });
  const allCodes = db.prepare('SELECT * FROM unspsc_codes WHERE active = 1').all();
  const lower = text.toLowerCase();
  const scored = allCodes.map(c => {
    let score = 0;
    const kws = (c.keywords || '').split(',').map(k => k.trim());
    kws.forEach(k => { if (k && lower.includes(k.toLowerCase())) score += k.length > 6 ? 3 : 2; });
    const words = lower.split(/\s+/);
    words.forEach(w => { if (w.length > 3 && c.description.toLowerCase().includes(w)) score += 1; });
    return { ...c, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  res.json(scored);
});

// ═══════════════════════════════════════
// AI - ANÁLISIS DE PLIEGOS
// ═══════════════════════════════════════

const PROMPT_ANALISIS_PLIEGO = `Eres un experto en contratación pública colombiana con más de 20 años de experiencia analizando pliegos de condiciones en SECOP II.

Analiza el siguiente pliego de condiciones y responde EXCLUSIVAMENTE en formato JSON válido con esta estructura:

{
  "resumenEjecutivo": "Descripción clara de qué se contrata, para quién, plazo de ejecución y presupuesto oficial",
  "objetoContractual": "El objeto exacto del contrato tal como aparece en el pliego",
  "presupuestoOficial": "Valor del presupuesto oficial en pesos colombianos",
  "plazoEjecucion": "Plazo de ejecución del contrato",
  "lugarEjecucion": "Municipio/departamento donde se ejecuta",
  "requisitosHabilitantes": {
    "juridicos": ["lista de cada documento jurídico exigido"],
    "financieros": {
      "indicadores": [{"nombre": "Nombre del indicador", "condicion": ">=, <=, etc.", "valor": 0}],
      "patrimonio_minimo": "valor o fórmula",
      "ingresos_minimos": "valor o fórmula"
    },
    "experiencia": {
      "general": "descripción de experiencia general requerida",
      "especifica": "descripción de experiencia específica",
      "contratos_minimos": 0,
      "cuantia_acumulada_smmlv": 0,
      "codigos_clasificador": ["códigos UNSPSC o clasificador requeridos"]
    },
    "tecnicos": ["certificaciones, equipo mínimo, personal clave requerido"]
  },
  "criteriosEvaluacion": [
    {"criterio": "nombre", "puntaje_maximo": 0, "descripcion": "cómo se evalúa y otorga puntaje"}
  ],
  "fechasClave": [
    {"evento": "nombre del hito", "fecha": "fecha si está disponible"}
  ],
  "garantias": ["tipos de garantías exigidas con porcentajes y vigencias"],
  "riesgos": ["riesgos identificados para el proponente"],
  "adendas": "si se mencionan adendas o modificaciones",
  "recomendaciones": ["acciones concretas para presentar una oferta competitiva"]
}

IMPORTANTE:
- Extrae SOLO información que esté explícitamente en el documento
- Si un campo no se encuentra en el texto, usa null o array vacío
- Sé preciso con cifras, fechas y porcentajes
- No inventes información que no esté en el pliego`;

const PROMPT_CUMPLIMIENTO = `Eres un experto en contratación pública colombiana. Con base en el análisis del pliego y los datos de la empresa del proponente, evalúa si la empresa cumple los requisitos habilitantes.

Responde EXCLUSIVAMENTE en formato JSON:

{
  "cumpleGeneral": "SI" | "NO" | "PARCIAL",
  "puntajeCumplimiento": 0-100,
  "detalleJuridico": {"cumple": true/false, "faltantes": ["documentos que faltan"]},
  "detalleFinanciero": {"cumple": true/false, "observaciones": ["indicadores que no cumple"]},
  "detalleExperiencia": {"cumple": true/false, "observaciones": ["qué falta en experiencia"]},
  "detalleTecnico": {"cumple": true/false, "observaciones": ["requisitos técnicos no cumplidos"]},
  "recomendacion": "Recomendación clara: presentarse, asociarse (UT/consorcio), o descartar",
  "accionesRequeridas": ["lista de acciones concretas para cumplir lo que falta"],
  "riesgoCompetitivo": "BAJO" | "MEDIO" | "ALTO",
  "justificacionRiesgo": "Por qué el riesgo competitivo es ese nivel"
}`;

// Inicializar OpenAI (singleton lazy)
let _openaiClient = null;
function getOpenAIClient() {
  if (_openaiClient) return _openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'sk-your-openai-key-here') {
    return null;
  }
  _openaiClient = new OpenAI({ apiKey });
  return _openaiClient;
}

// Validar URL de PDF (solo HTTPS, dominios permitidos, sin IPs privadas)
function validatePdfUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return 'Solo se permiten URLs HTTPS';
    // Bloquear IPs privadas y localhost
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return 'URL no permitida';
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) return 'URL no permitida';
    // Dominios permitidos para SECOP
    const allowedDomains = ['secop.gov.co', 'community.secop.gov.co', 'datos.gov.co', 'colombiacompra.gov.co'];
    const isAllowed = allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    if (!isAllowed) return `Dominio no permitido: ${hostname}. Solo se aceptan documentos de SECOP`;
    return null;
  } catch { return 'URL inválida'; }
}

// Rate limiter para IA (más restrictivo)
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, keyGenerator: (req) => req.user?.id?.toString() || req.ip, message: { error: 'Demasiadas solicitudes de IA. Espera un momento.' } });

// POST /api/ai/analizar-pliego - Analiza un pliego desde URL de PDF o texto
app.post('/api/ai/analizar-pliego', authMiddleware, subscriptionMiddleware, dailyLimitMiddleware, aiLimiter, async (req, res) => {
  const openai = getOpenAIClient();
  if (!openai) {
    return res.status(503).json({ error: 'API Key de OpenAI no configurada. Agrega OPENAI_API_KEY al archivo .env' });
  }

  const { pdfUrl, textoPliego, processNumber, processData } = req.body;

  if (!pdfUrl && !textoPliego) {
    return res.status(400).json({ error: 'Se requiere pdfUrl o textoPliego' });
  }

  try {
    let textoExtraido = textoPliego || '';

    // Si se proporciona URL de PDF, descargarlo y extraer texto
    if (pdfUrl && !textoPliego) {
      const urlError = validatePdfUrl(pdfUrl);
      if (urlError) return res.status(400).json({ error: urlError });

      console.log(`📄 Descargando PDF: ${pdfUrl}`);
      const pdfResponse = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 20 * 1024 * 1024, // 20MB máximo
        maxBodyLength: 20 * 1024 * 1024,
        headers: { 'User-Agent': 'JIEREDAI/1.0' }
      });
      const pdfData = await pdfParse(pdfResponse.data);
      textoExtraido = pdfData.text;
      console.log(`📄 PDF extraído: ${textoExtraido.length} caracteres`);
    }

    if (!textoExtraido || textoExtraido.trim().length < 100) {
      return res.status(400).json({ error: 'No se pudo extraer texto suficiente del documento' });
    }

    // Truncar a ~100k caracteres para no exceder límites de tokens
    const textoTruncado = textoExtraido.slice(0, 100000);

    console.log(`🤖 Analizando pliego con IA (${textoTruncado.length} chars)...`);

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: PROMPT_ANALISIS_PLIEGO },
        { role: 'user', content: `Analiza este pliego de condiciones:\n\n${textoTruncado}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 4000
    });

    const analisis = JSON.parse(completion.choices[0].message.content);

    // Guardar análisis en la BD si hay processNumber
    if (processNumber) {
      db.prepare(`UPDATE applied_processes
                  SET analysis_json = ?, analyzed_at = CURRENT_TIMESTAMP
                  WHERE user_id = ? AND process_number = ?`)
        .run(JSON.stringify(analisis), req.user.id, processNumber);

      addNotification(req.user.id, 'ia', 'Análisis completado', `El pliego del proceso ${processNumber} ha sido analizado con IA`);
    }

    const tokensUsed = completion.usage?.total_tokens || 0;
    incrementDailyUsage(req.user.id, tokensUsed);

    res.json({
      success: true,
      analisis,
      tokens_usados: tokensUsed
    });

  } catch (error) {
    console.error('❌ Error en análisis de pliego:', error.message);
    if (error.code === 'insufficient_quota') {
      return res.status(402).json({ error: 'Créditos de OpenAI agotados. Recarga tu cuenta.' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'API Key de OpenAI inválida.' });
    }
    res.status(500).json({ error: 'Error al analizar el pliego', detail: error.message });
  }
});

// POST /api/ai/evaluar-cumplimiento - Evalúa si la empresa cumple
app.post('/api/ai/evaluar-cumplimiento', authMiddleware, subscriptionMiddleware, dailyLimitMiddleware, aiLimiter, async (req, res) => {
  const openai = getOpenAIClient();
  if (!openai) {
    return res.status(503).json({ error: 'API Key de OpenAI no configurada.' });
  }

  const { analisisPliego, processNumber } = req.body;
  if (!analisisPliego) {
    return res.status(400).json({ error: 'Se requiere el análisis del pliego (analisisPliego)' });
  }

  // Obtener datos de la empresa del usuario
  const config = getUserConfig(req.user.id);
  const empresa = config.empresa || config;

  if (!empresa || (!empresa.razonSocial && !empresa.nombre && !empresa.nit)) {
    return res.status(400).json({ error: 'Configura los datos de tu empresa primero (Configuración → Empresa)' });
  }

  // Obtener documentos del usuario
  const documentos = db.prepare('SELECT doc_type, expiry_date FROM user_documents WHERE user_id = ?').all(req.user.id);

  try {
    const contexto = `
ANÁLISIS DEL PLIEGO:
${JSON.stringify(analisisPliego, null, 2)}

DATOS DE LA EMPRESA PROPONENTE:
${JSON.stringify(empresa, null, 2)}

DOCUMENTOS VIGENTES DE LA EMPRESA:
${JSON.stringify(documentos, null, 2)}
`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: PROMPT_CUMPLIMIENTO },
        { role: 'user', content: contexto }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 2000
    });

    const evaluacion = JSON.parse(completion.choices[0].message.content);

    // Guardar evaluación
    if (processNumber) {
      const existing = db.prepare('SELECT analysis_json FROM applied_processes WHERE user_id = ? AND process_number = ?').get(req.user.id, processNumber);
      let analysis = existing?.analysis_json ? JSON.parse(existing.analysis_json) : {};
      analysis.evaluacionCumplimiento = evaluacion;
      db.prepare(`UPDATE applied_processes SET analysis_json = ?, cumple = ?, analyzed_at = CURRENT_TIMESTAMP WHERE user_id = ? AND process_number = ?`)
        .run(JSON.stringify(analysis), evaluacion.cumpleGeneral || null, req.user.id, processNumber);
    }

    incrementDailyUsage(req.user.id, completion.usage?.total_tokens || 0);
    res.json({ success: true, evaluacion });

  } catch (error) {
    console.error('❌ Error en evaluación:', error.message);
    res.status(500).json({ error: 'Error al evaluar cumplimiento', detail: error.message });
  }
});

// POST /api/ai/chat - Chat IA con contexto del proceso/pliego
app.post('/api/ai/chat', authMiddleware, subscriptionMiddleware, dailyLimitMiddleware, aiLimiter, async (req, res) => {
  const openai = getOpenAIClient();
  if (!openai) {
    return res.status(503).json({ error: 'API Key de OpenAI no configurada.' });
  }

  const { mensaje, processNumber, contextoAdicional } = req.body;
  if (!mensaje) {
    return res.status(400).json({ error: 'Mensaje requerido' });
  }

  try {
    // Construir contexto
    let contexto = '';
    if (processNumber) {
      const proc = db.prepare('SELECT process_data_json, analysis_json FROM applied_processes WHERE user_id = ? AND process_number = ?')
        .get(req.user.id, processNumber);
      if (proc) {
        contexto += `\nDATOS DEL PROCESO:\n${proc.process_data_json}`;
        if (proc.analysis_json) contexto += `\nANÁLISIS DEL PLIEGO:\n${proc.analysis_json}`;
      }
    }
    if (contextoAdicional) contexto += `\nCONTEXTO ADICIONAL:\n${contextoAdicional}`;

    const config = getUserConfig(req.user.id);
    const empresa = config.empresa || config;
    if (empresa && (empresa.razonSocial || empresa.nombre || empresa.nit)) {
      contexto += `\nDATOS DE MI EMPRESA:\n${JSON.stringify(empresa)}`;
    }

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: `Eres un asistente experto en contratación pública colombiana (SECOP II). Ayudas a empresas a preparar propuestas ganadoras. Responde de forma concisa, práctica y accionable. Si tienes contexto del proceso o pliego, úsalo para dar respuestas específicas.\n\nCONTEXTO DISPONIBLE:${contexto}` },
        { role: 'user', content: mensaje }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    const tokensChat = completion.usage?.total_tokens || 0;
    incrementDailyUsage(req.user.id, tokensChat);

    res.json({
      success: true,
      respuesta: completion.choices[0].message.content,
      tokens_usados: tokensChat
    });

  } catch (error) {
    console.error('❌ Error en chat IA:', error.message);
    res.status(500).json({ error: 'Error en el chat IA', detail: error.message });
  }
});

// ═══════════════════════════════════════
// SUBSCRIPTION STATUS
// ═══════════════════════════════════════

// GET /api/subscriptions/status — estado completo del usuario (trial, plan, límites de hoy)
app.get('/api/subscriptions/status', authMiddleware, (req, res) => {
  const status = getUserSubscriptionStatus(req.user.id);
  const usage  = getDailyUsage(req.user.id);
  const user   = db.prepare('SELECT role, plan FROM users WHERE id = ?').get(req.user.id);
  const limit  = (user?.role === 'admin') ? Infinity : (DAILY_LIMITS[user?.plan] ?? DAILY_LIMITS.basico);

  res.json({
    ...status,
    dailyUsage: {
      analysesUsed:  usage.analyses_used,
      tokensUsed:    usage.tokens_used,
      dailyLimit:    isFinite(limit) ? limit : null,
      remaining:     isFinite(limit) ? Math.max(0, limit - usage.analyses_used) : null,
    },
  });
});

// ═══════════════════════════════════════
// WOMPI ROUTES — Pasarela de pagos COP
// ═══════════════════════════════════════

// POST /api/wompi/create-link — genera URL de pago en Wompi Checkout
app.post('/api/wompi/create-link', authMiddleware, async (req, res) => {
  const { plan } = req.body; // 'profesional' | 'empresarial'
  if (!plan || !WOMPI_PRICES[plan]) {
    return res.status(400).json({ error: 'Plan requerido: profesional | empresarial' });
  }

  const publicKey     = process.env.WOMPI_PUBLIC_KEY;
  const integrityKey  = process.env.WOMPI_INTEGRITY_KEY || process.env.WOMPI_PRIVATE_KEY;
  if (!publicKey) {
    return res.status(503).json({ error: 'WOMPI_PUBLIC_KEY no configurado en .env' });
  }

  const amountCents = WOMPI_PRICES[plan];
  const reference   = `JIREHAI-${req.user.id}-${plan.toUpperCase()}-${Date.now()}`;
  const currency    = 'COP';
  const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3001';
  const redirectUrl  = `${frontendBase}/JIREHAI.html?payment=success&plan=${plan}&uid=${req.user.id}`;

  // Calcular firma de integridad (solo si se configuró la llave)
  let sigParam = '';
  if (integrityKey) {
    const sig = wompiIntegritySignature(reference, amountCents, currency, integrityKey);
    sigParam = `&signature:integrity=${encodeURIComponent(sig)}`;
  }

  const checkoutUrl = `https://checkout.wompi.co/p/?public-key=${encodeURIComponent(publicKey)}`
    + `&currency=${currency}`
    + `&amount-in-cents=${amountCents}`
    + `&reference=${encodeURIComponent(reference)}`
    + `&redirect-url=${encodeURIComponent(redirectUrl)}`
    + sigParam;

  res.json({ url: checkoutUrl, reference, amountCents });
});

// POST /api/wompi/webhook — recibe eventos de transacción de Wompi
app.post('/api/wompi/webhook', async (req, res) => {
  const eventsSecret = process.env.WOMPI_EVENTS_SECRET;
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body);

  let event;
  if (eventsSecret) {
    event = verifyWompiWebhook(rawBody, eventsSecret);
    if (!event) {
      console.error('❌ Wompi webhook: firma inválida');
      return res.status(400).json({ error: 'Firma de webhook inválida' });
    }
  } else {
    try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Body inválido' }); }
  }

  // Solo procesar transacciones APROBADAS
  if (event?.event === 'transaction.updated' && event?.data?.transaction?.status === 'APPROVED') {
    const tx        = event.data.transaction;
    const reference = tx.reference || '';         // formato: JIREHAI-{userId}-{PLAN}-{ts}
    const parts     = reference.split('-');
    const userId    = parseInt(parts[1]);
    const planRaw   = (parts[2] || '').toLowerCase();
    const plan      = ['profesional', 'empresarial'].includes(planRaw) ? planRaw : 'profesional';
    const priceCOP  = Math.round((tx.amount_in_cents || 0) / 100);

    if (!userId || isNaN(userId)) {
      console.error('❌ Wompi webhook: userId inválido en referencia:', reference);
      return res.json({ received: true });
    }

    // Activar 30 días de suscripción
    db.prepare(`UPDATE users SET plan = ?, plan_expires_at = datetime('now', '+30 days'),
                trial_expires_at = NULL WHERE id = ?`).run(plan, userId);

    // Registrar en tabla subscriptions
    db.prepare(`INSERT INTO subscriptions (user_id, plan, price, end_date, status, payment_method)
      VALUES (?, ?, ?, date('now', '+30 days'), 'active', 'wompi')`).run(userId, plan, priceCOP);

    addNotification(userId, 'pago', '¡Pago recibido! 🎉',
      `Tu plan ${plan} ha sido activado por 30 días a través de Wompi. ¡Gracias por tu confianza!`);

    const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId);
    if (user) {
      sendEmail(user.email, '¡Suscripción activada en JIREHAI!', `
        <h2>¡Pago confirmado, ${user.name}! 🎉</h2>
        <p>Tu plan <strong>${plan}</strong> ha sido activado por <strong>30 días</strong>.</p>
        <p>Valor pagado: <strong>$${priceCOP.toLocaleString('es-CO')} COP</strong></p>
        <p>Ahora tienes acceso completo a todas las funciones de JIREHAI.</p>
        <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3001'}/JIREHAI.html">Ir a la aplicación →</a></p>
      `).catch(console.error);
    }
    console.log(`✅ Wompi pago aprobado: user ${userId} → plan ${plan} (Referencia: ${reference})`);
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════
// ADMIN ROUTES (protected)
// ═══════════════════════════════════════
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role != "admin"').get().cnt;
  const activeUsers = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE active = 1 AND role != "admin"').get().cnt;
  const totalProcesses = db.prepare('SELECT COUNT(*) as cnt FROM applied_processes').get().cnt;
  const analyzedProcesses = db.prepare('SELECT COUNT(*) as cnt FROM applied_processes WHERE analysis_json IS NOT NULL').get().cnt;
  const recentScans = db.prepare('SELECT SUM(processes_found) as total FROM scan_log WHERE created_at >= date("now", "-1 day")').get().total || 0;
  const planDistribution = db.prepare('SELECT plan, COUNT(*) as cnt FROM users WHERE role != "admin" GROUP BY plan').all();
  res.json({ totalUsers, activeUsers, totalProcesses, analyzedProcesses, recentScans, planDistribution });
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, name, email, plan, role, active, created_at, last_login FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.post('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const { name, email, password, plan, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Campos requeridos' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = db.prepare('INSERT INTO users (name, email, password_hash, plan, role) VALUES (?, ?, ?, ?, ?)').run(name, email, hash, plan || 'basico', role || 'user');
    db.prepare('INSERT OR IGNORE INTO notification_settings (user_id, notification_email) VALUES (?, ?)').run(result.lastInsertRowid, email);
    res.status(201).json({ success: true, id: result.lastInsertRowid });
  } catch { res.status(409).json({ error: 'Email ya registrado' }); }
});

app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { name, email, plan, role, active } = req.body;
  db.prepare('UPDATE users SET name=?, email=?, plan=?, role=?, active=? WHERE id=?').run(name, email, plan, role, active?1:0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/unspsc', authMiddleware, adminMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM unspsc_codes ORDER BY category, code').all());
});

app.post('/api/admin/unspsc', authMiddleware, adminMiddleware, (req, res) => {
  const { code, description, category, keywords, active } = req.body;
  try {
    const result = db.prepare('INSERT INTO unspsc_codes (code, description, category, keywords, active) VALUES (?, ?, ?, ?, ?)').run(code, description, category || '', keywords || '', active !== false ? 1 : 0);
    res.status(201).json({ success: true, id: result.lastInsertRowid });
  } catch { res.status(409).json({ error: 'Código UNSPSC ya existe' }); }
});

app.put('/api/admin/unspsc/:id', authMiddleware, adminMiddleware, (req, res) => {
  const { code, description, category, keywords, active } = req.body;
  db.prepare('UPDATE unspsc_codes SET code=?, description=?, category=?, keywords=?, active=? WHERE id=?').run(code, description, category || '', keywords || '', active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/unspsc/:id', authMiddleware, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM unspsc_codes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/subscriptions', authMiddleware, adminMiddleware, (req, res) => {
  const subs = db.prepare(`SELECT s.*, u.name, u.email FROM subscriptions s
                            JOIN users u ON s.user_id = u.id ORDER BY s.created_at DESC`).all();
  res.json(subs);
});

// ── Dashboard completo para el super-admin ─────────────────────────────────
app.get('/api/admin/dashboard', authMiddleware, adminMiddleware, (req, res) => {
  try {
    // KPI básicos
    const totalUsers   = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role != 'admin'`).get().cnt;
    const activeUsers  = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE active = 1 AND role != 'admin'`).get().cnt;
    const newThisMonth = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role != 'admin' AND created_at >= date('now','start of month')`).get().cnt;
    const newToday     = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role != 'admin' AND created_at >= date('now')`).get().cnt;

    // Ingresos (COP)
    const totalRevenue = db.prepare(`SELECT COALESCE(SUM(price),0) as total FROM subscriptions WHERE status='active' AND payment_method IN ('wompi','stripe','card')`).get().total;
    const monthRevenue = db.prepare(`SELECT COALESCE(SUM(price),0) as total FROM subscriptions WHERE status='active' AND payment_method IN ('wompi','stripe','card') AND created_at >= date('now','start of month')`).get().total;
    const totalPagos   = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions WHERE payment_method IN ('wompi','stripe','card')`).get().cnt;

    // Distribución de planes
    const planDist = db.prepare(`SELECT plan, COUNT(*) as cnt FROM users WHERE role != 'admin' GROUP BY plan ORDER BY cnt DESC`).all();

    // Suscripciones activas (con vencimiento futuro)
    const activeSubs = db.prepare(`SELECT COUNT(*) as cnt FROM users WHERE role != 'admin' AND plan != 'basico' AND (plan_expires_at > datetime('now') OR trial_expires_at > datetime('now'))`).get().cnt;

    // Ingresos por mes (últimos 6 meses)
    const revenueByMonth = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, COALESCE(SUM(price),0) as revenue, COUNT(*) as pagos
      FROM subscriptions
      WHERE payment_method IN ('wompi','stripe','card') AND created_at >= date('now','-6 months')
      GROUP BY month ORDER BY month ASC`).all();

    // Últimos 20 usuarios registrados
    const recentUsers = db.prepare(`
      SELECT id, name, email, plan, role, active, created_at, last_login, trial_expires_at, plan_expires_at
      FROM users ORDER BY created_at DESC LIMIT 20`).all();

    // Últimas 30 transacciones
    const recentPayments = db.prepare(`
      SELECT s.id, s.user_id, s.plan, s.price, s.start_date, s.end_date, s.status, s.payment_method, s.created_at,
             u.name, u.email
      FROM subscriptions s JOIN users u ON s.user_id = u.id
      ORDER BY s.created_at DESC LIMIT 30`).all();

    // Usuarios con gifts / días gratis asignados
    const giftCount = db.prepare(`SELECT COUNT(*) as cnt FROM subscriptions WHERE payment_method = 'gift'`).get().cnt;

    res.json({
      kpis: { totalUsers, activeUsers, newThisMonth, newToday, totalRevenue, monthRevenue, totalPagos, activeSubs, giftCount },
      planDist,
      revenueByMonth,
      recentUsers,
      recentPayments,
    });
  } catch (e) {
    console.error('Error dashboard admin:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Asignar días gratuitos a un usuario ───────────────────────────────────
app.post('/api/admin/users/:id/grant-days', authMiddleware, adminMiddleware, (req, res) => {
  const userId = parseInt(req.params.id);
  const { days = 30, plan: grantPlan, reason = 'Asignado por administrador' } = req.body;
  const daysNum = Math.min(Math.max(parseInt(days) || 30, 1), 365);

  const user = db.prepare('SELECT id, name, email, plan, plan_expires_at, trial_expires_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  // El nuevo plan: el que el admin envió, o el actual (si ya es profesional/empresarial), o subir a profesional
  const newPlan = grantPlan || (user.plan !== 'basico' ? user.plan : 'profesional');

  // Extender desde hoy o desde el vencimiento actual (el que sea mayor)
  const currentExpiry = user.plan_expires_at || user.trial_expires_at;
  const baseIsLater   = currentExpiry && new Date(currentExpiry) > new Date();
  const baseStr       = baseIsLater ? currentExpiry : 'now';

  db.prepare(`UPDATE users SET
      plan = ?,
      plan_expires_at = datetime(?, '+${daysNum} days'),
      trial_expires_at = NULL
    WHERE id = ?`).run(newPlan, baseStr, userId);

  db.prepare(`INSERT INTO subscriptions (user_id, plan, price, end_date, status, payment_method)
    VALUES (?, ?, 0, date(?, '+${daysNum} days'), 'active', 'gift')`).run(userId, newPlan, baseStr);

  addNotification(userId, 'pago', `✅ ${daysNum} días de acceso asignados`,
    `El administrador te ha otorgado ${daysNum} días de acceso en plan ${newPlan}. ${reason}`);

  sendEmail(user.email, `¡Acceso extendido en JIREHAI!`, `
    <h2>¡Buenas noticias, ${user.name}! 🎉</h2>
    <p>El equipo de JIREHAI te ha otorgado <strong>${daysNum} días</strong> de acceso en plan <strong>${newPlan}</strong>.</p>
    <p><em>${reason}</em></p>
    <p><a href="${process.env.FRONTEND_URL || 'http://localhost:3001'}/JIREHAI.html">Ir a la aplicación →</a></p>
  `).catch(console.error);

  console.log(`✅ Grant-days: admin asignó ${daysNum} días (plan ${newPlan}) al usuario #${userId} (${user.email})`);
  res.json({ success: true, message: `${daysNum} días en plan ${newPlan} asignados a ${user.name}` });
});

// ── Ver todos los usuarios con su estado de suscripción ───────────────────
app.get('/api/admin/users/status', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT id, name, email, plan, role, active, created_at, last_login,
           trial_expires_at, plan_expires_at
    FROM users ORDER BY created_at DESC`).all();
  const now = new Date();
  const result = users.map(u => {
    const trialExp = u.trial_expires_at ? new Date(u.trial_expires_at) : null;
    const planExp  = u.plan_expires_at  ? new Date(u.plan_expires_at)  : null;
    let subStatus  = 'sin_plan';
    let expiresAt  = null;
    if (u.role === 'admin')       { subStatus = 'admin'; }
    else if (planExp && planExp > now) { subStatus = 'activo'; expiresAt = planExp; }
    else if (trialExp && trialExp > now) { subStatus = 'trial'; expiresAt = trialExp; }
    else if (u.plan !== 'basico') { subStatus = 'vencido'; }
    return { ...u, subStatus, expiresAt };
  });
  res.json(result);
});

// ═══════════════════════════════════════
// SCHEDULED TASKS (CRON)
// ═══════════════════════════════════════
cron.schedule('0 7 * * *', async () => {
  console.log('🕐 Ejecutando escaneo diario...');
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.plan, u.plan_expires_at, u.trial_expires_at,
                             ns.notification_email, ns.email_enabled, ns.notify_docs_expiring, ns.notify_new_processes
                             FROM users u LEFT JOIN notification_settings ns ON u.id = ns.user_id
                             WHERE u.active = 1 AND u.role != 'admin'`).all();

  for (const user of users) {
    const notifEmail = user.notification_email || user.email;
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3001';

    // ── 1. Avisos de vencimiento de suscripción/trial ──────────────────────
    const now = new Date();
    const expiryDate = user.plan_expires_at
      ? new Date(user.plan_expires_at)
      : user.trial_expires_at
        ? new Date(user.trial_expires_at)
        : null;
    const isTrial = !user.plan_expires_at && !!user.trial_expires_at;

    if (expiryDate) {
      const daysLeft = Math.ceil((expiryDate - now) / 86400000);
      const planLabel = isTrial ? 'prueba gratuita' : `plan ${user.plan}`;

      if (daysLeft === 3 || daysLeft === 1 || daysLeft === 0) {
        const dayMsg = daysLeft === 0
          ? `¡Tu ${planLabel} vence HOY!`
          : `Tu ${planLabel} vence en ${daysLeft} día${daysLeft > 1 ? 's' : ''}`;

        addNotification(user.id, 'suscripcion', `⚠️ ${dayMsg}`, `${dayMsg}. Renueva tu plan para continuar usando JIREHAI sin interrupciones.`);

        if (user.email_enabled !== 0) {
          await sendEmail(notifEmail, `JIREHAI — ${dayMsg}`, `
            <h2>⚠️ ${dayMsg}</h2>
            <p>Hola <strong>${user.name}</strong>,</p>
            <p>${dayMsg}. No pierdas el acceso a tus licitaciones en SECOP II.</p>
            ${daysLeft === 0
              ? '<p>Tu acceso ha sido suspendido. Renueva ahora para recuperarlo inmediatamente.</p>'
              : '<p>Renueva antes de que venza para no perder el acceso.</p>'
            }
            <p>
              <a href="${frontendBase}/JIREHAI.html?tab=suscripcion"
                 style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
                Renovar mi plan →
              </a>
            </p>
          `);
        }
      }
    }

    // ── 2. Avisos de documentos por vencer ────────────────────────────────
    if (user.notify_docs_expiring) {
      const docs = db.prepare(`SELECT * FROM user_documents WHERE user_id = ? AND expiry_date IS NOT NULL
                                AND expiry_date <= date('now', '+30 days') AND expiry_date >= date('now')`).all(user.id);
      if (docs.length > 0) {
        addNotification(user.id, 'documento', 'Documentos por vencer', `Tienes ${docs.length} documento(s) que vencen en los próximos 30 días`);
        if (user.email_enabled !== 0 && notifEmail) {
          const list = docs.map(d => `<li><strong>${d.doc_type}</strong>: vence ${d.expiry_date}</li>`).join('');
          await sendEmail(notifEmail, 'JIREHAI — Documentos próximos a vencer', `
            <h3>📄 Documentos por vencer</h3>
            <ul>${list}</ul>
            <p>Mantén tus documentos al día para no perder oportunidades en SECOP II.</p>
          `);
        }
      }
    }
  }
  console.log('✅ Escaneo diario completado');
});

// ═══════════════════════════════════════
// AI SECOP ANALYSIS ROUTES
// ═══════════════════════════════════════
const { createAIRouter } = require('./routes/ai.routes');
// Los routes necesitan 'db' ya inicializado — se montan dentro de initDB().then()
// Ver más abajo en la sección START.

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

// Serve frontend for all non-API routes
app.get('*', (req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  } else {
    next();
  }
});

// ── START ──
dbModule.initDB().then((database) => {
  db = database;

  // Montar AI routes ahora que 'db' está listo
  const aiRouter = createAIRouter(db, authMiddleware);
  app.use('/api/ai', aiRouter);
  console.log('🤖 AI SECOP routes montadas en /api/ai');

  app.listen(PORT, () => {
    console.log(`\n🚀 JIREHAI Backend corriendo en http://localhost:${PORT}`);
    console.log(`📋 API disponible en http://localhost:${PORT}/api`);
    console.log(`🌐 Frontend en http://localhost:${PORT}/JIREHAI.html`);
    console.log(`⚙️  Admin en http://localhost:${PORT}/admin.html\n`);
    // Descubrir columnas SECOP II en segundo plano (no bloquea el inicio)
    discoverSecopSchema().catch(() => {});
  });
}).catch(err => {
  console.error('❌ Error inicializando la base de datos:', err);
  process.exit(1);
});

module.exports = app;
