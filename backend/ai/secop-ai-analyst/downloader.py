#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
downloader.py — Descarga documentos de procesos SECOP II

Estrategias (en orden de confiabilidad):
  1. datos.gov.co API jbjy-vk9h  — por referencia_del_proceso  (múltiples formatos)
  2. datos.gov.co API jbjy-vk9h  — por id_del_proceso (extraído de urlproceso)
  3. SECOP community portal API  — por proceso_id de urlproceso
  4. Scraping HTML básico         — fallback para páginas estáticas
"""
import os
import re
import time
import logging
import requests
from urllib.parse import urljoin, urlparse, parse_qs, quote
from pathlib import Path

logger = logging.getLogger(__name__)

SECOP_DOCS_API  = "https://www.datos.gov.co/resource/jbjy-vk9h.json"
SECOP_DOCS_API2 = "https://www.datos.gov.co/resource/wjxr-iv8s.json"
SECOP_COMMUNITY = "https://community.secop.gov.co"
TIMEOUT_DOWNLOAD = 30
TIMEOUT_API      = 12    # Aumentado — datos.gov.co puede ser lento
MAX_RETRIES = 2
MAX_FILE_SIZE = 40 * 1024 * 1024  # 40 MB
MAX_DOCS = 1000           # Aumentado para descargar la totalidad de los documentos

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/pdf,application/octet-stream,*/*",
}

# Permitir todas las extensiones (Catch-all)
class AllowAllExtensions:
    def __contains__(self, item):
        return True
    def __iter__(self):
        return iter([])

ALLOWED_EXTENSIONS = AllowAllExtensions()

# Prioridad de documentos (ESTUDIO PREVIO > INVITACION > CDP > COTIZACION > otros)
DOC_PRIORITY = {
    "estudio previo": 1,
    "estudio de sector": 1,
    "invitacion": 2,
    "pliego": 2,
    "cdp": 3,
    "certificado": 3,
    "paa": 4,
    "presupuesto": 4,
    "cotizacion": 5,
    "cotización": 5,
    "otro": 9,
}


def _safe_filename(text: str, max_len: int = 80) -> str:
    text = re.sub(r'[\\/:*?"<>|]', "_", str(text))
    text = re.sub(r"\s+", "_", text).strip("_")
    return text[:max_len] if text else "documento"


def _doc_priority(name: str) -> int:
    name_lower = (name or "").lower()
    for keyword, prio in DOC_PRIORITY.items():
        if keyword in name_lower:
            return prio
    return 9


def _download_file(url: str, dest_path: Path, session: requests.Session) -> dict:
    for attempt in range(MAX_RETRIES):
        try:
            resp = session.get(url, headers=HEADERS, timeout=TIMEOUT_DOWNLOAD, stream=True)
            resp.raise_for_status()

            content_length = int(resp.headers.get("Content-Length", 0))
            if content_length > MAX_FILE_SIZE:
                return {"ok": False, "error": f"Archivo demasiado grande: {content_length // 1024}KB"}

            content_type = resp.headers.get("Content-Type", "")
            if not dest_path.suffix:
                ext = ".pdf" if "pdf" in content_type else ".bin"
                dest_path = dest_path.with_suffix(ext)

            size = 0
            with open(dest_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
                        size += len(chunk)
                        if size > MAX_FILE_SIZE:
                            break

            if size < 512:
                dest_path.unlink(missing_ok=True)
                return {"ok": False, "error": "Archivo vacío o demasiado pequeño"}

            return {
                "ok": True,
                "path": str(dest_path),
                "filename": dest_path.name,
                "size_kb": round(size / 1024, 1),
                "content_type": content_type,
                "url": url,
            }

        except requests.HTTPError as e:
            code = e.response.status_code if e.response else 0
            if code in (403, 404, 410):
                return {"ok": False, "error": f"HTTP {code}"}
            if attempt < MAX_RETRIES - 1:
                time.sleep(1.5)
                continue
            return {"ok": False, "error": str(e)}
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                time.sleep(1.5)
                continue
            return {"ok": False, "error": str(e)}

    return {"ok": False, "error": "Máximo de reintentos alcanzado"}


def _query_docs_api(api_url: str, where_clause: str, session: requests.Session) -> list:
    """Consulta un endpoint de la API con una cláusula WHERE SoQL."""
    try:
        params = {
            "$where": where_clause,
            "$limit": str(MAX_DOCS),
            "$select": "url_del_documento,nombre_del_documento,tipo_de_documento,"
                       "referencia_del_proceso,id_del_proceso",
        }
        resp = session.get(api_url, params=params, timeout=TIMEOUT_API)
        if resp.ok:
            docs = resp.json()
            if isinstance(docs, list) and docs:
                logger.info(f"API '{api_url}' WHERE '{where_clause}' → {len(docs)} docs")
                return docs
    except Exception as e:
        logger.debug(f"API query error ({api_url}, '{where_clause}'): {e}")
    return []


def _query_docs_direct_filter(api_url: str, field: str, value: str, session: requests.Session) -> list:
    """Consulta usando filtro directo de columna (más rápido que SoQL)."""
    try:
        resp = session.get(
            api_url,
            params={field: value, "$limit": str(MAX_DOCS),
                    "$select": "url_del_documento,nombre_del_documento,tipo_de_documento,"
                               "referencia_del_proceso,id_del_proceso"},
            timeout=TIMEOUT_API,
        )
        if resp.ok:
            docs = resp.json()
            if isinstance(docs, list) and docs:
                logger.info(f"API directo '{field}'='{value}' → {len(docs)} docs")
                return docs
    except Exception as e:
        logger.debug(f"Direct filter error: {e}")
    return []


def _extract_process_id_from_url(url: str) -> str:
    """Extrae el 'id' de una URL de community.secop.gov.co."""
    if not url:
        return ""
    try:
        qs = parse_qs(urlparse(url).query)
        return qs.get("id", [""])[0]
    except Exception:
        return ""


def _get_docs_from_community_api(process_id: str, session: requests.Session) -> list:
    """
    Intenta obtener documentos del portal SECOP community por process_id.
    Prueba varios endpoints conocidos.
    """
    if not process_id:
        return []

    endpoints = [
        f"{SECOP_COMMUNITY}/api/v1/Documents/GetDocumentsList?processId={process_id}",
        f"{SECOP_COMMUNITY}/api/v1/TenderingProcess/GetDocuments?id={process_id}",
        f"{SECOP_COMMUNITY}/Public/Tendering/OpportunityDetail/GetDocuments?id={process_id}",
    ]

    for url in endpoints:
        try:
            resp = session.get(url, timeout=TIMEOUT_API, headers={**HEADERS, "Accept": "application/json"})
            if resp.ok:
                data = resp.json()
                # La respuesta puede ser una lista o tener un campo 'documents' o 'data'
                if isinstance(data, list):
                    docs = data
                elif isinstance(data, dict):
                    docs = data.get("documents") or data.get("data") or data.get("result") or []
                else:
                    continue

                if docs:
                    logger.info(f"Community API '{url}' → {len(docs)} docs")
                    return docs
        except Exception as e:
            logger.debug(f"Community API error ({url}): {e}")

    return []


def _scrape_secop_page(url: str, output_dir: Path, session: requests.Session, offset: int) -> list:
    """
    Scraping de la página del proceso SECOP II.
    Busca links a documentos (PDF, XLSX, DOCX) en el HTML.
    También intenta el API interno de la comunidad.
    """
    downloaded = []
    if not url:
        return downloaded

    try:
        # Intentar obtener el HTML de la página
        resp = session.get(url, timeout=20, headers={**HEADERS, "Accept": "text/html,*/*"})
        if not resp.ok:
            return downloaded

        html = resp.text
        base_url = f"{urlparse(url).scheme}://{urlparse(url).netloc}"

        # Patrones para encontrar URLs de documentos
        patterns = [
            r'https?://[^\s"\'<>]+\.(?:pdf|xlsx|docx|doc|xls)(?:\?[^\s"\'<>]*)?',
            r'href=["\']([^"\']+\.(?:pdf|xlsx|docx)[^"\']*)["\']',
            r'"url"\s*:\s*"(https?://[^"]+\.(?:pdf|xlsx|docx)[^"]*)"',
            r'documentId["\s:=]+(\d+)',  # IDs de documentos en el DOM
        ]

        doc_urls = []
        seen = set()

        for pat in patterns[:3]:
            matches = re.findall(pat, html, re.IGNORECASE)
            for m in matches:
                full_url = m if m.startswith("http") else (base_url + m if m.startswith("/") else None)
                if full_url and full_url not in seen:
                    seen.add(full_url)
                    doc_urls.append(full_url)

        # Intentar IDs de documentos para construir URLs de descarga
        doc_ids = re.findall(r'documentId["\s:=]+(\d+)', html, re.IGNORECASE)
        for doc_id in doc_ids[:MAX_DOCS]:
            dl_url = f"{SECOP_COMMUNITY}/Public/Tendering/Download/GetDocumentToDownload?documentId={doc_id}"
            if dl_url not in seen:
                seen.add(dl_url)
                doc_urls.append(dl_url)

        logger.info(f"Scraping encontró {len(doc_urls)} URLs candidatas")

        for doc_url in doc_urls:
            if offset + len(downloaded) >= MAX_DOCS:
                break
            ext = _get_extension(doc_url)
            if ext not in ALLOWED_EXTENSIONS:
                ext = ".pdf"
            idx = offset + len(downloaded) + 1
            safe_name = _safe_filename(doc_url[-50:])
            dest = output_dir / f"{idx:02d}_scraped_{safe_name}{ext}"
            result = _download_file(doc_url, dest, session)
            if result["ok"]:
                result["doc_type"] = "documento_web"
                result["source"] = "html_scrape"
                downloaded.append(result)
                logger.info(f"✅ Scraped: {dest.name} ({result['size_kb']}KB)")

    except Exception as e:
        logger.debug(f"Scraping error: {e}")

    return downloaded


def download_process_documents(process_data: dict, output_dir: Path,
                               progress_cb=None, pre_scraped_urls: list = None) -> list:
    """
    Descarga todos los documentos de un proceso SECOP II.

    Estrategia multi-capa:
      0. URLs pre-extraídas por Playwright (máxima confiabilidad)
      1. datos.gov.co jbjy-vk9h — filtro directo referencia_del_proceso
      2. datos.gov.co jbjy-vk9h — SoQL WHERE con referencia (múltiples formatos)
      3. datos.gov.co jbjy-vk9h — por id_del_proceso (extraído del urlproceso)
      4. Community SECOP portal API
      5. Scraping HTML de la página del proceso
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers.update(HEADERS)
    downloaded = []
    pre_scraped_urls = pre_scraped_urls or []

    refs = _extract_references(process_data)
    url_proceso = _get_process_url(process_data)
    process_id = _extract_process_id_from_url(url_proceso)

    if progress_cb:
        progress_cb(5, f"Buscando documentos para {len(refs)} referencias...")

    # ── Estrategia 0: URLs pre-extraídas por Playwright ───────────────────
    if pre_scraped_urls:
        logger.info(f"Descargando {len(pre_scraped_urls)} docs pre-scraped por Playwright")
        if progress_cb:
            progress_cb(8, f"Descargando {len(pre_scraped_urls)} documentos identificados...")
        for i, doc_info in enumerate(pre_scraped_urls[:MAX_DOCS]):
            # doc_info puede ser {url, name, type, localPath} o solo una string
            if isinstance(doc_info, str):
                url = doc_info
                nombre = f"documento_{i+1}"
                tipo = "documento"
                local_path = None
            else:
                url = doc_info.get("url", "")
                nombre = doc_info.get("name", f"documento_{i+1}")
                tipo = doc_info.get("type", "documento")
                local_path = doc_info.get("localPath")

            # Si ya fue descargado localmente por Playwright
            if local_path and Path(local_path).exists():
                fpath = Path(local_path)
                downloaded.append({
                    "ok": True,
                    "path": str(fpath),
                    "filename": fpath.name,
                    "size_kb": round(fpath.stat().st_size / 1024, 1),
                    "content_type": _mime_from_ext(fpath.suffix),
                    "url": url,
                    "doc_type": tipo,
                    "original_name": nombre,
                    "source": "playwright",
                })
                logger.info(f"✅ Local (Playwright): {fpath.name}")
                continue

            if not url or not url.startswith("http"):
                continue

            ext = _get_extension(url)
            if ext not in ALLOWED_EXTENSIONS:
                ext = ".pdf"
            filename = f"{i+1:02d}_{_safe_filename(tipo[:20])}_{_safe_filename(nombre[:40])}{ext}"
            dest = output_dir / filename
            result = _download_file(url, dest, session)
            if result["ok"]:
                result.update({"doc_type": tipo, "original_name": nombre, "source": "playwright"})
                downloaded.append(result)
                logger.info(f"✅ Playwright: {filename} ({result['size_kb']}KB)")
            else:
                logger.warning(f"⚠️ Playwright URL falló {filename}: {result['error']}")

            if progress_cb:
                pct = 8 + int((i + 1) / max(len(pre_scraped_urls), 1) * 30)
                progress_cb(pct, f"Descargando: {nombre[:50]}...")

        if downloaded:
            if progress_cb:
                progress_cb(42, f"{len(downloaded)} documento(s) descargado(s) del portal SECOP II")
            logger.info(f"Playwright: {len(downloaded)} docs descargados exitosamente")
            return downloaded

    # ── Estrategia 1 y 2: API datos.gov.co ────────────────────────────────
    api_docs = []

    for ref in refs:
        if not ref or api_docs:
            break

        # 1a. Filtro directo (columna = valor, sin SoQL)
        api_docs = _query_docs_direct_filter(SECOP_DOCS_API, "referencia_del_proceso", ref, session)
        if api_docs:
            break

        # 1b. SoQL WHERE con espacios correctos
        api_docs = _query_docs_api(SECOP_DOCS_API, f"referencia_del_proceso = '{ref}'", session)
        if api_docs:
            break

        # 1c. SoQL LIKE (por si la referencia tiene variantes de formato)
        safe_ref = ref.replace("'", "''")
        api_docs = _query_docs_api(SECOP_DOCS_API, f"upper(referencia_del_proceso) like upper('%{safe_ref}%')", session)
        if api_docs:
            break

        # 1d. Búsqueda full-text
        try:
            r = session.get(SECOP_DOCS_API,
                            params={"$q": ref, "$limit": str(MAX_DOCS)},
                            timeout=TIMEOUT_API)
            if r.ok:
                fts = r.json()
                if isinstance(fts, list) and fts:
                    api_docs = fts
                    logger.info(f"FTS '{ref}' → {len(api_docs)} docs")
                    break
        except Exception as e:
            logger.debug(f"FTS error: {e}")

    # 1e. Intentar segundo conjunto de APIs si no encontró nada
    if not api_docs:
        for ref in refs:
            if not ref:
                continue
            api_docs = _query_docs_direct_filter(SECOP_DOCS_API2, "referencia_del_proceso", ref, session)
            if api_docs:
                break

    # ── Estrategia 3: por id_del_proceso ──────────────────────────────────
    if not api_docs and process_id:
        api_docs = _query_docs_direct_filter(SECOP_DOCS_API, "id_del_proceso", process_id, session)
        if not api_docs:
            api_docs = _query_docs_api(SECOP_DOCS_API, f"id_del_proceso = '{process_id}'", session)

    # También intentar con el id_del_proceso del propio process_data
    if not api_docs:
        pid = process_data.get("id_del_proceso") or process_data.get("_id")
        if pid and str(pid) != process_id:
            api_docs = _query_docs_direct_filter(SECOP_DOCS_API, "id_del_proceso", str(pid), session)

    if progress_cb:
        progress_cb(15, f"API encontró {len(api_docs)} documentos. Descargando...")

    # Ordenar por prioridad (estudio previo e invitación primero)
    api_docs.sort(key=lambda d: _doc_priority(d.get("nombre_del_documento", "") or d.get("tipo_de_documento", "")))

    # Descargar documentos de la API
    for i, doc in enumerate(api_docs[:MAX_DOCS]):
        url = doc.get("url_del_documento") or doc.get("url") or ""
        if not url or not url.startswith("http"):
            continue

        nombre = doc.get("nombre_del_documento") or doc.get("nombre") or f"documento_{i+1}"
        tipo = doc.get("tipo_de_documento") or "documento"
        ext = _get_extension(url)
        if ext not in ALLOWED_EXTENSIONS:
            ext = ".pdf"

        filename = f"{i+1:02d}_{_safe_filename(tipo[:20])}_{_safe_filename(nombre[:40])}{ext}"
        dest = output_dir / filename

        result = _download_file(url, dest, session)
        if result["ok"]:
            result.update({
                "doc_type": tipo,
                "original_name": nombre,
                "source": "secop_api",
            })
            downloaded.append(result)
            logger.info(f"✅ Descargado: {filename} ({result['size_kb']}KB)")
        else:
            logger.warning(f"⚠️  Falló {filename}: {result['error']}")

        if progress_cb:
            pct = 15 + int((i + 1) / max(len(api_docs[:MAX_DOCS]), 1) * 30)
            progress_cb(pct, f"Descargando: {nombre[:50]}...")

    # ── Estrategia 4: SECOP Community Portal API ──────────────────────────
    if len(downloaded) < 2 and process_id:
        if progress_cb:
            progress_cb(50, "Consultando portal SECOP community...")
        community_docs = _get_docs_from_community_api(process_id, session)
        for i, doc in enumerate(community_docs[:MAX_DOCS - len(downloaded)]):
            url = doc.get("url") or doc.get("downloadUrl") or doc.get("url_del_documento") or ""
            if not url or not url.startswith("http"):
                # Construir URL desde documentId
                doc_id = doc.get("id") or doc.get("documentId") or doc.get("documento_id") or ""
                if doc_id:
                    url = f"{SECOP_COMMUNITY}/Public/Tendering/Download/GetDocumentToDownload?documentId={doc_id}"
                else:
                    continue

            nombre = doc.get("name") or doc.get("nombre") or doc.get("nombre_del_documento") or f"doc_{i+1}"
            ext = _get_extension(url)
            if ext not in ALLOWED_EXTENSIONS:
                ext = ".pdf"
            idx = len(downloaded) + 1
            dest = output_dir / f"{idx:02d}_community_{_safe_filename(nombre[:50])}{ext}"
            result = _download_file(url, dest, session)
            if result["ok"]:
                result.update({"doc_type": "comunidad", "original_name": nombre, "source": "community_api"})
                downloaded.append(result)
                logger.info(f"✅ Community: {dest.name}")

    # ── Estrategia 5: Scraping de la página del proceso ───────────────────
    if url_proceso and len(downloaded) < 2:
        if progress_cb:
            progress_cb(60, "Buscando documentos en página del proceso...")
        scraped = _scrape_secop_page(url_proceso, output_dir, session, len(downloaded))
        downloaded.extend(scraped)

    # ── URL directa del proceso (si es PDF) ───────────────────────────────
    if url_proceso and len(downloaded) == 0:
        try:
            resp = session.head(url_proceso, timeout=10, allow_redirects=True)
            ct = resp.headers.get("Content-Type", "")
            if "pdf" in ct.lower():
                dest = output_dir / "01_proceso_directo.pdf"
                result = _download_file(url_proceso, dest, session)
                if result["ok"]:
                    result["doc_type"] = "pliego"
                    result["source"] = "direct_url"
                    downloaded.append(result)
        except Exception:
            pass

    if progress_cb:
        progress_cb(80, f"Descarga completa: {len(downloaded)} documento(s) obtenido(s)")

    logger.info(f"Total descargado: {len(downloaded)} documentos")
    return downloaded


