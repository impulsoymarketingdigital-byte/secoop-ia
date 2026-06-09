'use strict';
/**
 * JIREHAI — SECOP II Document Scraper (Playwright con autenticación)
 * services/secop-scraper.js
 *
 * Usa un navegador headless para:
 *   1. Iniciar sesión en community.secop.gov.co con usuario/contraseña
 *   2. Navegar a la URL del proceso
 *   3. Extraer y descargar todos los documentos disponibles
 *
 * Credenciales: SECOP_USER y SECOP_PASS en el .env
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const LOGIN_URL   = 'https://community.secop.gov.co/STS/Users/Login/Index'
                  + '?SkinName=CCE&currentLanguage=es-CO&Page=login&Country=CO';
const MAX_DOCS    = 15;
const PAGE_WAIT   = 8_000;    // ms tras cargar página
const TIMEOUT     = 30_000;   // ms máx por navegación

// Archivo para guardar cookies de sesión (evita login en cada análisis)
const SESSION_FILE = path.join(__dirname, '..', '.secop_session.json');

/**
 * Extrae la URL real del campo urlproceso (puede ser string o dict).
 */
function extractProcessUrl(urlField) {
  if (!urlField) return '';
  if (typeof urlField === 'string') return urlField.startsWith('http') ? urlField : '';
  if (typeof urlField === 'object') {
    const v = urlField.url || urlField.href || urlField.link || Object.values(urlField)[0] || '';
    return String(v).startsWith('http') ? String(v) : '';
  }
  return '';
}

/**
 * Realiza login en SECOP II y devuelve las cookies de sesión.
 * Las guarda en disco para reutilizarlas.
 */
async function secopLogin(page, username, password) {
  console.log('[SCRAPER] Iniciando sesión en SECOP II...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(3000);

  // Verificar que la página de login cargó correctamente
  const usernameField = page.locator('#txtUserName');
  const passwordField = page.locator('#txtPassword');

  const hasLogin = await usernameField.count() > 0;
  if (!hasLogin) {
    console.warn('[SCRAPER] Formulario de login no encontrado');
    return false;
  }

  // Llenar credenciales
  await usernameField.fill(username);
  await passwordField.fill(password);

  // Intentar hacer clic en "Ingresar" sin resolver el captcha
  // (el captcha a veces no se activa en sesiones automatizadas)
  await page.locator('#btnLoginButton').click();
  await page.waitForTimeout(4000);

  const currentUrl = page.url();
  console.log('[SCRAPER] URL post-login:', currentUrl);

  // Si redirigió lejos del login → éxito
  if (!currentUrl.includes('/Login/')) {
    console.log('[SCRAPER] ✅ Login exitoso');
    return true;
  }

  // Si sigue en login, verificar si hay error de captcha o credenciales
  const errorMsg = await page.evaluate(() => {
    const err = document.querySelector('.ErrorMessage, .alert-danger, [class*="error"]');
    return err ? err.textContent.trim() : '';
  });

  if (errorMsg) {
    console.error('[SCRAPER] Error de login:', errorMsg);
  }

  // Intentar si el captcha de imagen es necesario
  const captchaInput = await page.locator('#txttxtCaptcha').count();
  if (captchaInput > 0) {
    console.warn('[SCRAPER] El login requiere CAPTCHA de imagen — no se puede automatizar sin 2captcha');
  }

  return false;
}

/**
 * Extrae URLs de documentos de la página del proceso (requiere sesión activa).
 */
async function extractDocumentLinks(page, processUrl) {
  console.log('[SCRAPER] Navegando al proceso:', processUrl);
  await page.goto(processUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(PAGE_WAIT);

  const docLinks = [];

  // ── Estrategia 1: buscar links de descarga directa ──────────────────
  const links = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href || '';
      const text = a.textContent.trim();
      if (
        href.match(/\.(pdf|xlsx?|docx?|pptx?|zip)/i) ||
        href.toLowerCase().includes('download') ||
        href.toLowerCase().includes('getdocument') ||
        href.toLowerCase().includes('descargar') ||
        /descargar|download|ver documento/i.test(text)
      ) {
        results.push({
          url:  href,
          name: text || href.split('/').pop() || 'documento',
        });
      }
    });
    return results;
  });

  for (const lk of links) {
    if (lk.url && lk.url.startsWith('http')) {
      docLinks.push({ url: lk.url, name: _cleanName(lk.name), type: _guessType(lk.url, lk.name) });
    }
  }

  // ── Estrategia 2: buscar documentIds en el DOM/JS ────────────────────
  if (docLinks.length === 0) {
    const appState = await page.evaluate(() => {
      // Buscar en scripts embebidos
      let found = '';
      document.querySelectorAll('script:not([src])').forEach(s => {
        const txt = s.textContent;
        if (txt.includes('documentId') || txt.includes('GetDocumentToDownload')) {
          found += txt.substring(0, 8000);
        }
      });
      return found || document.body.innerHTML.substring(0, 8000);
    });

    const docIds = [...appState.matchAll(/documentId["\s:='"]+(\d+)/gi)].map(m => m[1]);
    const seen = new Set();
    for (const id of docIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      docLinks.push({
        url:  `https://community.secop.gov.co/Public/Tendering/Download/GetDocumentToDownload?documentId=${id}`,
        name: `documento_${id}`,
        type: 'documento',
      });
    }
  }

  // ── Estrategia 3: buscar tabla de documentos con botones Descargar ───
  if (docLinks.length === 0) {
    const tableRows = await page.evaluate(() => {
      const results = [];
      // Buscar todas las filas de tablas
      document.querySelectorAll('tr').forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        const downloadBtn = row.querySelector('[onclick*="download" i], [onclick*="document" i], [href*="download" i]');
        if (downloadBtn) {
          const name = cells[0]?.textContent.trim() || 'documento';
          const onclick = downloadBtn.getAttribute('onclick') || '';
          const href = downloadBtn.getAttribute('href') || '';
          // Extraer ID del onclick si lo hay
          const idMatch = onclick.match(/['"]?(\d+)['"]?/);
          if (idMatch) {
            results.push({
              url: `https://community.secop.gov.co/Public/Tendering/Download/GetDocumentToDownload?documentId=${idMatch[1]}`,
              name,
              type: 'documento',
            });
          } else if (href.startsWith('http')) {
            results.push({ url: href, name, type: 'documento' });
          }
        }
      });
      return results;
    });
    docLinks.push(...tableRows);
  }

  // ── Estrategia 4: navegar a la pestaña/sección de Documentos si existe
  if (docLinks.length === 0) {
    const docTab = page.locator('text=/documentos/i, [data-tab*="doc" i], #tabDocumentos');
    if (await docTab.count() > 0) {
      await docTab.first().click();
      await page.waitForTimeout(3000);
      // Reintentar estrategia 1 tras cambio de pestaña
      const tabLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .filter(a => /download|getdocument|descargar/i.test(a.href + a.textContent))
          .map(a => ({ url: a.href, name: a.textContent.trim() }))
      );
      docLinks.push(...tabLinks.map(l => ({ ...l, type: _guessType(l.url, l.name) })));
    }
  }

  // Deduplicar
  const seen = new Set();
  return docLinks.filter(d => {
    if (!d.url || seen.has(d.url)) return false;
    seen.add(d.url);
    return true;
  }).slice(0, MAX_DOCS);
}

