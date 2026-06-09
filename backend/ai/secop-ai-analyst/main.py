#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
main.py — Orquestador principal del motor de análisis SECOP II

Uso: python main.py <ruta_al_job.json>

El job.json tiene la estructura:
{
  "job_id": "uuid",
  "process_data": { ... datos del proceso SECOP },
  "openai_api_key": "sk-...",
  "output_dir": "/ruta/outputs/job_id",
  "options": {
    "skip_ocr": false,
    "skip_products": false,
    "skip_risks": false,
    "max_docs": 8
  }
}

Salida: líneas JSON delimitadas por newline a STDOUT:
  {"type":"progress","step":"download","pct":10,"msg":"Descargando documentos..."}
  ...
  {"type":"result","data":{...}}          ← último mensaje
  {"type":"error","msg":"..."}            ← si falla críticamente
"""
import json
import logging
import os
import sys
import threading
import time as _time
import traceback
import io
from datetime import datetime
from pathlib import Path

# Forzar UTF-8 en Windows para evitar fallos de encoding en el pipe IPC
# Eliminado temporalmente para diagnosticar cuelgue en 2%
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Configurar logging a stderr para no contaminar stdout (que es el canal IPC)
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("secop_ai")

# Lock para que el hilo heartbeat y el hilo principal no mezclen salida stdout
_stdout_lock = threading.Lock()


# Globales para el sidecar de progreso
_job_id_str = "unknown"
_output_dir_path = None


def emit(msg: dict):
    """Emite un mensaje JSON a stdout para Node.js (thread-safe)."""
    try:
        with _stdout_lock:
            data = json.dumps(msg, ensure_ascii=False)
            sys.stdout.write(data + "\n")
            sys.stdout.flush()
    except Exception as e:
        logger.error(f"Error emitiendo mensaje IPC: {e}")


def progress(step: str, pct: int, msg: str):
    """Reporta el progreso a Node.js vía stdout."""
    emit({"type": "progress", "step": step, "pct": pct, "msg": msg})


def main():
    global _job_id_str, _output_dir_path
    # ── Leer argumento ────────────────────────────────────────────────────────
    if len(sys.argv) < 2:
        emit({"type": "error", "msg": "Uso: python main.py <job.json>"})
        sys.exit(1)

    job_path = Path(sys.argv[1])
    if not job_path.exists():
        emit({"type": "error", "msg": f"Job file no encontrado: {job_path}"})
        sys.exit(1)

    try:
        with open(job_path, "r", encoding="utf-8") as f:
            job = json.load(f)
    except Exception as e:
        emit({"type": "error", "msg": f"Error leyendo job.json: {e}"})
        sys.exit(1)

    _job_id_str = job.get("job_id", "unknown")
    process_data = job.get("process_data", {})
    openai_api_key = job.get("openai_api_key", "")
    _output_dir_path = Path(job.get("output_dir", f"/tmp/secop_{_job_id_str}"))
    options = job.get("options", {})
    scraped_doc_urls = job.get("scraped_doc_urls", [])  # URLs pre-extraídas por Playwright

    _output_dir_path.mkdir(parents=True, exist_ok=True)
    
    # ── Log de emergencia en archivo físico (DESHABILITADO para optimizar) ──
    # debug_log = _output_dir_path / "debug.log"
    # with open(debug_log, "a", encoding="utf-8") as df:
    #     df.write(f"--- START JOB {_job_id_str} at {datetime.now()} ---\n")
    
    def log_debug(msg):
        # try:
        #     with open(debug_log, "a", encoding="utf-8") as df:
        #         df.write(f"[{datetime.now()}] {msg}\n")
        # except: pass
        pass

    progress("init", 1, "Job cargado, configurando entorno...")
    log_debug("Entorno configurado, iniciando imports...")

    docs_dir = _output_dir_path / "docs"
    exports_dir = _output_dir_path / "exports"
    docs_dir.mkdir(exist_ok=True)
    exports_dir.mkdir(exist_ok=True)

    logger.info(f"=== Iniciando análisis job_id={_job_id_str} ===")
    progress("init", 2, "Directorios creados. Cargando módulos...")

    # ── Importar módulos del motor ────────────────────────────────────────────
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        
        progress("init", 3, "Cargando: downloader...")
        log_debug("Importando downloader...")
        from downloader import download_process_documents
        
        progress("init", 4, "Cargando: parser...")
        log_debug("Importando parser...")
        from parser import parse_document, merge_document_texts, extract_tables_summary
        
        progress("init", 5, "Cargando: ocr...")
        log_debug("Importando ocr...")
        from ocr_processor import needs_ocr, apply_ocr_selective
        
        progress("init", 6, "Cargando: legal...")
        log_debug("Importando legal...")
        from legal_analyzer import analyze_legal, extract_dates_from_text, merge_cronograma
        
        progress("init", 7, "Cargando: financial...")
        log_debug("Importando financial...")
        from financial_analyzer import analyze_financial
        
        progress("init", 8, "Cargando: product...")
        log_debug("Importando product...")
        from product_extractor import extract_products
        
        progress("init", 9, "Cargando: risks...")
        log_debug("Importando risks...")
        from risk_analyzer import analyze_risks
        
        progress("init", 10, "Cargando: exporters...")
        log_debug("Importando exporters...")
        from exporters import export_all
        
        progress("init", 11, "Módulos cargados correctamente.")
        log_debug("Todos los módulos importados.")
    except ImportError as e:
        emit({"type": "error", "msg": f"Error importando módulos: {e}\n{traceback.format_exc()}"})
        sys.exit(1)

    # ── Crear cliente OpenAI compartido ──────────────────────────────────────
    progress("init", 12, "Inicializando cliente IA...")
    openai_client = None
    if openai_api_key:
        try:
            from openai import OpenAI
            openai_client = OpenAI(api_key=openai_api_key)
            logger.info("Cliente OpenAI inicializado")
        except Exception as e:
            logger.warning(f"No se pudo inicializar OpenAI: {e}")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 1: DESCARGA DE DOCUMENTOS
    # ─────────────────────────────────────────────────────────────────────────
    progress("download", 5, "Buscando y descargando documentos del proceso...")

    # ── Heartbeat: emite progreso cada 3 s mientras el downloader bloquea ──
    _hb_stop   = threading.Event()
    _hb_pct    = [6]          # lista para permitir mutación desde el closure
    _hb_msgs   = [
        "Consultando API de contratación pública...",
        "Buscando documentos del proceso en datos.gov.co...",
        "Descargando pliego de condiciones...",
        "Recuperando documentos adjuntos...",
        "Obteniendo documentos del proceso...",
        "Conectando con SECOP II...",
    ]

    def _heartbeat_worker():
        idx = 0
        while not _hb_stop.wait(timeout=3):
            _hb_pct[0] = min(_hb_pct[0] + 2, 33)
            progress("download", _hb_pct[0], _hb_msgs[idx % len(_hb_msgs)])
            idx += 1

    _hb_thread = threading.Thread(target=_heartbeat_worker, daemon=True)
    _hb_thread.start()

    downloaded_docs = []
    try:
        def dl_progress(pct, msg):
            # El downloader ya reporta: actualizar heartbeat pct base y emitir
            _hb_pct[0] = max(_hb_pct[0], 5 + int(pct * 0.28))
            progress("download", _hb_pct[0], msg)

        downloaded_docs = download_process_documents(
            process_data=process_data,
            output_dir=docs_dir,
            progress_cb=dl_progress,
            pre_scraped_urls=scraped_doc_urls,
        )
        logger.info(f"Documentos descargados: {len(downloaded_docs)}")
    except Exception as e:
        logger.error(f"Error en descarga: {e}")
        # Continuar sin documentos (puede haber datos del proceso)
    finally:
        _hb_stop.set()        # Detener heartbeat pase lo que pase
        _hb_thread.join(timeout=1)

    if not downloaded_docs:
        progress("download", 35, "No se descargaron documentos. Analizando datos del proceso...")
    else:
        progress("download", 35, f"{len(downloaded_docs)} documento(s) descargado(s)")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 2: PARSING DE DOCUMENTOS
    # ─────────────────────────────────────────────────────────────────────────
    progress("parse", 36, "Extrayendo texto de documentos...")

    parsed_docs = []
    for i, doc_meta in enumerate(downloaded_docs):
        file_path = doc_meta.get("path", "")
        if not file_path or not Path(file_path).exists():
            continue
        try:
            pct = 36 + int((i / max(len(downloaded_docs), 1)) * 12)
            progress("parse", pct, f"Parseando: {doc_meta.get('filename', '?')}")

            parsed = parse_document(file_path)
            parsed["filename"] = doc_meta.get("filename", Path(file_path).name)
            parsed["doc_type"] = doc_meta.get("doc_type", "")
            parsed["source"] = doc_meta.get("source", "")
            parsed_docs.append(parsed)

            logger.info(f"Parseado: {parsed['filename']} — {len(parsed.get('text',''))} chars, escaneado={parsed.get('is_scanned')}")
        except Exception as e:
            logger.error(f"Error parseando {file_path}: {e}")

    progress("parse", 48, f"{len(parsed_docs)} documento(s) procesado(s)")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 3: OCR (si hay documentos escaneados)
    # ─────────────────────────────────────────────────────────────────────────
    skip_ocr = options.get("skip_ocr", False)
    docs_needing_ocr = [d for d in parsed_docs if needs_ocr(d)] if not skip_ocr else []

    if docs_needing_ocr:
        progress("ocr", 49, f"Aplicando OCR a {len(docs_needing_ocr)} documento(s) escaneado(s)...")
        for i, doc in enumerate(docs_needing_ocr):
            pct = 49 + int((i / max(len(docs_needing_ocr), 1)) * 8)
            progress("ocr", pct, f"OCR: {doc.get('filename', '?')}")
            try:
                file_path = next(
                    (d["path"] for d in downloaded_docs if d.get("filename") == doc.get("filename")),
                    None
                )
                if file_path:
                    ocr_result = apply_ocr_selective(file_path, doc)
                    # Reemplazar en parsed_docs
                    idx = parsed_docs.index(doc)
                    parsed_docs[idx] = ocr_result
            except Exception as e:
                logger.error(f"OCR error en {doc.get('filename')}: {e}")
    else:
        if not skip_ocr:
            logger.info("No se detectaron documentos escaneados")
        progress("ocr", 57, "Procesamiento de texto completo")

    progress("ocr", 57, "Texto extraído. Iniciando análisis con IA...")

    # ─────────────────────────────────────────────────────────────────────────
    # PREPARAR TEXTO COMBINADO
    # ─────────────────────────────────────────────────────────────────────────
    combined_text = merge_document_texts(parsed_docs)
    all_tables = extract_tables_summary(parsed_docs)

    # Si no hay texto de documentos, usar datos del proceso SECOP
    if len(combined_text.strip()) < 100:
        logger.warning("Poco texto extraído de documentos, usando datos del proceso SECOP")
        combined_text = _build_text_from_process_data(process_data)

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 4: ANÁLISIS JURÍDICO
    # ─────────────────────────────────────────────────────────────────────────
    progress("legal", 58, "Analizando requisitos jurídicos y cronograma...")

    legal_result = {}
    try:
        legal_result = analyze_legal(combined_text, openai_client=openai_client)
        # Complementar cronograma con regex
        regex_dates = extract_dates_from_text(combined_text)
        legal_result["cronograma"] = merge_cronograma(
            legal_result.get("cronograma", []), regex_dates
        )
        logger.info(f"Análisis jurídico OK. Cronograma: {len(legal_result.get('cronograma',[]))} eventos")
    except Exception as e:
        logger.error(f"Error análisis jurídico: {e}")
        legal_result = {"_error": str(e)}

    progress("legal", 68, "Análisis jurídico completado")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 5: ANÁLISIS FINANCIERO
    # ─────────────────────────────────────────────────────────────────────────
    progress("financial", 69, "Extrayendo requisitos financieros...")

    financial_result = {}
    try:
        financial_result = analyze_financial(combined_text, openai_client=openai_client)
        logger.info("Análisis financiero OK")
    except Exception as e:
        logger.error(f"Error análisis financiero: {e}")
        financial_result = {"_error": str(e)}

    progress("financial", 75, "Análisis financiero completado")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 6: EXTRACCIÓN DE PRODUCTOS
    # ─────────────────────────────────────────────────────────────────────────
    skip_products = options.get("skip_products", False)
    products_result = {}

    if not skip_products:
        progress("products", 76, "Extrayendo productos y especificaciones técnicas...")
        try:
            products_result = extract_products(
                combined_text,
                tables=all_tables,
                openai_client=openai_client,
            )
            logger.info(f"Productos: {len(products_result.get('items',[]))} ítems")
        except Exception as e:
            logger.error(f"Error extracción productos: {e}")
            products_result = {"_error": str(e)}
        progress("products", 82, "Extracción de productos completada")
    else:
        progress("products", 82, "Extracción de productos omitida")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 7: ANÁLISIS DE RIESGOS
    # ─────────────────────────────────────────────────────────────────────────
    skip_risks = options.get("skip_risks", False)
    risk_result = {}

    if not skip_risks:
        progress("risks", 83, "Detectando riesgos y factores de direccionamiento...")
        try:
            risk_result = analyze_risks(
                combined_text,
                legal_analysis=legal_result,
                financial_analysis=financial_result,
                openai_client=openai_client,
            )
            logger.info(f"Riesgos: nivel={risk_result.get('nivel_riesgo_global')}, score={risk_result.get('score_riesgo')}")
        except Exception as e:
            logger.error(f"Error análisis riesgos: {e}")
            risk_result = {"_error": str(e)}
        progress("risks", 90, "Análisis de riesgos completado")
    else:
        progress("risks", 90, "Análisis de riesgos omitido")

    # ─────────────────────────────────────────────────────────────────────────
    # FASE 8: EXPORTACIÓN
    # ─────────────────────────────────────────────────────────────────────────
    progress("export", 91, "Generando reportes y exportaciones...")

    # Construir análisis completo
    process_info = {
        "job_id": _job_id_str,
        "referencia": (
            process_data.get("_referencia") or
            process_data.get("referencia_del_proceso") or
            process_data.get("numero_del_proceso") or "N/A"
        ),
        "entidad": (
            process_data.get("_entidad") or
            process_data.get("nombre_entidad") or
            process_data.get("entidad_compradora") or "N/A"
        ),
        "fecha_analisis": datetime.now().isoformat(),
        "documentos_descargados": len(downloaded_docs),
        "documentos_parseados": len(parsed_docs),
        "texto_extraido_chars": len(combined_text),
        "tablas_encontradas": len(all_tables),
    }

    full_analysis = {
        "process_info": process_info,
        "documents": [
            {
                "filename": d.get("filename"),
                "doc_type": d.get("doc_type"),
                "source": d.get("source"),
                "size_kb": d.get("size_kb"),
                "page_count": next(
                    (p.get("page_count") for p in parsed_docs if p.get("filename") == d.get("filename")), 0
                ),
                "is_scanned": next(
                    (p.get("is_scanned") for p in parsed_docs if p.get("filename") == d.get("filename")), False
                ),
            }
            for d in downloaded_docs
        ],
        "legal": legal_result,
        "financial": financial_result,
        "products": products_result,
        "risks": risk_result,
    }

    exported_files = {}
    try:
        exported_files = export_all(full_analysis, exports_dir)
        logger.info(f"Exportaciones: {list(exported_files.keys())}")
    except Exception as e:
        logger.error(f"Error en exportación: {e}")

    progress("export", 98, f"Reportes generados: {len(exported_files)} archivo(s)")

    # ─────────────────────────────────────────────────────────────────────────
    # RESULTADO FINAL
    # ─────────────────────────────────────────────────────────────────────────
    progress("complete", 100, "¡Análisis completado!")

    emit({
        "type": "result",
        "data": {
            **full_analysis,
            "exports": exported_files,
            "output_dir": str(_output_dir_path),
        }
    })

    logger.info(f"=== Análisis job_id={_job_id_str} COMPLETO ===")


def _build_text_from_process_data(process_data: dict) -> str:
    """
    Construye texto analizable desde los campos del proceso SECOP
    cuando no se pudo descargar ningún documento.
    """
    fields = [
        ("Objeto del Proceso", process_data.get("_objeto") or process_data.get("descripcion_del_proceso") or ""),
        ("Entidad", process_data.get("_entidad") or process_data.get("nombre_entidad") or ""),
        ("Modalidad", process_data.get("_modalidad") or process_data.get("modalidad_de_contratacion") or ""),
        ("Departamento", process_data.get("_departamento") or process_data.get("departamento") or ""),
        ("Municipio", process_data.get("_municipio") or process_data.get("municipio") or ""),
        ("Valor presupuesto oficial", process_data.get("_valor") or process_data.get("precio_base") or ""),
        ("Fecha de cierre", process_data.get("_fechaCierre") or process_data.get("fecha_de_cierre_del_proceso") or ""),
        ("Fecha de apertura", process_data.get("_fechaPublicacion") or process_data.get("fecha_de_publicacion_del") or ""),
        ("Estado", process_data.get("_estado") or process_data.get("estado_del_proceso") or ""),
    ]

    lines = ["DATOS DEL PROCESO SECOP II", "=" * 40]
    for label, value in fields:
        if value:
            lines.append(f"{label}: {value}")

    return "\n".join(lines)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit({"type": "error", "msg": "Proceso interrumpido"})
        sys.exit(1)
    except Exception as e:
        emit({"type": "error", "msg": f"Error crítico: {e}\n{traceback.format_exc()}"})
        sys.exit(1)
