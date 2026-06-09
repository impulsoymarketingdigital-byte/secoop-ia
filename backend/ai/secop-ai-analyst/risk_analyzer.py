#!/usr/bin/env python3
"""
JIREHAI - SECOP AI Analyst
risk_analyzer.py — Detecta riesgos, indicadores de direccionamiento y factores críticos

Retorna un dict con:
  nivel_riesgo_global, score_riesgo, resumen_ejecutivo_riesgos,
  indicadores_direccionamiento, riesgos_juridicos, riesgos_financieros,
  riesgos_tecnicos, alertas_eliminatorias,
  recomendaciones_oferta, recomendaciones_impugnacion
"""
import json
import logging
import re
import time

logger = logging.getLogger(__name__)

MODEL      = "gpt-4o-mini"
MAX_TOKENS = 3000
TEMP       = 0.1
MAX_TEXT   = 70_000

SYSTEM_PROMPT = (
    "Eres un experto en contratación pública colombiana especializado en detectar "
    "riesgos, posibles irregularidades y factores de direccionamiento en pliegos SECOP II. "
    "Tu análisis es crítico y objetivo. Responde SOLO con JSON válido, sin markdown."
)

PROMPT_RISKS = """Analiza el siguiente proceso de contratación SECOP II e identifica riesgos e indicadores.

DATOS DEL PROCESO:
{texto}

ANÁLISIS JURÍDICO PREVIO:
{legal_summary}

ANÁLISIS FINANCIERO PREVIO:
{financial_summary}

Responde EXCLUSIVAMENTE con este JSON (sin markdown):
{{
  "nivel_riesgo_global": "ALTO | MEDIO | BAJO",
  "score_riesgo": 0,
  "resumen_ejecutivo_riesgos": "párrafo de 2-3 oraciones resumiendo los principales riesgos",
  "indicadores_direccionamiento": [
    {{
      "tipo": "tipo de indicador (ej: Especificaciones restrictivas, Experiencia excesiva, Plazo corto)",
      "descripcion": "descripción detallada del indicador detectado",
      "severidad": "ALTO | MEDIO | BAJO",
      "texto_referencia": "fragmento del pliego que genera la alerta",
      "recomendacion": "qué hacer ante este indicador"
    }}
  ],
  "riesgos_juridicos": [
    {{
      "riesgo": "descripción del riesgo jurídico",
      "probabilidad": "ALTA | MEDIA | BAJA",
      "impacto": "ALTO | MEDIO | BAJO",
      "mitigacion": "cómo mitigar este riesgo"
    }}
  ],
  "riesgos_financieros": [
    {{
      "riesgo": "descripción del riesgo financiero",
      "probabilidad": "ALTA | MEDIA | BAJA",
      "impacto": "ALTO | MEDIO | BAJO",
      "mitigacion": "cómo mitigar este riesgo"
    }}
  ],
  "riesgos_tecnicos": [
    {{
      "riesgo": "descripción del riesgo técnico u operativo",
      "probabilidad": "ALTA | MEDIA | BAJA",
      "impacto": "ALTO | MEDIO | BAJO",
      "mitigacion": "cómo mitigar este riesgo"
    }}
  ],
  "alertas_eliminatorias": [
    {{
      "requisito": "requisito que puede ser eliminatorio",
      "descripcion": "por qué es un riesgo eliminatorio",
      "aplica_tipo_empresa": "todas | Pyme | grande | consorcio"
    }}
  ],
  "recomendaciones_oferta": [
    "recomendación concreta para preparar la propuesta"
  ],
  "recomendaciones_impugnacion": [
    "argumento para impugnar si hay irregularidades"
  ]
}}

INSTRUCCIONES:
- score_riesgo: número de 0 a 100 (0=sin riesgo, 100=máximo riesgo)
- nivel_riesgo_global: ALTO si score >= 65, MEDIO si 35-64, BAJO si < 35
- Detectar indicadores de direccionamiento: especificaciones que favorecen a un proveedor,
  plazos muy cortos, experiencia excesivamente específica, requisitos inusuales para el sector.
- Si el proceso parece transparente y competitivo, indicarlo explícitamente.
- Recomendaciones deben ser ACCIONABLES y específicas para este proceso.
"""