/**
 * Descarga un documento con la sesión autenticada de Playwright.
 * Retorna { ok, path, filename, size_kb } o { ok: false, error }.
 */
async function downloadWithSession(context, docUrl, destDir, index) {
  const ext     = _getExt(docUrl);
  const tmpName = `${String(index + 1).padStart(2, '0')}_doc_${Date.now()}${ext}`;
  const destPath = path.join(destDir, tmpName);

  try {
    // Intentar descarga vía Playwright (maneja cookies y redirecciones)
    const page = await context.newPage();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25000 }),
      page.evaluate((url) => { window.location.href = url; }, docUrl),
    ]);

    const suggestedName = await download.suggestedFilename();
    const finalName = suggestedName
      ? path.join(destDir, `${String(index + 1).padStart(2, '0')}_${suggestedName}`)
      : destPath;

    await download.saveAs(finalName);
    await page.close();

    const stats = fs.statSync(finalName);
    return {
      ok:         true,
      path:       finalName,
      filename:   path.basename(finalName),
      size_kb:    Math.round(stats.size / 1024),
      url:        docUrl,
      source:     'secop_auth',
    };
  } catch (e) {
    // Fallback: fetch directo usando las cookies de la sesión
    try {
      const cookies = await context.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const https = require('https');
      const http  = require('http');
      const lib   = docUrl.startsWith('https') ? https : http;

      return await new Promise((resolve) => {
        const req = lib.get(docUrl, {
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          }
        }, (res) => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          // Nombre del archivo del Content-Disposition
          const cd = res.headers['content-disposition'] || '';
          const fnMatch = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
          const fname = fnMatch ? fnMatch[1].replace(/['"]/g, '').trim() : tmpName;
          const finalPath = path.join(destDir, `${String(index + 1).padStart(2, '0')}_${fname}`);
          const stream = fs.createWriteStream(finalPath);
          res.pipe(stream);
          stream.on('finish', () => {
            const stats = fs.statSync(finalPath);
            resolve({
              ok: true, path: finalPath, filename: path.basename(finalPath),
              size_kb: Math.round(stats.size / 1024), url: docUrl, source: 'secop_auth_fetch',
            });
          });
          stream.on('error', err => resolve({ ok: false, error: err.message }));
        });
        req.on('error', err => resolve({ ok: false, error: err.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
      });
    } catch (fe) {
      return { ok: false, error: fe.message };
    }
  }
}

/**
 * Función principal: login + extracción + descarga de documentos SECOP II.
 *
 * @param {string} processUrl  URL del proceso en community.secop.gov.co
 * @param {string} outputDir   Directorio donde guardar archivos descargados
 * @param {string} username    Usuario SECOP II (de .env SECOP_USER)
 * @param {string} password    Contraseña SECOP II (de .env SECOP_PASS)
 * @returns {Promise<Array>}   Lista de documentos descargados
 */
async function scrapeSecopDocuments(processUrl, outputDir, username, password) {
  let browser;
  const docs = [];

  try {
    const { chromium } = require('playwright');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
               + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: true,
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // ── Cargar cookies guardadas si existen (evitar login repetido) ──
    let loggedIn = false;
    if (fs.existsSync(SESSION_FILE)) {
      try {
        const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        const age   = Date.now() - (saved.timestamp || 0);
        if (age < 4 * 60 * 60 * 1000) {  // Válidas por 4 horas
          await context.addCookies(saved.cookies);
          loggedIn = true;
          console.log('[SCRAPER] Sesión reutilizada desde archivo');
        }
      } catch {}
    }

    // ── Login con credenciales ────────────────────────────────────────
    if (!loggedIn && username && password) {
      loggedIn = await secopLogin(page, username, password);
      if (loggedIn) {
        // Guardar cookies para próximas llamadas
        const cookies = await context.cookies();
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies, timestamp: Date.now() }), 'utf8');
      }
    }

    if (!loggedIn) {
      console.warn('[SCRAPER] No se pudo autenticar — intentando acceso anónimo');
    }

    // ── Extraer links de documentos ───────────────────────────────────
    const docLinks = await extractDocumentLinks(page, processUrl);
    console.log(`[SCRAPER] ${docLinks.length} documento(s) encontrado(s)`);

    // ── Descargar cada documento ──────────────────────────────────────
    fs.mkdirSync(outputDir, { recursive: true });
    for (let i = 0; i < docLinks.length; i++) {
      const docInfo = docLinks[i];
      console.log(`[SCRAPER] Descargando [${i+1}/${docLinks.length}]: ${docInfo.name}`);
      const result = await downloadWithSession(context, docInfo.url, outputDir, i);
      if (result.ok) {
        result.doc_type    = docInfo.type || 'documento';
        result.original_name = docInfo.name;
        docs.push(result);
        console.log(`[SCRAPER] ✅ ${result.filename} (${result.size_kb}KB)`);
      } else {
        console.warn(`[SCRAPER] ⚠️  ${docInfo.name}: ${result.error}`);
      }
    }

    await context.close();
  } catch (err) {
    console.error('[SCRAPER] Error:', err.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }

  return docs;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _cleanName(name) {
  return (name || 'documento').replace(/\s+/g, ' ').trim().substring(0, 120);
}

function _guessType(url, name) {
  const s = (url + name).toLowerCase();
  if (s.includes('estudio') || s.includes('previo')) return 'estudio_previo';
  if (s.includes('invitacion') || s.includes('pliego'))  return 'invitacion';
  if (s.includes('presupuesto'))  return 'presupuesto';
  if (s.includes('cotizacion') || s.includes('cotización')) return 'cotizacion';
  if (s.includes('cdp'))  return 'cdp';
  if (s.includes('paa'))  return 'paa';
  if (s.includes('.xlsx') || s.includes('.xls')) return 'excel';
  if (s.includes('.docx') || s.includes('.doc')) return 'word';
  return 'pdf';
}

function _getExt(url) {
  const m = (url || '').match(/\.(pdf|xlsx?|docx?|pptx?|zip)(\?|$)/i);
  return m ? '.' + m[1].toLowerCase() : '.pdf';
}

module.exports = { scrapeSecopDocuments, extractProcessUrl };
