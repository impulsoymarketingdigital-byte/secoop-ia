#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
product_extractor.py — Extrae artículos, cantidades, valores y especificaciones

Estrategia:
  1. Extracción directa de tablas (Excel/Word/PDF) sin IA → máxima precisión
  2. Regex sobre texto para cantidades sueltas
  3. GPT-4o-mini con texto COMPLETO + tablas estructuradas como JSON
  4. Merge y deduplicación de fuentes
"""
import json
import logging
import re
import time

logger = logging.getLogger(__name__)

MODEL      = "gpt-4o-mini"
MAX_TOKENS = 4096
TEMP       = 0.05
MAX_TEXT   = 80_000   # chars al LLM (sin filtrar)


SYSTEM_PROMPT = (
    "Eres un experto en análisis de licitaciones y pliegos de contratación pública colombiana. "
    "Tu única tarea es extraer con MÁXIMA PRECISIÓN los ítems, artículos, cantidades, unidades "
    "de medida, valores unitarios y totales. "
    "NUNCA inventes datos. Si no encuentras un campo, déjalo vacío (\"\"). "
    "Responde SOLO con JSON válido, sin markdown."
)

PROMPT_TEMPLATE = """Analiza los documentos SECOP II adjuntos y extrae TODOS los artículos/ítems solicitados.

TABLAS ENCONTRADAS EN LOS DOCUMENTOS (datos estructurados — PRIORIZA ESTO):
{tables_json}

TEXTO COMPLETO DE LOS DOCUMENTOS:
{texto}

Responde EXCLUSIVAMENTE con este JSON (sin markdown, sin comentarios):
{{
  "tipo_bien_servicio": "bien|servicio|obra|consultoria|mixto",
  "descripcion_general": "descripción general de lo que se contrata",
  "items": [
    {{
      "item": 1,
      "descripcion": "descripción completa del artículo o servicio",
      "cantidad": 0,
      "unidad": "unidad de medida (und, m2, kg, litros, horas, etc.)",
      "valor_unitario": "valor unitario en pesos colombianos o vacío si no se especifica",
      "valor_total": "valor total del ítem o vacío",
      "marca": "marca exigida o requerida, o vacío",
      "modelo": "modelo o referencia específica, o vacío",
      "especificaciones": "especificaciones técnicas relevantes del ítem",
      "codigo_unspsc": "",
      "normas": "normas técnicas aplicables (NTC, ISO, etc.)"
    }}
  ],
  "valor_total_presupuesto": "valor total del presupuesto oficial",
  "condiciones_entrega": {{
    "lugar": "",
    "plazo": "",
    "empaque": ""
  }},
  "garantia": {{
    "meses": 0,
    "descripcion": ""
  }},
  "especificaciones_generales": ["especificación técnica general aplicable a todos los ítems"],
  "observaciones": "observaciones técnicas importantes"
}}

