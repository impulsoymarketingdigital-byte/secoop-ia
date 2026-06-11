'use strict';
/**
 * JIREHAI — AI Service (Node.js)
 * services/ai.service.js
 *
 * Puente entre Express y el motor Python (main.py).
 * Gestiona el ciclo de vida de los jobs de análisis SECOP II:
 *   1. Escribe job.json en disco
 *   2. Lanza python3 main.py <job.json> con child_process.spawn
 *   3. Lee mensajes JSON línea-a-línea desde stdout
 *   4. Actualiza el estado en SQLite (process_analysis)
 *   5. Almacena el resultado final (analysis_results)
 *   6. Limpia archivos temporales
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Constantes ──────────────────────────────────────────────────────────────
const PYTHON_SCRIPT = path.join(__dirname, '..', 'ai', 'secop-ai-analyst', 'main.py');
const OUTPUTS_BASE  = path.join(__dirname, '..', 'ai', 'outputs');
const JOB_TIMEOUT   = 10 * 60 * 1000; // 10 minutos máximo por job

// Intentar varios intérpretes Python en orden
const PYTHON_CANDIDATES = ['python3', 'python', 'py'];

// ── Utilidades ───────────────────────────────────────────────────────────────

/** Resuelve qué binario Python usar (lazy, se cachea tras primera llamada). */
let _pythonBin = null;
let _resolvingPython = null;

async function resolvePython() {
  if (_pythonBin) return _pythonBin;
  if (_resolvingPython) return _resolvingPython;

  const { exec } = require('child_process');
  const util = require('util');
  const execAsync = util.promisify(exec);

  _resolvingPython = (async () => {
    for (const bin of PYTHON_CANDIDATES) {
      try {
        await execAsync(`${bin} --version`);
        _pythonBin = bin;
        console.log(`🐍 Python engine resolved: ${bin}`);
        return bin;
      } catch {}
    }
    throw new Error('Python no encontrado. Instala python3 en el servidor.');
  })();

  try {
    return await _resolvingPython;
  } finally {
    _resolvingPython = null;
  }
}

/** Genera ID único para jobs (16 hex chars). */
function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

