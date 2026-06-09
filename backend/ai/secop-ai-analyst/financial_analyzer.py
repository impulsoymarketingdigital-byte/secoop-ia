#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
financial_analyzer.py — Extrae requisitos financieros y capacidad económica

Retorna un dict con:
  indicadores_financieros, capital_trabajo, patrimonio_minimo,
  capacidad_residual, presupuesto_oficial, forma_pago, anticipo
"""
import json
import logging
import re
import time

logger = logging.getLogger(__name__)

MODEL      = "gpt-4o-mini"
MAX_TOKENS = 2000
TEMP       = 0.05
MAX_TEXT   = 60_000

SYSTEM_PROMPT = (
    "Eres un contador público y experto en finanzas de contratación pública colombiana. "
    "Extraes con exactitud los requisitos financieros de pliegos SECOP II. "
    "Responde SOLO con JSON válido, sin markdown ni comentarios."
)

PROMPT_FINANCIAL = """Analiza el siguiente texto de un proceso SECOP II y extrae los requisitos financieros.

TEXTO DEL PROCESO:
{texto}

Responde EXCLUSIVAMENTE con este JSON (sin markdown):
{{
  "indicadores_financieros": [
    {{
      "nombre": "nombre del indicador (ej: Índice de liquidez, Capital de trabajo, Nivel de endeudamiento)",
      "formula": "fórmula de cálculo (ej: Activo corriente / Pasivo corriente)",
      "valor_minimo": "valor mínimo requerido",
      "valor_requerido": "valor requerido o rango aceptable",
      "observaciones": "observaciones adicionales",
      "fuente": {{"documento": "nombre_del_archivo.pdf", "pagina": 1}}
    }}
  ],
  "capital_trabajo": {{
    "formula": "fórmula de cálculo",
    "valor_minimo": "valor mínimo en pesos",
    "descripcion": "descripción del requisito"
  }},
  "patrimonio_minimo": "valor mínimo de patrimonio requerido en pesos o vacío",
  "capacidad_residual": {{
    "requerida": "capacidad residual requerida",
    "formula": "cómo se calcula",
    "observaciones": ""
  }},
  "presupuesto_oficial": {{
    "valor": "valor del presupuesto oficial en pesos",
    "valor_numerico": 0,
    "incluye_iva": true,
    "fuente_financiacion": "fuente de financiación (recursos propios, SGP, regalías, etc.)"
  }},
  "forma_pago": "descripción de la forma de pago (mensual, por entregables, etc.)",
  "anticipo": {{
    "porcentaje": 0,
    "condiciones": "condiciones para el anticipo"
  }},
  "garantia_anticipo": "descripción de la garantía de anticipo si aplica",
  "multas_clausula_penal": {{
    "multas": "descripción de multas aplicables",
    "clausula_penal": "descripción de la cláusula penal"
  }},
  "observaciones_financieras": ["observaciones financieras relevantes"]
}}

INSTRUCCIONES:
- Extrae TODOS los indicadores financieros con sus fórmulas y valores mínimos.
- Para 'presupuesto_oficial.valor': usa el formato "$XX.XXX.XXX" con separador de miles.
- Para 'presupuesto_oficial.valor_numerico': usa el número sin puntos ni comas.
- Si no hay información para un campo, usa "" o 0 según corresponda.
- CITACIÓN DE FUENTES: El texto incluye marcadores [DOC: nombre_archivo | PG: N]. Para cada indicador en 'indicadores_financieros', incluye el campo "fuente" con el nombre exacto del archivo ("documento") y el número de página ("pagina") del marcador más cercano al dato extraído.
"""


def analyze_financial(text: str, openai_client=None) -> dict:
    """
    Analiza el texto del pliego para extraer información financiera.

    Args:
        text:           Texto combinado de los documentos del proceso
        openai_client:  Cliente OpenAI ya inicializado

    Returns:
        dict con requisitos financieros del proceso
    """
    if not text or len(text.strip()) < 30:
        logger.warning("Texto insuficiente para análisis financiero")
        return _empty_result()

    client = openai_client or _get_client()
    if not client:
        logger.error("Cliente OpenAI no disponible para análisis financiero")
        return _empty_result(error="Cliente OpenAI no disponible")

    # Priorizar secciones financieras del texto
    relevant = _extract_financial_sections(text)
    truncated = relevant[:MAX_TEXT]
    prompt = PROMPT_FINANCIAL.format(texto=truncated)

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
                logger.info(f"Análisis financiero OK. Tokens: {tokens}")
                result["_tokens_used"] = tokens
                result["_model"] = MODEL
                return result

        except Exception as e:
            logger.warning(f"Intento {attempt + 1} análisis financiero falló: {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)

    logger.error("Análisis financiero falló después de 3 intentos")
    return _empty_result(error="OpenAI no respondió")


def _extract_financial_sections(text: str) -> str:
    """Extrae y prioriza secciones financieras del texto."""
    keywords = [
        "capacidad financiera", "indicadores financieros", "índice de liquidez",
        "capital de trabajo", "patrimonio", "nivel de endeudamiento",
        "razón de endeudamiento", "rentabilidad", "presupuesto oficial",
        "valor estimado", "forma de pago", "anticipo", "garantía",
        "requisitos financieros", "capacidad económica", "recursos propios",
        "fuente de financiación", "renta líquida", "utilidad neta",
    ]

    lines = text.split('\n')
    relevant_lines = []
    context_window = 0

    for line in lines:
        line_lower = line.lower()
        is_relevant = any(kw in line_lower for kw in keywords)
        if is_relevant:
            context_window = 20
        if context_window > 0 or is_relevant:
            relevant_lines.append(line)
            context_window = max(0, context_window - 1)

    # Si hay suficiente contenido relevante, usarlo; si no, usar todo el texto
    result = '\n'.join(relevant_lines)
    return result if len(result) > 500 else text


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
    logger.error(f"JSON inválido en análisis financiero: {raw[:200]}")
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
        "indicadores_financieros": [],
        "capital_trabajo": {"formula": "", "valor_minimo": "", "descripcion": ""},
        "patrimonio_minimo": "",
        "capacidad_residual": {"requerida": "", "formula": "", "observaciones": ""},
        "presupuesto_oficial": {
            "valor": "", "valor_numerico": 0,
            "incluye_iva": True, "fuente_financiacion": ""
        },
        "forma_pago": "",
        "anticipo": {"porcentaje": 0, "condiciones": ""},
        "garantia_anticipo": "",
        "multas_clausula_penal": {"multas": "", "clausula_penal": ""},
        "observaciones_financieras": [],
        "_error":       error,
        "_model":       MODEL,
        "_tokens_used": 0,
    }