INSTRUCCIONES CRÍTICAS:
- Extrae TODOS los ítems que aparezcan en las tablas o en el texto.
- Para 'cantidad': usa el número exacto del documento. Si no hay, pon 0.
- Para 'valor_unitario' y 'valor_total': incluye los valores en pesos si aparecen.
- Para 'marca': copia exactamente la marca/referencia exigida si la hay.
- Si es un servicio sin ítems físicos, describe el servicio en items[0] con cantidad=1.
- NO omitas ítems aunque parezcan repetidos o incompletos.
"""


def extract_products(text: str, tables: list = None, openai_client=None) -> dict:
    """
    Extrae productos/servicios/artículos del pliego.

    Proceso:
      1. Extracción directa de tablas estructuradas
      2. Regex para cantidades en texto
      3. LLM con contexto completo (texto + tablas)
      4. Merge de resultados
    """
    tables = tables or []
    client = openai_client or _get_client()

    # ── Paso 1: extracción directa de tablas ────────────────────────────
    table_items = _extract_from_tables(tables)
    logger.info(f"Extracción directa tablas: {len(table_items)} ítems")

    # ── Paso 2: regex de cantidades en texto ────────────────────────────
    regex_items = _regex_quantities(text)
    logger.info(f"Regex cantidades: {len(regex_items)} coincidencias")

    # ── Paso 3: LLM ─────────────────────────────────────────────────────
    llm_result = {}
    if client and text and len(text.strip()) >= 30:
        llm_result = _llm_extract(text, tables, client)
    elif table_items:
        llm_result = _build_from_tables(table_items)

    if not llm_result:
        llm_result = _empty_result()

    # ── Paso 4: enriquecer con datos de tablas ──────────────────────────
    if table_items:
        llm_result = _enrich_with_tables(llm_result, table_items)

    # ── Paso 5: enriquecer con regex si items siguen vacíos ─────────────
    if not llm_result.get("items") and regex_items:
        llm_result["items"] = _regex_to_items(regex_items)

    logger.info(f"Extracción productos final: {len(llm_result.get('items', []))} ítems")
    return llm_result


# ─────────────────────────────────────────────────────────────────────────────
# Extracción directa de tablas
# ─────────────────────────────────────────────────────────────────────────────

# Palabras clave para detectar columnas relevantes
_DESC_KW   = {"descripcion", "descripción", "item", "ítem", "articulo", "artículo",
               "bien", "producto", "servicio", "objeto", "detalle", "concepto",
               "nombre", "material", "elemento", "denominacion", "denominación"}
_QTY_KW    = {"cantidad", "cant", "qty", "num", "número", "no.", "unidades", "total_und"}
_UNIT_KW   = {"unidad", "und", "u/m", "medida", "u.m.", "um"}
_PRICE_KW  = {"valor", "precio", "vr", "vr.", "costo", "unitario", "unit", "price"}
_TOTAL_KW  = {"total", "subtotal", "importe", "valor_total", "precio_total"}
_BRAND_KW  = {"marca", "brand", "fabricante", "referencia", "ref", "modelo"}
_SPEC_KW   = {"especificacion", "especificación", "descripcion_tecnica", "caracteristica",
               "carácterística", "observacion", "nota"}


def _col_match(header: str, keywords: set) -> bool:
    h = header.lower().strip().replace(".", "").replace(" ", "_")
    return any(kw in h for kw in keywords)


def _extract_from_tables(tables: list) -> list:
    """
    Extrae ítems con cantidad/valor directamente de las tablas.
    Intenta múltiples estrategias para encontrar columnas relevantes.
    """
    all_items = []

    for table in tables:
        headers = [str(h or "").strip() for h in table.get("headers", [])]
        data    = table.get("data", [])
        source  = table.get("source", "")

        if not headers or not data:
            continue

        # Detectar columnas
        desc_col  = _find_col(headers, _DESC_KW)
        qty_col   = _find_col(headers, _QTY_KW)
        unit_col  = _find_col(headers, _UNIT_KW)
        price_col = _find_col(headers, _PRICE_KW)
        total_col = _find_col(headers, _TOTAL_KW)
        brand_col = _find_col(headers, _BRAND_KW)
        spec_col  = _find_col(headers, _SPEC_KW)

        # Si no hay columna de descripción, intentar la primera columna larga
        if desc_col is None:
            for ci, h in enumerate(headers):
                if not h or len(h) < 2:
                    continue
                # Si la primera celda de datos es texto largo, probablemente es descripción
                first_vals = [str(data[ri][ci]).strip() for ri in range(min(3, len(data)))
                              if ci < len(data[ri])]
                if any(len(v) > 5 for v in first_vals):
                    desc_col = ci
                    break

        if desc_col is None:
            # Tabla sin columna de descripción identificable — guardar como texto crudo
            _append_raw_table(all_items, headers, data, source)
            continue

        item_num = len(all_items) + 1
        for row in data:
            if len(row) <= desc_col:
                continue

            desc = str(row[desc_col] or "").strip()
            if not desc or len(desc) < 2:
                continue
            # Omitir filas de totales/subtotales
            if re.match(r"^(total|subtotal|iva|impuesto|gran\s*total)", desc, re.I):
                continue

            def get_col(col_idx):
                if col_idx is not None and col_idx < len(row):
                    return str(row[col_idx] or "").strip()
                return ""

            qty_raw   = get_col(qty_col)
            price_raw = get_col(price_col)
            total_raw = get_col(total_col)

            all_items.append({
                "item":          item_num,
                "descripcion":   desc,
                "cantidad":      _parse_number(qty_raw),
                "unidad":        get_col(unit_col),
                "valor_unitario": _clean_currency(price_raw),
                "valor_total":   _clean_currency(total_raw),
                "marca":         get_col(brand_col),
                "especificaciones": get_col(spec_col),
                "_fuente":       source,
            })
            item_num += 1

    return all_items


def _find_col(headers: list, keywords: set) -> int | None:
    for i, h in enumerate(headers):
        if _col_match(h, keywords):
            return i
    return None


def _append_raw_table(items: list, headers: list, data: list, source: str):
    """Para tablas sin columna de descripción clara, agrega filas completas."""
    for ri, row in enumerate(data[:50]):
        parts = []
        for ci, cell in enumerate(row):
            val = str(cell or "").strip()
            if val and val.lower() not in ("none", "nan", ""):
                hdr = headers[ci] if ci < len(headers) else f"col{ci}"
                parts.append(f"{hdr}:{val}")
        if parts:
            items.append({
                "item": len(items) + 1,
                "descripcion": " | ".join(parts),
                "cantidad": 0, "unidad": "",
                "valor_unitario": "", "valor_total": "",
                "marca": "", "especificaciones": "",
                "_fuente": source,
            })


def _parse_number(val: str) -> float:
    """Convierte string a número (maneja formatos colombianos: 1.000,50)."""
    if not val:
        return 0
    # Eliminar símbolos de moneda y espacios
    clean = re.sub(r'[$ \xa0]', '', str(val))
    # Formato colombiano: 1.234.567,89
    if re.match(r'^\d{1,3}(\.\d{3})+(,\d+)?$', clean):
        clean = clean.replace('.', '').replace(',', '.')
    else:
        clean = clean.replace(',', '.')
    try:
        return float(clean)
    except (ValueError, TypeError):
        return 0


def _clean_currency(val: str) -> str:
    """Limpia valores monetarios para presentación."""
    if not val or val.strip().lower() in ("", "0", "nan", "none"):
        return ""
    return val.strip()


def _regex_quantities(text: str) -> list:
    """Extrae cantidades con unidades del texto usando regex."""
    items = []
    pattern = re.compile(
        r'(\d+(?:[.,]\d+)?)\s*'
        r'(unidades?|und\.?|m²|m2|ml|metros?\s*(?:lineales?|cuadrados?|cúbicos?)?|'
        r'kg|kgs|kilogramos?|litros?|lts?|galones?|gl|resmas?|cajas?|paquetes?|'
        r'juegos?|conjuntos?|horas?|días?|meses?|años?|servicios?|equipos?|'
        r'sillas?|puestos?|pares?|rollos?|bultos?|sacos?|frascos?)',
        re.IGNORECASE,
    )
    seen = set()
    for m in pattern.finditer(text):
        ctx_start = max(0, m.start() - 80)
        ctx_end   = min(len(text), m.end() + 80)
        ctx = text[ctx_start:ctx_end].strip()
        key = (m.group(1), m.group(2).lower()[:4])
        if key not in seen:
            seen.add(key)
            items.append({
                "cantidad_str": m.group(1),
                "unidad":       m.group(2).strip(),
                "contexto":     ctx,
            })
    return items[:40]


def _regex_to_items(regex_items: list) -> list:
    result = []
    for i, r in enumerate(regex_items, 1):
        desc = r.get("contexto", "")[:120]
        result.append({
            "item": i,
            "descripcion": desc,
            "cantidad": _parse_number(r.get("cantidad_str", "0")),
            "unidad": r.get("unidad", ""),
            "valor_unitario": "", "valor_total": "",
            "marca": "", "especificaciones": "",
        })
    return result


# ─────────────────────────────────────────────────────────────────────────────
# LLM
# ─────────────────────────────────────────────────────────────────────────────

def _llm_extract(text: str, tables: list, client) -> dict:
    """Llama al LLM con texto + tablas estructuradas."""

    # Serializar tablas como JSON compacto para el LLM
    tables_for_llm = []
    for t in tables[:20]:  # máx 20 tablas
        tables_for_llm.append({
            "fuente":     t.get("source", ""),
            "encabezados": [str(h) for h in t.get("headers", [])],
            "filas":      [[str(c) for c in row] for row in t.get("data", [])[:100]],
        })
    tables_json = json.dumps(tables_for_llm, ensure_ascii=False, indent=1)

    # No filtrar el texto — pasarlo completo (truncado al límite)
    text_truncated = text[:MAX_TEXT]

    prompt = PROMPT_TEMPLATE.format(
        tables_json=tables_json if tables_for_llm else "(no se encontraron tablas)",
        texto=text_truncated,
    )

    for attempt in range(3):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",   "content": prompt},
                ],
                max_tokens=MAX_TOKENS,
                temperature=TEMP,
            )
            raw = resp.choices[0].message.content or ""
            result = _parse_json(raw)
            if result:
                result["_tokens_used"] = getattr(resp.usage, "total_tokens", 0)
                result["_model"] = MODEL
                logger.info(f"LLM extracción OK: {len(result.get('items', []))} ítems, "
                            f"{result.get('_tokens_used', 0)} tokens")
                return result
        except Exception as e:
            logger.warning(f"LLM intento {attempt+1} falló: {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)

    logger.error("LLM no respondió después de 3 intentos")
    return {}


# ─────────────────────────────────────────────────────────────────────────────
# Merge y enriquecimiento
# ─────────────────────────────────────────────────────────────────────────────

def _enrich_with_tables(llm_result: dict, table_items: list) -> dict:
    """
    Enriquece los ítems del LLM con datos de las tablas.
    Si el LLM no encontró ítems, usar los de tabla directamente.
    """
    llm_items = llm_result.get("items", [])

    if not llm_items:
        # Construir desde tablas
        llm_result["items"] = [
            {
                "item":           t.get("item", i + 1),
                "descripcion":    t.get("descripcion", ""),
                "cantidad":       t.get("cantidad", 0),
                "unidad":         t.get("unidad", ""),
                "valor_unitario": t.get("valor_unitario", ""),
                "valor_total":    t.get("valor_total", ""),
                "marca":          t.get("marca", ""),
                "especificaciones": t.get("especificaciones", ""),
                "modelo": "", "codigo_unspsc": "", "normas": "",
            }
            for i, t in enumerate(table_items)
        ]
        return llm_result

    # Enriquecer ítems existentes del LLM con datos de tabla
    for t_item in table_items:
        best_match = None
        best_score = 0.0
        for llm_item in llm_items:
            score = _similarity(t_item.get("descripcion", ""), llm_item.get("descripcion", ""))
            if score > best_score:
                best_score = score
                best_match = llm_item

        if best_match and best_score > 0.4:
            # Completar campos vacíos del LLM con datos de tabla
            for field in ("cantidad", "unidad", "valor_unitario", "valor_total", "marca"):
                t_val = t_item.get(field)
                l_val = best_match.get(field)
                if t_val and (not l_val or l_val == 0 or l_val == ""):
                    best_match[field] = t_val
        else:
            # Ítem de tabla sin match en LLM → agregar
            llm_items.append({
                "item":           len(llm_items) + 1,
                "descripcion":    t_item.get("descripcion", ""),
                "cantidad":       t_item.get("cantidad", 0),
                "unidad":         t_item.get("unidad", ""),
                "valor_unitario": t_item.get("valor_unitario", ""),
                "valor_total":    t_item.get("valor_total", ""),
                "marca":          t_item.get("marca", ""),
                "especificaciones": t_item.get("especificaciones", ""),
                "modelo": "", "codigo_unspsc": "", "normas": "",
            })

    llm_result["items"] = llm_items
    return llm_result


def _build_from_tables(table_items: list) -> dict:
    result = _empty_result()
    result["items"] = [
        {
            "item":           t.get("item", i + 1),
            "descripcion":    t.get("descripcion", ""),
            "cantidad":       t.get("cantidad", 0),
            "unidad":         t.get("unidad", ""),
            "valor_unitario": t.get("valor_unitario", ""),
            "valor_total":    t.get("valor_total", ""),
            "marca":          t.get("marca", ""),
            "especificaciones": t.get("especificaciones", ""),
            "modelo": "", "codigo_unspsc": "", "normas": "",
        }
        for i, t in enumerate(table_items)
    ]
    return result


def _similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    wa = set(re.findall(r'\w+', a.lower()))
    wb = set(re.findall(r'\w+', b.lower()))
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / max(len(wa | wb), 1)


def _parse_json(raw: str) -> dict | None:
    raw = raw.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.IGNORECASE)
    raw = re.sub(r'\s*```$', '', raw)
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except Exception:
                pass
    logger.error(f"JSON inválido respuesta LLM: {raw[:300]}")
    return None


def _get_client():
    import os
    try:
        from openai import OpenAI
        key = os.environ.get("OPENAI_API_KEY", "")
        return OpenAI(api_key=key) if key else None
    except ImportError:
        return None


def _empty_result(error=None) -> dict:
    return {
        "tipo_bien_servicio": "",
        "descripcion_general": "",
        "items": [],
        "valor_total_presupuesto": "",
        "condiciones_entrega": {"lugar": "", "plazo": "", "empaque": ""},
        "garantia": {"meses": 0, "descripcion": ""},
        "especificaciones_generales": [],
        "observaciones": "",
        "_error": error,
        "_model": MODEL,
        "_tokens_used": 0,
    }
