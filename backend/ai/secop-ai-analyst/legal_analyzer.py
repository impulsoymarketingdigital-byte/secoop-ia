#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
legal_analyzer.py — Extrae requisitos jurídicos, cronograma y condiciones del pliego

Retorna un dict con:
  objeto_contrato, alcance, modalidad_seleccion, regimen_juridico,
  valor_estimado, duracion_contrato, lugar_ejecucion,
  justificacion_modalidad, cronograma, requisitos_habilitantes,
  criterios_calificacion, puntaje_total, garantias,
  experiencia_exigida, union_temporal_consorcio, observaciones_juridicas
"""
import json
import logging
import re
import time

logger = logging.getLogger(__name__)

MODEL      = "gpt-4o-mini"
MAX_TOKENS = 3000
TEMP       = 0.05
MAX_TEXT   = 80_000

SYSTEM_PROMPT = (
    "Eres un abogado experto en contratación pública colombiana (Ley 80/93, Ley 1150/07, "
    "Decreto 1082/15). Analizas pliegos de condiciones SECOP II con máxima precisión. "
    "Responde SOLO con JSON válido, sin markdown ni comentarios."
)

PROMPT_LEGAL = """Analiza el siguiente texto de un proceso de contratación SECOP II y extrae la información jurídica.

TEXTO DEL PROCESO:
{texto}

Responde EXCLUSIVAMENTE con este JSON (sin markdown):
{{
  "objeto_contrato": "descripción completa del objeto del contrato",
  "alcance": "alcance detallado de los servicios/bienes/obras",
  "modalidad_seleccion": "modalidad (Licitación, Selección Abreviada, Concurso de Méritos, Contratación Directa, Mínima Cuantía, Invitación Pública, etc.)",
  "justificacion_modalidad": "justificación legal de la modalidad seleccionada",
  "regimen_juridico": "régimen jurídico aplicable",
  "valor_estimado": "valor estimado del contrato en pesos colombianos",
  "duracion_contrato": "duración del contrato (ej: 3 meses, 1 año)",
  "lugar_ejecucion": "lugar o municipio de ejecución",
  "cronograma": [
    {{
      "evento": "nombre del evento (ej: Publicación pliego, Cierre propuestas, Adjudicación)",
      "fecha": "fecha en formato YYYY-MM-DD o texto si no hay fecha exacta",
      "observaciones": "observaciones adicionales",
      "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
    }}
  ],
  "requisitos_habilitantes": {{
    "juridicos": [
      {{
        "requisito": "nombre del requisito",
        "documento_exigido": "documento que lo acredita",
        "obligatorio": true,
        "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
      }}
    ],
    "financieros": [
      {{
        "indicador": "nombre del indicador financiero",
        "formula": "fórmula de cálculo",
        "valor_minimo": "valor mínimo requerido",
        "obligatorio": true,
        "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
      }}
    ],
    "tecnicos": [
      {{
        "requisito": "requisito técnico",
        "como_acreditar": "cómo se acredita",
        "obligatorio": true,
        "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
      }}
    ],
    "organizacionales": [
      {{
        "requisito": "requisito organizacional",
        "como_acreditar": "cómo se acredita",
        "obligatorio": true,
        "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
      }}
    ]
  }},
  "criterios_calificacion": [
    {{
      "criterio": "nombre del criterio de evaluación",
      "tipo": "técnico | económico | social",
      "puntaje_maximo": 0,
      "descripcion": "descripción del criterio",
      "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
    }}
  ],
  "puntaje_total": 100,
  "garantias": [
    {{
      "tipo": "seriedad de la oferta | cumplimiento | calidad | pago de salarios | responsabilidad civil",
      "porcentaje": "porcentaje o valor",
      "vigencia": "vigencia de la garantía",
      "observaciones": ""
    }}
  ],
  "experiencia_exigida": {{
    "años_minimos": 0,
    "tipo_experiencia": "tipo de experiencia requerida",
    "como_acreditar": "documentos para acreditar experiencia",
    "contratos_similares": "número o valor de contratos similares requeridos"
  }},
  "union_temporal_consorcio": {{
    "permitido": true,
    "condiciones": "condiciones para participar como consorcio/unión temporal",
    "porcentaje_minimo": "porcentaje mínimo de participación"
  }},
  "observaciones_juridicas": [
    "observación jurídica relevante"
  ]
}}

