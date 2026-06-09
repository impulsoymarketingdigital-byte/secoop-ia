#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
ocr_processor.py — Aplica OCR a PDFs escaneados

Detecta páginas escaneadas (< CHAR_THRESHOLD caracteres de texto nativo)
y aplica pytesseract con idioma español. Pre-procesa imagen con PIL
para mejorar calidad de reconocimiento.
"""
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

CHAR_THRESHOLD = 50        # caracteres mínimos por página para no ser "escaneada"
MIN_PAGE_OCR_CHARS = 10    # si después del OCR hay menos, marcar como vacía
DPI = 200                  # resolución para renderizar página a imagen
TESSERACT_LANG = "spa"     # idioma: español


def _is_tesseract_available():
    """Verifica si el binario de Tesseract está instalado y en el PATH."""
    import shutil
    return shutil.which("tesseract") is not None


def needs_ocr(parsed_doc: dict) -> bool:
    """Determina si un documento requiere OCR basándose en el parseo previo."""
    if not _is_tesseract_available():
        logger.warning("Tesseract no encontrado en el sistema. OCR deshabilitado.")
        return False
    if parsed_doc.get("is_scanned"):
        return True
    pages = parsed_doc.get("pages", [])
    if not pages:
        return True
    # Si la mayoría de páginas tienen poco texto → escaneado
    scanned_pages = sum(1 for p in pages if p.get("char_count", 0) < CHAR_THRESHOLD)
    return scanned_pages > len(pages) * 0.5


def apply_ocr(file_path: str | Path, progress_cb=None) -> dict:
    """
    Aplica OCR a un PDF. Retorna estructura compatible con parser.parse_document().

    Returns:
        {
            "text": str,
            "pages": [{"page": int, "text": str, "char_count": int}],
            "tables": [],
            "is_scanned": True,
            "page_count": int,
            "file_type": ".pdf",
            "ocr_applied": True,
            "error": str | None,
        }
    """
    path = Path(file_path)
    result = {
        "text": "",
        "pages": [],
        "tables": [],
        "is_scanned": True,
        "page_count": 0,
        "file_type": path.suffix.lower(),
        "ocr_applied": True,
        "error": None,
    }

    try:
        import fitz  # PyMuPDF
        from PIL import Image
        import pytesseract
        import io
    except ImportError as e:
        result["error"] = f"Dependencia OCR no disponible: {e}"
        logger.error(result["error"])
        return result

    try:
        doc = fitz.open(str(path))
        total_pages = len(doc)
        result["page_count"] = total_pages

        pages_data = []
        all_text_parts = []

        for page_num in range(total_pages):
            if progress_cb:
                pct = int((page_num / max(total_pages, 1)) * 100)
                progress_cb(pct, f"OCR página {page_num+1}/{total_pages}...")

            try:
                page = doc[page_num]

                # Renderizar página a imagen
                mat = fitz.Matrix(DPI / 72, DPI / 72)  # escala desde 72dpi base
                pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)
                img_bytes = pix.tobytes("png")

                # Convertir a imagen PIL y pre-procesar
                img = Image.open(io.BytesIO(img_bytes))
                img = _preprocess_image(img)

                # Aplicar OCR
                ocr_config = "--oem 3 --psm 3"
                text = pytesseract.image_to_string(
                    img,
                    lang=TESSERACT_LANG,
                    config=ocr_config,
                )
                text = _clean_ocr_text(text)
                char_count = len(text.strip())

                pages_data.append({
                    "page": page_num + 1,
                    "text": text,
                    "char_count": char_count,
                })
                if char_count >= MIN_PAGE_OCR_CHARS:
                    all_text_parts.append(f"[Página {page_num+1}]\n{text}")

            except Exception as e:
                logger.warning(f"OCR error en pág {page_num+1}: {e}")
                pages_data.append({
                    "page": page_num + 1,
                    "text": "",
                    "char_count": 0,
                })

        doc.close()
        result["pages"] = pages_data
        result["text"] = "\n\n".join(all_text_parts)

    except Exception as e:
        logger.exception(f"OCR falla crítica en {path.name}: {e}")
        result["error"] = str(e)

    return result


def apply_ocr_selective(file_path: str | Path, parsed_doc: dict, progress_cb=None) -> dict:
    """
    Aplica OCR solo a páginas escaneadas (char_count < threshold).
    Combina texto nativo con texto OCR para máxima cobertura.
    """
    path = Path(file_path)
    pages = parsed_doc.get("pages", [])
    scanned_pages = [p["page"] - 1 for p in pages if p.get("char_count", 0) < CHAR_THRESHOLD]

    if not scanned_pages:
        return parsed_doc  # nada que OCR-izar

    try:
        import fitz
        from PIL import Image
        import pytesseract
        import io

        doc = fitz.open(str(path))
        updated_pages = list(pages)  # copia

        for i, page_idx in enumerate(scanned_pages):
            if progress_cb:
                pct = int((i / max(len(scanned_pages), 1)) * 100)
                progress_cb(pct, f"OCR selectivo pág {page_idx+1}...")

            try:
                page = doc[page_idx]
                mat = fitz.Matrix(DPI / 72, DPI / 72)
                pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)
                img = Image.open(io.BytesIO(pix.tobytes("png")))
                img = _preprocess_image(img)

                text = pytesseract.image_to_string(img, lang=TESSERACT_LANG, config="--oem 3 --psm 3")
                text = _clean_ocr_text(text)

                if page_idx < len(updated_pages):
                    updated_pages[page_idx]["text"] = text
                    updated_pages[page_idx]["char_count"] = len(text.strip())

            except Exception as e:
                logger.warning(f"OCR selectivo error pág {page_idx+1}: {e}")

        doc.close()

        # Reconstruir texto completo
        all_parts = []
        for p in updated_pages:
            if p.get("text", "").strip():
                all_parts.append(f"[Página {p['page']}]\n{p['text']}")

        result = dict(parsed_doc)
        result["pages"] = updated_pages
        result["text"] = "\n\n".join(all_parts)
        result["ocr_applied"] = True
        return result

    except ImportError as e:
        logger.error(f"Dependencia OCR no disponible: {e}")
        return parsed_doc
    except Exception as e:
        logger.exception(f"OCR selectivo falla: {e}")
        return parsed_doc


def _preprocess_image(img):
    """
    Pre-procesa imagen para mejorar calidad OCR:
    - Convierte a escala de grises (ya en GRAY)
    - Umbral adaptativo (binarización)
    - Elimina ruido con filtro mediana
    """
    try:
        from PIL import ImageFilter, ImageEnhance

        # Aumentar contraste
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(1.5)

        # Nitidez
        img = img.filter(ImageFilter.SHARPEN)

        # Binarización simple con umbral
        img = img.point(lambda x: 255 if x > 140 else 0, '1').convert('L')

    except Exception as e:
        logger.debug(f"Pre-proceso imagen error (no crítico): {e}")

    return img


def _clean_ocr_text(text: str) -> str:
    """Limpia artefactos comunes del OCR en español."""
    if not text:
        return ""
    # Eliminar líneas con < 2 caracteres alfanuméricos
    lines = []
    for line in text.split('\n'):
        stripped = line.strip()
        alpha_count = sum(1 for c in stripped if c.isalnum())
        if alpha_count >= 2:
            lines.append(stripped)
    text = '\n'.join(lines)

    # Normalizar espacios múltiples
    text = re.sub(r' {2,}', ' ', text)
    # Eliminar líneas de solo guiones/asteriscos (separadores)
    text = re.sub(r'^[-_=*#]{3,}$', '', text, flags=re.MULTILINE)
    # Normalizar saltos múltiples
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()
