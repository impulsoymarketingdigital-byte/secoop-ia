#!/bin/bash
echo ""
echo "  =================================================="
echo "   JIREHAI - Plataforma de Licitaciones SECOP II"
echo "  =================================================="
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo "  ERROR: Node.js no está instalado."
    echo "  Descárgalo en: https://nodejs.org"
    exit 1
fi

# Ir a la carpeta del backend
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

# Instalar dependencias si no existen
if [ ! -d "node_modules" ]; then
    echo "  Instalando dependencias por primera vez..."
    npm install
fi

echo ""
echo "  Abre en tu navegador: http://localhost:${PORT:-3001}/"
echo "  Admin:                http://localhost:${PORT:-3001}/admin.html"
echo ""
echo "  Presiona Ctrl+C para detener"
echo "  =================================================="
echo ""

node server.js