/** Asegura que el directorio de outputs existe. */
function ensureOutputDir(jobId) {
  const dir = path.join(OUTPUTS_BASE, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Borra directorio del job (cleanup post-análisis, ignorar errores). */
function cleanupJobDir(jobId) {
  try {
    const dir = path.join(OUTPUTS_BASE, jobId);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// ── Módulo principal ─────────────────────────────────────────────────────────

/**
 * Fábrica: recibe la referencia a la BD e instancia el servicio.
 * Uso: const aiSvc = createAIService(db);
 */
function createAIService(db) {
  // Map en memoria de { jobId → process } para poder cancelar/timeout
  const activeJobs = new Map();

  // ── Helpers BD ──────────────────────────────────────────────────────────

  function upsertAnalysis(jobId, fields) {
    const existing = db.prepare('SELECT id, status FROM process_analysis WHERE job_id = ?').get(jobId);
    
    // PROTECCIÓN: No permitir que un job ya completado vuelva a 'running' 
    // por mensajes de progreso que lleguen tarde o desordenados
    if (existing && existing.status === 'completed') {
      if (fields.status === 'running' || fields.status === 'pending') delete fields.status; if (fields.progress_pct !== undefined && fields.progress_pct < 100) delete fields.progress_pct; 
    }

    if (fields.progress_pct === 100 || fields.progress_step === 'complete') {
      fields.status = 'completed';
    }

    if (existing) {
      const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE process_analysis SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`)
        .run(...Object.values(fields), jobId);
    } else {
      const cols = ['job_id', ...Object.keys(fields)].join(', ');
      const vals = ['?', ...Object.keys(fields).map(() => '?')].join(', ');
      db.prepare(`INSERT INTO process_analysis (${cols}) VALUES (${vals})`)
        .run(jobId, ...Object.values(fields));
    }
  }

  function storeResult(jobId, userId, resultData) {
    const existing = db.prepare('SELECT id FROM analysis_results WHERE job_id = ?').get(jobId);
    const json = JSON.stringify(resultData);
    if (existing) {
      db.prepare('UPDATE analysis_results SET result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?')
        .run(json, jobId);
    } else {
      db.prepare('INSERT INTO analysis_results (job_id, user_id, result_json) VALUES (?, ?, ?)')
        .run(jobId, userId, json);
    }
  }

  function logProgress(jobId, step, pct, msg) {
    // Deshabilitado temporalmente para optimizar I/O
    /*
    try {
      db.prepare(`INSERT INTO analysis_progress (job_id, step, pct, msg) VALUES (?, ?, ?, ?)`)
        .run(jobId, step, pct, msg);
    } catch {}
    */
  }

  // ── Spawn Python ────────────────────────────────────────────────────────

  /**
   * Ejecuta el motor Python para un proceso SECOP.
   *
   * @param {object}  opts
   * @param {string}  opts.jobId        - UUID del job
   * @param {number}  opts.userId       - ID usuario que solicita
   * @param {object}  opts.processData  - Datos del proceso SECOP (campos normalizados)
   * @param {string}  opts.openaiApiKey - Clave OpenAI (puede ser env o la del usuario)
   * @param {object}  [opts.options]    - Opciones: skip_ocr, skip_products, skip_risks, max_docs
   * @returns {Promise<object>}         - Resolución con full_analysis o rechazo con error
   */
  async function runAnalysis({ jobId, userId, processData, openaiApiKey, options = {}, secopUser = '', secopPass = '' }) {
    const pythonBin = await resolvePython();
    const outputDir = ensureOutputDir(jobId);

    // ── Pre-scraping con Playwright: extraer URLs de documentos SECOP II ──
    let scrapedDocUrls = [];
    try {
      const { scrapeSecopDocuments, extractProcessUrl } = require('./secop-scraper');
      const rawUrl = processData._url || processData.url_proceso || processData.urlproceso || '';
      let processUrl = extractProcessUrl(rawUrl);

      // Fallback si no hay URL del proceso pero sí hay referencia
      if (!processUrl) {
        const ref = processData._referencia || processData.referencia_del_proceso || processData.numero_del_proceso || '';
        if (ref) {
          console.log(`[AI:${jobId.slice(0,8)}] URL del proceso vacía. Buscando en datos.gov.co para referencia: ${ref}`);
          try {
            const axios = require('axios');
            const searchUrl = `https://www.datos.gov.co/resource/p6dx-8zbt.json?referencia_del_proceso=${encodeURIComponent(ref)}`;
            const resp = await axios.get(searchUrl, { timeout: 10000 });
            if (resp.data && resp.data.length > 0) {
              const row = resp.data[0];
              const foundUrl = row.urlproceso?.url || row.urlproceso || '';
              processUrl = extractProcessUrl(foundUrl);
              if (processUrl) {
                console.log(`[AI:${jobId.slice(0,8)}] URL encontrada en datos.gov.co: ${processUrl}`);
              }
            }
          } catch (e) {
            console.error(`[AI:${jobId.slice(0,8)}] Error buscando URL por referencia:`, e.message);
          }
        }
      }

      if (processUrl && processUrl.startsWith('http')) {
        upsertAnalysis(jobId, {
          progress_msg: 'Extrayendo documentos del portal SECOP II...',
          progress_step: 'scraping',
          progress_pct: 2,
        });
        console.log(`[AI:${jobId.slice(0,8)}] Scraping documentos: ${processUrl}`);
        const docsDir = path.join(outputDir, 'docs');
        fs.mkdirSync(docsDir, { recursive: true });
        // Credenciales: del usuario > del .env
        const finalSecopUser = secopUser || process.env.SECOP_USER || '';
        const finalSecopPass = secopPass || process.env.SECOP_PASS || '';
        if (finalSecopUser) {
          console.log(`[AI:${jobId.slice(0,8)}] Autenticando como: ${finalSecopUser}`);
        }
        scrapedDocUrls = await scrapeSecopDocuments(processUrl, docsDir, finalSecopUser, finalSecopPass);
        console.log(`[AI:${jobId.slice(0,8)}] Playwright encontró ${scrapedDocUrls.length} documento(s)`);
      }
    } catch (scraperErr) {
      console.warn(`[AI:${jobId.slice(0,8)}] Scraper no disponible: ${scraperErr.message}`);
    }

    // Construir job.json
    const jobFilePath = path.join(outputDir, 'job.json');
    const jobPayload = {
      job_id: jobId,
      process_data: processData,
      openai_api_key: openaiApiKey || process.env.OPENAI_API_KEY || '',
      output_dir: outputDir,
      scraped_doc_urls: scrapedDocUrls,   // URLs pre-extraídas por Playwright
      options: {
        skip_ocr:      options.skip_ocr      ?? false,
        skip_products: options.skip_products ?? false,
        skip_risks:    options.skip_risks    ?? false,
        max_docs:      options.max_docs      ?? 15,
      },
    };
    fs.writeFileSync(jobFilePath, JSON.stringify(jobPayload, null, 2), 'utf8');

    // Estado inicial en BD
    upsertAnalysis(jobId, {
      user_id:          userId,
      process_ref:      processData._referencia || processData.referencia_del_proceso || '',
      entity_name:      processData._entidad    || processData.nombre_entidad || '',
      status:           'running',
      progress_pct:     0,
      progress_step:    'init',
      progress_msg:     'Iniciando análisis...',
      output_dir:       outputDir,
    });

    return new Promise((resolve, reject) => {
      const proc = spawn(pythonBin, [PYTHON_SCRIPT, jobFilePath], {
        cwd: path.dirname(PYTHON_SCRIPT),
        env: {
          ...process.env,
          OPENAI_API_KEY:    jobPayload.openai_api_key,
          PYTHONUNBUFFERED:  '1',   // Fuerza flush inmediato en stdout (crítico en Windows)
          PYTHONIOENCODING:  'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeJobs.set(jobId, proc);

      let buffer = '';
      let finalResult = null;
      let errorMsg = null;

      // ── stdout: mensajes JSON delimitados por \n ────────────────────────
      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // último fragmento puede estar incompleto

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            handlePythonMessage(msg);
          } catch {
            // Línea no-JSON (logs de Python que se colaron por stdout)
            console.log(`[AI:${jobId.slice(0,8)}:stdout] ${trimmed}`);
          }
        }
      });

      // ── stderr: logs Python → consola Node (no IPC) ────────────────────
      proc.stderr.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) console.log(`[AI:${jobId.slice(0,8)}:stderr] ${trimmed}`);
        }
      });

      // ── Manejo de mensajes individuales ───────────────────────────────
      function handlePythonMessage(msg) {
        if (msg.type === 'progress') {
          console.log(`[AI:${jobId.slice(0,8)}] Progreso: ${msg.pct}% - ${msg.step} - ${msg.msg}`);
          upsertAnalysis(jobId, {
            progress_pct:  msg.pct  ?? 0,
            progress_step: msg.step ?? '',
            progress_msg:  msg.msg  ?? '',
            status:        'running',
          });
          logProgress(jobId, msg.step, msg.pct, msg.msg);
          try {
            const sidecar = path.join(OUTPUTS_BASE, jobId, 'progress.json');
            fs.writeFileSync(sidecar, JSON.stringify({
              job_id: jobId, pct: msg.pct, step: msg.step, msg: msg.msg, updated_at: new Date().toISOString()
            }));
          } catch (e) {}

        } else if (msg.type === 'result') {
          console.log(`[AI:${jobId.slice(0,8)}] Resultado recibido`);
          finalResult = msg.data;
          upsertAnalysis(jobId, {
            status:        'completed',
            progress_pct:  100,
            progress_step: 'complete',
            progress_msg:  'Análisis completado',
          });
          storeResult(jobId, userId, finalResult);

        } else if (msg.type === 'error') {
          console.error(`[AI:${jobId.slice(0,8)}] Error de Python: ${msg.msg}`);
          errorMsg = msg.msg;
          upsertAnalysis(jobId, {
            status:       'error',
            error_msg:    msg.msg,
            progress_msg: msg.msg,
          });
        }
      }

      // ── Timeout ────────────────────────────────────────────────────────
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        const msg = `Timeout: el análisis excedió ${JOB_TIMEOUT / 60000} minutos`;
        upsertAnalysis(jobId, { status: 'error', error_msg: msg, progress_msg: msg });
        activeJobs.delete(jobId);
        reject(new Error(msg));
      }, JOB_TIMEOUT);

      // ── Cierre del proceso ────────────────────────────────────────────
      proc.on('close', (code) => {
        clearTimeout(timer);
        activeJobs.delete(jobId);

        // Procesar buffer residual
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim());
            handlePythonMessage(msg);
          } catch {}
        }

        if (finalResult) {
          // El resultado ya se guardó vía handlePythonMessage
          resolve(finalResult);
        } else if (errorMsg) {
          reject(new Error(errorMsg));
        } else if (code !== 0) {
          const msg = `Proceso Python terminó con código de error ${code}`;
          upsertAnalysis(jobId, { status: 'error', error_msg: msg, progress_msg: msg });
          reject(new Error(msg));
        } else {
          // ── Fallback cierre: stdout silencioso pero Python completó (code=0) ──
          // Ocurre en Windows cuando stdout se bufferiza y el pipe se cierra sin
          // que Node.js reciba los mensajes JSON. Leer analysis.json desde disco.
          const analysisFile = path.join(OUTPUTS_BASE, jobId, 'exports', 'analysis.json');
          if (fs.existsSync(analysisFile)) {
            try {
              const data = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
              console.log(`[runAnalysis] Fallback cierre activado para job ${jobId} — leyendo analysis.json`);
              storeResult(jobId, userId, data);
              const successMsg = 'Análisis completado (fallback)';
              upsertAnalysis(jobId, {
                status:        'completed',
                progress_pct:  100,
                progress_step: 'complete',
                progress_msg:  successMsg,
              });
              resolve(data);
            } catch (e) {
              const msg = `Error leyendo analysis.json tras cierre: ${e.message}`;
              console.error(`[runAnalysis] Fallback falló para ${jobId}:`, e.message);
              upsertAnalysis(jobId, { status: 'error', error_msg: msg, progress_msg: msg });
              reject(new Error(msg));
            }
          } else {
            const msg = 'El proceso terminó sin producir resultados legibles.';
            upsertAnalysis(jobId, { status: 'error', error_msg: msg, progress_msg: msg });
            reject(new Error(msg));
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        activeJobs.delete(jobId);
        const msg = `Error iniciando Python: ${err.message}`;
        upsertAnalysis(jobId, { status: 'error', error_msg: msg, progress_msg: msg });
        reject(new Error(msg));
      });
    });
  }

  // ── API Pública del Servicio ─────────────────────────────────────────────

  /**
   * Inicia un análisis en background y devuelve inmediatamente el jobId.
   * El análisis corre de forma asíncrona; el cliente hace polling por status.
   */
  function startAnalysis({ userId, processData, options = {}, secopUser = '', secopPass = '' }) {
    const jobId = newJobId();
    const openaiApiKey = process.env.OPENAI_API_KEY || '';

    // Insertar registro inicial ANTES de lanzar el async — así el primer poll
    // del cliente ya encuentra la fila en BD y no recibe 404.
    upsertAnalysis(jobId, {
      user_id:       userId,
      process_ref:   processData._referencia || processData.referencia_del_proceso || '',
      entity_name:   processData._entidad    || processData.nombre_entidad || '',
      status:        'running',
      progress_pct:  0,
      progress_step: 'init',
      progress_msg:  'Iniciando análisis...',
      output_dir:    '',
    });

    // Lanzar sin await — el caller sólo recibe el jobId
    runAnalysis({ jobId, userId, processData, openaiApiKey, options, secopUser, secopPass })
      .then(() => {
        console.log(`✅ AI job ${jobId} completado`);
      })
      .catch((err) => {
        console.error(`❌ AI job ${jobId} falló:`, err.message);
      });

    return jobId;
  }

  /**
   * Devuelve el estado actual del job desde la BD.
   * FALLBACK 1: si status='running' pero analysis_results tiene datos → completed.
   * FALLBACK 2: si status='running' pero analysis.json existe en disco → leer,
   *             guardar en BD y retornar completed. (soluciona buffering Windows)
   */
  function getStatus(jobId) {
    const row = db.prepare(`
      SELECT job_id, status, progress_pct, progress_step, progress_msg,
             error_msg, process_ref, entity_name, created_at, updated_at
      FROM process_analysis WHERE job_id = ?
    `).get(jobId);

    if (!row) return null;
    if (row.status !== 'running') return row;

    // ── Fallback 1: resultado ya en BD ────────────────────────────────────
    const hasResult = db.prepare('SELECT id FROM analysis_results WHERE job_id = ?').get(jobId);
    if (hasResult) {
      console.log(`[getStatus] Fallback BD activado para job ${jobId}`);
      _markCompleted(jobId);
      return { ...row, status: 'completed', progress_pct: 100,
               progress_step: 'complete', progress_msg: 'Análisis completado' };
    }

    // ── Fallback 2: analysis.json existe en disco ─────────────────────────
    const analysisFile = path.join(OUTPUTS_BASE, jobId, 'exports', 'analysis.json');
    if (fs.existsSync(analysisFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(analysisFile, 'utf8'));
        // Guardar en BD para que getResult() lo encuentre también
        const existing = db.prepare('SELECT id FROM analysis_results WHERE job_id = ?').get(jobId);
        const row2 = db.prepare('SELECT user_id FROM process_analysis WHERE job_id = ?').get(jobId);
        const userId = row2?.user_id ?? 0;
        if (existing) {
          db.prepare('UPDATE analysis_results SET result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?')
            .run(JSON.stringify(data), jobId);
        } else {
          db.prepare('INSERT INTO analysis_results (job_id, user_id, result_json) VALUES (?, ?, ?)')
            .run(jobId, userId, JSON.stringify(data));
        }
        _markCompleted(jobId);
        console.log(`[getStatus] Fallback disco activado para job ${jobId}`);
        return { ...row, status: 'completed', progress_pct: 100,
                 progress_step: 'complete', progress_msg: 'Análisis completado' };
      } catch (e) {
        console.error(`[getStatus] Error leyendo analysis.json para ${jobId}:`, e.message);
      }
    }

    // ── Fallback 3: progress.json (sidecar) existe en disco ───────────────
    // Soluciona el problema de "stuck at 5%" cuando stdout está bufferizado.
    const progressFile = path.join(OUTPUTS_BASE, jobId, 'progress.json');
    if (fs.existsSync(progressFile)) {
      try {
        const p = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        // Si el progreso en disco es más avanzado que el de la BD, usarlo
        if (p.pct > (row.progress_pct || 0)) {
          console.log(`[getStatus] Fallback progress.json activado para ${jobId}: ${p.pct}%`);
          return {
            ...row,
            progress_pct:  p.pct,
            progress_step: p.step,
            progress_msg:  p.msg
          };
        }
      } catch (e) {}
    }

    return row;
  }

  function _markCompleted(jobId) {
    db.prepare(`
      UPDATE process_analysis
      SET status = 'completed', progress_pct = 100,
          progress_step = 'complete', progress_msg = 'Análisis completado',
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(jobId);
  }

  /**
   * Devuelve el resultado completo del job desde analysis_results.
   */
  function getResult(jobId) {
    const row = db.prepare('SELECT result_json FROM analysis_results WHERE job_id = ?').get(jobId);
    if (!row) return null;
    try { return JSON.parse(row.result_json); }
    catch { return null; }
  }

  /**
   * Lista el historial de análisis de un usuario.
   */
  function listUserJobs(userId, limit = 20) {
    return db.prepare(`
      SELECT pa.job_id, pa.process_ref, pa.entity_name, pa.status,
             pa.progress_pct, pa.created_at, pa.updated_at,
             CASE WHEN ar.id IS NOT NULL THEN 1 ELSE 0 END AS has_result
      FROM process_analysis pa
      LEFT JOIN analysis_results ar ON pa.job_id = ar.job_id
      WHERE pa.user_id = ?
      ORDER BY pa.created_at DESC
      LIMIT ?
    `).all(userId, limit);
  }

  /**
   * Cancela un job en ejecución (si el proceso Python aún vive).
   */
  function cancelJob(jobId) {
    const proc = activeJobs.get(jobId);
    if (proc) {
      proc.kill('SIGTERM');
      activeJobs.delete(jobId);
      upsertAnalysis(jobId, { status: 'cancelled', progress_msg: 'Análisis cancelado por el usuario' });
      return true;
    }
    return false;
  }

  /**
   * Borra registros del job (analysis + result) y archivos de disco.
   */
  function deleteJob(jobId, userId) {
    cancelJob(jobId); // Por si acaso aún corre
    db.prepare('DELETE FROM analysis_results WHERE job_id = ? AND user_id = ?').run(jobId, userId);
    db.prepare('DELETE FROM process_analysis WHERE job_id = ? AND user_id = ?').run(jobId, userId);
    cleanupJobDir(jobId);
  }

  /**
   * Devuelve la ruta de un archivo de export (si existe en disco).
   */
  function getExportPath(jobId, format) {
    const result = getResult(jobId);
    if (!result?.exports) return null;

    const FORMATS = {
      json:         'analysis.json',
      md:           'executive_summary.md',
      xlsx:         'informe_completo.xlsx',
      informe_xlsx: 'informe_completo.xlsx',
      informe_pdf:  'informe_completo.pdf',
      legal:        'legal_analysis.md',
      risks:        'risk_report.md',
      products:     'product_summary.json',
    };

    const filename = FORMATS[format];
    if (!filename) return null;

    // Buscar en exports por nombre de archivo exacto
    const filePath = Object.values(result.exports || {}).find(p => p && path.basename(p) === filename);
    if (filePath && fs.existsSync(filePath)) return filePath;

    // Fallback: buscar en output_dir
    const row = db.prepare('SELECT output_dir FROM process_analysis WHERE job_id = ?').get(jobId);
    if (!row?.output_dir) return null;
    const candidate = path.join(row.output_dir, 'exports', filename);
    return fs.existsSync(candidate) ? candidate : null;
  }

  return {
    startAnalysis,
    getStatus,
    getResult,
    listUserJobs,
    cancelJob,
    deleteJob,
    getExportPath,
  };
}

module.exports = { createAIService };