def _extract_references(process_data: dict) -> list:
    refs = []
    for key in ("_referencia", "referencia_del_proceso", "numero_del_proceso",
                "id_del_proceso", "referencia", "id"):
        val = process_data.get(key, "")
        if val and str(val).strip():
            refs.append(str(val).strip())
    return list(dict.fromkeys(refs))


def _get_process_url(process_data: dict) -> str:
    """Extrae la URL del proceso — maneja tanto strings como dicts {'url': '...'}."""
    for key in ("_url", "url_proceso", "urlproceso", "urlSecop", "url"):
        val = process_data.get(key)
        if not val:
            continue
        # SECOP II devuelve {'url': 'https://...'} en lugar de string directo
        if isinstance(val, dict):
            val = val.get("url") or val.get("href") or val.get("link") or next(iter(val.values()), "")
        val = str(val).strip()
        if val.startswith("http"):
            return val
    return ""


def _get_extension(url: str) -> str:
    try:
        path = urlparse(url).path.lower()
        m = re.search(r'\.([a-zA-Z0-9]{2,5})(?:\?|$)', path)
        if m:
            return "." + m.group(1)
    except Exception:
        pass
    return ".pdf"


def _mime_from_ext(ext: str) -> str:
    """MIME type por extensión."""
    return {
        ".pdf":  "application/pdf",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xls":  "application/vnd.ms-excel",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc":  "application/msword",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".zip":  "application/zip",
    }.get(ext.lower(), "application/octet-stream")