def analyze_risks(
    text: str,
    legal_analysis: dict = None,
    financial_analysis: dict = None,
    openai_client=None,
) -> dict:
    """
    Analiza riesgos e indicadores de direccionamiento del proceso.

    Args:
        text:               Texto combinado de los documentos
        legal_analysis:     Resultado del análisis jurídico (para contexto)
        financial_analysis: Resultado del análisis financiero (para contexto)
        openai_client:      Cliente OpenAI ya inicializado

    Returns:
        dict con análisis de riesgos completo
    """
    if not text or len(text.strip()) < 30:
        logger.warning("Texto insuficiente para análisis de riesgos")
        return _empty_result()

    client = openai_client or _get_client()
    if not client:
        logger.error("Cliente OpenAI no disponible para análisis de riesgos")
        return _empty_result(error="Cliente OpenAI no disponible")

    # Resumir análisis previos para el contexto
    legal_summary    = _summarize_legal(legal_analysis or {})
    financial_summary = _summarize_financial(financial_analysis or {})

    truncated = text[:MAX_TEXT]
    prompt = PROMPT_RISKS.format(
        texto=truncated,
        legal_summary=legal_summary,
        financial_summary=financial_summary,
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
                tokens = getattr(resp.usage, "total_tokens", 0)
                # Asegurar que score y nivel son coherentes
                result = _normalize_risk_result(result)
                logger.info(
                    f"Análisis riesgos OK. Score: {result.get('score_riesgo')}, "
                    f"Nivel: {result.get('nivel_riesgo_global')}. Tokens: {tokens}"
                )
                result["_tokens_used"] = tokens
                result["_model"] = MODEL
                return result

        except Exception as e:
            logger.warning(f"Intento {attempt + 1} análisis riesgos falló: {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)

    logger.error("Análisis de riesgos falló después de 3 intentos")
    return _empty_result(error="OpenAI no respondió")


def _summarize_legal(legal: dict) -> str:
    """Crea un resumen compacto del análisis jurídico para el contexto."""
    parts = []
    if legal.get("objeto_contrato"):
        parts.append(f"Objeto: {legal['objeto_contrato'][:200]}")
    if legal.get("modalidad_seleccion"):
        parts.append(f"Modalidad: {legal['modalidad_seleccion']}")
    if legal.get("valor_estimado"):
        parts.append(f"Valor: {legal['valor_estimado']}")
    if legal.get("duracion_contrato"):
        parts.append(f"Duración: {legal['duracion_contrato']}")
    req = legal.get("requisitos_habilitantes", {})
    tecnicos = req.get("tecnicos", [])
    if tecnicos:
        parts.append(f"Requisitos técnicos: {len(tecnicos)} requisito(s)")
        for r in tecnicos[:3]:
            parts.append(f"  - {r.get('requisito','')[:100]}")
    exp = legal.get("experiencia_exigida", {})
    if exp.get("tipo_experiencia"):
        parts.append(f"Experiencia exigida: {exp.get('años_minimos',0)} años — {exp['tipo_experiencia'][:100]}")
    return '\n'.join(parts) if parts else "No disponible"


def _summarize_financial(financial: dict) -> str:
    """Crea un resumen compacto del análisis financiero para el contexto."""
    parts = []
    pres = financial.get("presupuesto_oficial", {})
    if pres.get("valor"):
        parts.append(f"Presupuesto oficial: {pres['valor']}")
    if financial.get("patrimonio_minimo"):
        parts.append(f"Patrimonio mínimo: {financial['patrimonio_minimo']}")
    inds = financial.get("indicadores_financieros", [])
    if inds:
        parts.append(f"Indicadores financieros: {len(inds)}")
        for ind in inds[:3]:
            parts.append(f"  - {ind.get('nombre','')}: mín {ind.get('valor_minimo','')}")
    return '\n'.join(parts) if parts else "No disponible"


def _normalize_risk_result(result: dict) -> dict:
    """Asegura coherencia entre score_riesgo y nivel_riesgo_global."""
    score = result.get("score_riesgo", 0)
    if isinstance(score, str):
        try:
            score = int(re.search(r'\d+', score).group())
        except Exception:
            score = 50
    score = max(0, min(100, int(score)))
    result["score_riesgo"] = score

    nivel = result.get("nivel_riesgo_global", "")
    if nivel not in ("ALTO", "MEDIO", "BAJO"):
        if score >= 65:
            nivel = "ALTO"
        elif score >= 35:
            nivel = "MEDIO"
        else:
            nivel = "BAJO"
    result["nivel_riesgo_global"] = nivel

    return result


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
    logger.error(f"JSON inválido en análisis de riesgos: {raw[:200]}")
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
        "nivel_riesgo_global":        "MEDIO",
        "score_riesgo":               50,
        "resumen_ejecutivo_riesgos":  "",
        "indicadores_direccionamiento": [],
        "riesgos_juridicos":          [],
        "riesgos_financieros":        [],
        "riesgos_tecnicos":           [],
        "alertas_eliminatorias":      [],
        "recomendaciones_oferta":     [],
        "recomendaciones_impugnacion":[],
        "_error":       error,
        "_model":       MODEL,
        "_tokens_used": 0,
    }
