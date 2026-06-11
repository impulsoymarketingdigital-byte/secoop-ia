'use strict';
/**
 * JIREHAI — AI Routes
 * routes/ai.routes.js
 *
 * Endpoints:
 *   POST   /api/ai/analyze-process      → inicia análisis, devuelve jobId
 *   POST   /api/ai/upload-docs/:jobId   → sube documentos manualmente para un job
 *   GET    /api/ai/status/:jobId        → estado y progreso del job
 *   GET    /api/ai/result/:jobId        → resultado JSON completo
 *   GET    /api/ai/export/:jobId        → descarga archivo exportado
 *   GET    /api/ai/jobs                 → listado de análisis del usuario
 *   DELETE /api/ai/job/:jobId           → eliminar job y sus archivos
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');

/**
 * Fábrica del router. Recibe db y authMiddleware del server principal.
 */
function createAIRouter(db, authMiddleware, subscriptionMiddleware) {
  const router = express.Router();
  router.use(authMiddleware);
  if (subscriptionMiddleware) {
    router.use(subscriptionMiddleware);
  }
  const { createAIService } = require('../services/ai.service');
  const aiSvc = createAIService(db);

  // ── Rate-limit suave para el endpoint costoso ──────────────────────────
  const rateLimit = require('express-rate-limit');
  const rl = typeof rateLimit === 'function' ? rateLimit : rateLimit.rateLimit;
  const aiLimiter = rl({
    windowMs: 60 * 1000,       // 1 minuto
    max: 5,                     // máx 5 análisis por minuto por IP
    message: { error: 'Demasiadas solicitudes de análisis. Espera un momento.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Verifica que el jobId pertenece al usuario (o es admin). */
  function ownsJob(jobId, userId, role) {
    const row = db.prepare('SELECT user_id FROM process_analysis WHERE job_id = ?').get(jobId);
    if (!row) return false;
    return row.user_id === userId || role === 'admin';
  }

  // ══════════════════════════════════════════════════════════════════════
  // POST /api/ai/analyze-process
  // Body: { process_data, options? }
  // ══════════════════════════════════════════════════════════════════════
  router.post('/analyze-process', authMiddleware, aiLimiter, (req, res) => {
    const { process_data, options } = req.body;

    if (!process_data || typeof process_data !== 'object') {
      return res.status(400).json({ error: 'Se requiere process_data con los datos del proceso SECOP' });
    }

    // Validación básica: debe haber al menos una referencia o número de proceso
    const hasRef = process_data._referencia
      || process_data.referencia_del_proceso
      || process_data.numero_del_proceso
      || process_data.id_del_proceso;

    if (!hasRef) {
      return res.status(400).json({ error: 'process_data debe incluir al menos el número o referencia del proceso' });
    }

    // Verificar que el usuario tiene acceso al análisis AI (plan >= basico)
    // Puedes ajustar esta lógica según tus planes de pago
    const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    try {
      // Leer credenciales SECOP del perfil del usuario (guardadas en su config)
      const userCfgRow = db.prepare('SELECT config_json FROM user_configs WHERE user_id = ?').get(req.user.id);
      const userCfg = userCfgRow ? JSON.parse(userCfgRow.config_json || '{}') : {};
      const secopUser = userCfg?.secop?.user || process.env.SECOP_USER || '';
      const secopPass = userCfg?.secop?.pass || process.env.SECOP_PASS || '';

      const jobId = aiSvc.startAnalysis({
        userId:      req.user.id,
        processData: process_data,
        options:     options || {},
        secopUser,
        secopPass,
      });

      res.status(202).json({
        success: true,
        job_id: jobId,
        message: 'Análisis iniciado. Usa GET /api/ai/status/:jobId para monitorear el progreso.',
        status_url: `/api/ai/status/${jobId}`,
        result_url:  `/api/ai/result/${jobId}`,
      });
    } catch (err) {
      console.error('Error iniciando análisis AI:', err);
      res.status(500).json({ error: 'Error iniciando el análisis: ' + err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // POST /api/ai/download-process
  // Solo descarga los documentos sin hacer el análisis completo (diagnóstico)
  // ══════════════════════════════════════════════════════════════════════
  router.post('/download-process', authMiddleware, aiLimiter, (req, res) => {
    const { process_data, options } = req.body;

    if (!process_data || typeof process_data !== 'object') {
      return res.status(400).json({ error: 'Se requiere process_data' });
    }

    // Lanzar con skip de análisis
    try {
      const jobId = aiSvc.startAnalysis({
        userId:      req.user.id,
        processData: process_data,
        options:     {
          ...(options || {}),
          skip_ocr:      true,
          skip_products: true,
          skip_risks:    true,
        },
      });

      res.status(202).json({
        success: true,
        job_id: jobId,
        message: 'Descarga iniciada. Solo se descargarán y parsearán los documentos.',
        status_url: `/api/ai/status/${jobId}`,
      });
    } catch (err) {
      console.error('Error iniciando descarga:', err);
      res.status(500).json({ error: 'Error iniciando la descarga: ' + err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════
  // POST /api/ai/upload-docs/:jobId
  // Permite subir documentos manualmente para un job existente o nuevo
  // Acepta multipart/form-data con campo "docs" (múltiples archivos)
  // ══════════════════════════════════════════════════════════════════════
  const ALLOWED_MIMES = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png', 'image/jpeg', 'image/tiff', 'image/bmp',
    'application/zip', 'application/octet-stream',
  ]);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // El directorio se define en el momento de la petición
      const jobId = req.params.jobId;
      const docsDir = path.join(
        path.join(__dirname, '..', 'ai', 'outputs'),
        jobId, 'docs'
      );
      fs.mkdirSync(docsDir, { recursive: true });
      cb(null, docsDir);
    },
    filename: (req, file, cb) => {
      // Conservar nombre original limpiando caracteres peligrosos
      const safe = file.originalname.replace(/[/\\:*?"<>|]/g, '_').substring(0, 100);
      cb(null, safe);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },  // 50MB por archivo, 20 archivos
    fileFilter: (req, file, cb) => {
      const mime = file.mimetype || '';
      const ext  = path.extname(file.originalname).toLowerCase();
      const allowedExts = new Set(['.pdf','.xlsx','.xls','.docx','.doc','.pptx','.png','.jpg','.jpeg','.tif','.tiff','.zip']);
      if (ALLOWED_MIMES.has(mime) || allowedExts.has(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`Tipo no permitido: ${mime} / ${ext}`));
      }
    },
  });

  router.post('/upload-docs/:jobId', authMiddleware, upload.array('docs', 20), (req, res) => {
    const { jobId } = req.params;

    if (!ownsJob(jobId, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No se recibieron archivos' });
    }

    const uploaded = files.map(f => ({
      filename: f.filename,
      originalname: f.originalname,
      size_kb: Math.round(f.size / 1024),
      path: f.path,
      mimetype: f.mimetype,
    }));

    console.log(`[upload-docs] Job ${jobId}: ${files.length} archivo(s) subido(s)`);
    res.json({
      success: true,
      job_id: jobId,
      files_uploaded: uploaded.length,
      files: uploaded,
      message: `${uploaded.length} archivo(s) subido(s). El análisis usará estos documentos.`,
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // GET /api/ai/status/:jobId
  // ══════════════════════════════════════════════════════════════════════
  router.get('/status/:jobId', authMiddleware, (req, res) => {
    const { jobId } = req.params;
    const status = aiSvc.getStatus(jobId);

    if (!status) {
      return res.status(404).json({ error: 'Job no encontrado' });
    }
    if (!ownsJob(jobId, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    res.json({
      job_id:        status.job_id,
      status:        status.status,
      progress_pct:  status.progress_pct,
      progress_step: status.progress_step,
      progress_msg:  status.progress_msg,
      error_msg:     status.error_msg || null,
      process_ref:   status.process_ref,
      entity_name:   status.entity_name,
      created_at:    status.created_at,
      updated_at:    status.updated_at,
      result_ready:  status.status === 'completed',
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // GET /api/ai/result/:jobId
  // ══════════════════════════════════════════════════════════════════════
  router.get('/result/:jobId', authMiddleware, (req, res) => {
    const { jobId } = req.params;

    if (!ownsJob(jobId, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const status = aiSvc.getStatus(jobId);
    if (!status) return res.status(404).json({ error: 'Job no encontrado' });

    if (status.status === 'running') {
      return res.status(202).json({
        message: 'El análisis aún está en progreso',
        progress_pct:  status.progress_pct,
        progress_step: status.progress_step,
      });
    }
    if (status.status === 'error') {
      return res.status(422).json({
        error: 'El análisis terminó con error',
        detail: status.error_msg,
      });
    }

    const result = aiSvc.getResult(jobId);
    if (!result) {
      return res.status(404).json({ error: 'Resultado no disponible aún' });
    }

    res.json({ success: true, job_id: jobId, data: result });
  });

  // ══════════════════════════════════════════════════════════════════════
  // GET /api/ai/export/:jobId?format=xlsx|json|md|legal|risks|products
  // ══════════════════════════════════════════════════════════════════════
  router.get('/export/:jobId', authMiddleware, (req, res) => {
    const { jobId } = req.params;
    const format = (req.query.format || 'json').toLowerCase();

    if (!ownsJob(jobId, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const VALID_FORMATS = ['json', 'md', 'xlsx', 'legal', 'risks', 'products', 'informe_xlsx', 'informe_pdf'];
    if (!VALID_FORMATS.includes(format)) {
      return res.status(400).json({
        error: `Formato inválido. Válidos: ${VALID_FORMATS.join(', ')}`,
      });
    }

    const filePath = aiSvc.getExportPath(jobId, format);
    if (!filePath) {
      return res.status(404).json({ error: 'Archivo de exportación no encontrado' });
    }

    const MIME = {
      json:        'application/json',
      md:          'text/markdown',
      xlsx:        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      informe_xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      informe_pdf: 'application/pdf',
      legal:       'text/markdown',
      risks:       'text/markdown',
      products:    'application/json',
    };

    const filename = require('path').basename(filePath);
    res.setHeader('Content-Type', MIME[format] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  });

  // ══════════════════════════════════════════════════════════════════════
  // GET /api/ai/jobs  — historial del usuario
  // ══════════════════════════════════════════════════════════════════════
  router.get('/jobs', authMiddleware, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const jobs = aiSvc.listUserJobs(req.user.id, limit);
    res.json({ success: true, jobs });
  });

  // ══════════════════════════════════════════════════════════════════════
  // DELETE /api/ai/job/:jobId
  // ══════════════════════════════════════════════════════════════════════
  router.delete('/job/:jobId', authMiddleware, (req, res) => {
    const { jobId } = req.params;

    if (!ownsJob(jobId, req.user.id, req.user.role)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    aiSvc.deleteJob(jobId, req.user.id);
    res.json({ success: true, message: 'Job eliminado' });
  });

  // ══════════════════════════════════════════════════════════════════════
  // GET /api/ai/health  — comprobación rápida del motor Python
  // ══════════════════════════════════════════════════════════════════════
  router.get('/health', authMiddleware, async (req, res) => {
    const { execSync } = require('child_process');
    const checks = {};

    // Python disponible?
    try {
      const ver = execSync('python3 --version 2>&1').toString().trim();
      checks.python = { ok: true, version: ver };
    } catch {
      try {
        const ver = execSync('python --version 2>&1').toString().trim();
        checks.python = { ok: true, version: ver };
      } catch {
        checks.python = { ok: false, error: 'Python no encontrado' };
      }
    }

    // Script principal existe?
    const path = require('path');
    const fs   = require('fs');
    const scriptPath = path.join(__dirname, '..', 'ai', 'secop-ai-analyst', 'main.py');
    checks.script = { ok: fs.existsSync(scriptPath), path: scriptPath };

    // OpenAI key configurada?
    checks.openai = { ok: !!(process.env.OPENAI_API_KEY) };

    const allOk = Object.values(checks).every(c => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      checks,
    });
  });

  return router;
}

module.exports = { createAIRouter };
