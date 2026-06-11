# ─────────────────────────────────────────────────────────────
#  JIREHAI — Imagen de producción
#  Node 20 + Python 3 + Tesseract OCR + Playwright Chromium
# ─────────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# ── 1. Dependencias del sistema ──────────────────────────────
#   • python3/pip  → motor IA SECOP
#   • tesseract    → OCR en pdfplumber/PyMuPDF
#   • libs de Chromium para Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    tesseract-ocr tesseract-ocr-spa \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
    libcairo2 libatspi2.0-0 libx11-xcb1 ca-certificates \
    curl wget \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Dependencias Python (motor IA) ────────────────────────
COPY backend/ai/secop-ai-analyst/requirements.txt ./ai-requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r ai-requirements.txt

# ── 3. Dependencias Node.js ──────────────────────────────────
COPY package.json ./
COPY backend/package.json ./backend/
RUN npm install --omit=dev

# ── 4. Instalar Playwright Chromium (scraper SECOP) ──────────
RUN npx playwright install chromium

# ── 5. Copiar el resto de la aplicación ──────────────────────
COPY . .

# ── 6. Crear directorios necesarios ─────────────────────────
RUN mkdir -p /app/backend/data /app/backend/ai/outputs

# ── 7. Volúmenes para persistencia ───────────────────────────
VOLUME ["/app/backend/data", "/app/backend/ai/outputs"]

# ── 8. Puerto y arranque ─────────────────────────────────────
ENV PORT=8000
EXPOSE 8000

CMD ["node", "backend/server.js"]
