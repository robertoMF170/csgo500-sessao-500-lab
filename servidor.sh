#!/usr/bin/env bash
# servidor.sh — serve a pasta do projecto por HTTP, para o Tampermonkey poder instalar
# o userscript pelo URL (é o único caminho em que ele mostra a página de instalação).
#
#   bash servidor.sh            # porta 8123
#   bash servidor.sh 9000       # outra porta
#
# Parar: Ctrl+C aqui. Se o arrancaste noutro sítio e não tens o terminal à mão:
#   bash parar-servidor.sh
set -u
cd "$(dirname "$0")" || exit 1
PORTA="${1:-8123}"

# No Windows o comando pode ser `python` em vez de `python3`.
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else echo "Não encontrei python nem python3 no PATH." >&2; exit 1; fi

# Regista o próprio PID para o parar-servidor.sh o poder matar a partir de outro terminal.
# O `exec` do fim substitui este processo (mantendo o PID), por isso o número continua válido.
echo $$ > pid_servidor.txt
trap 'rm -f pid_servidor.txt' EXIT INT TERM

echo "A servir: $PWD"
echo
echo "  1) instalar o userscript   http://127.0.0.1:$PORTA/painel-500.user.js"
echo "  2) ver a demo do HUD       http://127.0.0.1:$PORTA/demo-hud.html"
echo "  3) página de instruções    http://127.0.0.1:$PORTA/instalar.html"
echo
echo "Ctrl+C para parar.  (A porta $PORTA fica ocupada enquanto isto correr.)"
echo
exec "$PY" -m http.server "$PORTA" --bind 127.0.0.1