INSTRUCCIONES:
- Extrae TODOS los datos disponibles. Si no hay información para un campo, usa "" o [].
- Para 'valor_estimado': incluye el símbolo $ y los separadores de miles (ej: "$45.500.000").
- Para 'cronograma': incluye TODAS las fechas y eventos mencionados.
- Para 'requisitos_habilitantes': extrae TODOS los requisitos, incluyendo RUT, Cámara, RUP, etc.
- Para 'criterios_calificacion': suma de puntajes debe coincidir con 'puntaje_total'.
- CITACIÓN DE FUENTES: El texto contiene marcadores de la forma [DOC: nombre_archivo | PG: número]. Para cada elemento de las listas (cronograma, juridicos, financieros, tecnicos, organizacionales, criterios_calificacion), incluye el campo "fuente" con el nombre exacto del archivo ("documento") y el número de página ("pagina") del marcador más cercano al dato extraído.
"""


def analyze_legal(text: str, openai_client=None) -> dict:
    """
    Analiza el texto del pliego para extraer información jurídica.

    Args:
        text:           Texto combinado de los documentos del proceso
        openai_client:  Cliente OpenAI ya inicializado

    Returns:
        dict con toda la información jurídica del proceso
    """
    if not text or len(text.strip()) < 30:
        logger.warning("Texto insuficiente para análisis jurídico")
        return _empty_result()

    client = openai_client or _get_client()
    if not client:
        logger.error("Cliente OpenAI no disponible para análisis jurídico")
        return _empty_result(error="Cliente OpenAI no disponible")

    truncated = text[:MAX_TEXT]
    prompt = PROMPT_LEGAL.format(texto=truncated)

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
                tokens = getattr(resp.usage, "total_tokens", 0)
                logger.info(f"Análisis jurídico OK. Tokens: {tokens}")
                result["_tokens_used"] = tokens
                result["_model"] = MODEL
                return result

        except Exception as e:
            logger.warning(f"Intento {attempt + 1} análisis jurídico falló: {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)

    logger.error("Análisis jurídico falló después de 3 intentos")
    return _empty_result(error="OpenAI no respondió")


# ── Extracción de fechas con regex ─────────────────────────────────────────

# Patrones de fecha comunes en pliegos colombianos
_DATE_PATTERNS = [
    # DD/MM/YYYY o DD-MM-YYYY
    r'(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})',
    # YYYY-MM-DD
    r'(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})',
    # DD de MES de YYYY
    r'(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|'
    r'septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})',
]

_MONTHS = {
    'enero':1,'febrero':2,'marzo':3,'abril':4,'mayo':5,'junio':6,
    'julio':7,'agosto':8,'septiembre':9,'octubre':10,'noviembre':11,'diciembre':12,
}

_EVENT_KEYWORDS = [
    (r'publicaci[oó]n', 'Publicación del proceso'),
    (r'apertura', 'Apertura de propuestas'),
    (r'cierre', 'Cierre de propuestas'),
    (r'visita.*obra|recorrido', 'Visita de obra / recorrido'),
    (r'audiencia.*aclaraci', 'Audiencia de aclaración'),
    (r'respuesta.*observaci', 'Respuesta a observaciones'),
    (r'evaluaci[oó]n', 'Evaluación de propuestas'),
    (r'adjudicaci[oó]n', 'Adjudicación'),
    (r'suscripci[oó]n.*contrato|firma.*contrato', 'Suscripción del contrato'),
    (r'inicio.*actividades|inicio.*obra', 'Inicio de actividades'),
    (r'entrega|liquidaci[oó]n', 'Entrega / Liquidación'),
]


def extract_dates_from_text(text: str) -> list:
    """
    Extrae fechas y eventos del texto con regex.

    Returns:
        Lista de { evento, fecha, observaciones }
    """
    events = []
    seen_dates = set()
    lines = text.split('\n')

    for i, line in enumerate(lines):
        line_lower = line.lower()
        # Buscar fechas en la línea
        dates_found = _extract_dates_from_line(line)
        if not dates_found:
            continue

        # Intentar identificar el evento por contexto (líneas cercanas)
        context = ' '.join(lines[max(0, i-2):i+3]).lower()
        evento = 'Evento'
        for pattern, label in _EVENT_KEYWORDS:
            if re.search(pattern, context):
                evento = label
                break

        for date_str in dates_found:
            if date_str not in seen_dates:
                seen_dates.add(date_str)
                events.append({
                    'evento': evento,
                    'fecha': date_str,
                    'observaciones': line.strip()[:100],
                })

    return events


def _extract_dates_from_line(line: str) -> list:
    """Extrae todas las fechas de una línea de texto."""
    dates = []

    # DD/MM/YYYY o DD-MM-YYYY
    for m in re.finditer(r'\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})\b', line):
        try:
            d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 1 <= d <= 31 and 1 <= mo <= 12 and 2020 <= y <= 2030:
                dates.append(f"{y:04d}-{mo:02d}-{d:02d}")
        except ValueError:
            pass

    # YYYY-MM-DD
    for m in re.finditer(r'\b(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})\b', line):
        try:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if 1 <= d <= 31 and 1 <= mo <= 12 and 2020 <= y <= 2030:
                dates.append(f"{y:04d}-{mo:02d}-{d:02d}")
        except ValueError:
            pass

    # DD de MES de YYYY
    for m in re.finditer(
        r'\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|'
        r'septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b',
        line, re.IGNORECASE
    ):
        try:
            d  = int(m.group(1))
            mo = _MONTHS.get(m.group(2).lower(), 0)
            y  = int(m.group(3))
            if 1 <= d <= 31 and mo and 2020 <= y <= 2030:
                dates.append(f"{y:04d}-{mo:02d}-{d:02d}")
        except ValueError:
            pass

    return list(dict.fromkeys(dates))  # dedup preservando orden


def merge_cronograma(llm_cronograma: list, regex_dates: list) -> list:
    """
    Fusiona el cronograma del LLM con fechas extraídas por regex.
    El LLM tiene prioridad; las fechas de regex se agregan si no están ya.
    """
    result = list(llm_cronograma or [])
    existing_dates = {e.get('fecha', '') for e in result}

    for r in (regex_dates or []):
        fecha = r.get('fecha', '')
        if fecha and fecha not in existing_dates:
            result.append(r)
            existing_dates.add(fecha)

    # Ordenar por fecha
    def sort_key(e):
        f = e.get('fecha', '')
        if re.match(r'\d{4}-\d{2}-\d{2}', f):
            return f
        return 'Z'  # fechas sin formato van al final

    result.sort(key=sort_key)
    return result


# ── Helpers ────────────────────────────────────────────────────────────────

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
    logger.error(f"JSON inválido en análisis jurídico: {raw[:200]}")
    return None


def _get_client():
    import os
    try:
        from openai import OpenAI
        key = os.environ.get("OPENAI_API_KEY", "")
        return OpenAI(api_key=key) if key else None
    except ImportError:
        return None


def _empty_result(error: str = None) -> dict:
    return {
        "objeto_contrato":        "",
        "alcance":                "",
        "modalidad_seleccion":    "",
        "justificacion_modalidad":"",
        "regimen_juridico":       "",
        "valor_estimado":         "",
        "duracion_contrato":      "",
        "lugar_ejecucion":        "",
        "cronograma":             [],
        "requisitos_habilitantes": {
            "juridicos": [], "financieros": [], "tecnicos": [], "organizacionales": []
        },
        "criterios_calificacion": [],
        "puntaje_total":          0,
        "garantias":              [],
        "experiencia_exigida":    {
            "años_minimos": 0, "tipo_experiencia": "",
            "como_acreditar": "", "contratos_similares": ""
        },
        "union_temporal_consorcio": {
            "permitido": True, "condiciones": "", "porcentaje_minimo": ""
        },
        "observaciones_juridicas": [],
        "_error":       error,
        "_model":       MODEL,
        "_tokens_used": 0,
    }
