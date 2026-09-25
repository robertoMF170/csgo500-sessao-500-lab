#!/usr/bin/env bash
# parar-servidor.sh — pára o servidor HTTP do servidor.sh.
#
#   bash parar-servidor.sh          # porta 8123
#   bash parar-servidor.sh 9000
#
# Faz três coisas, por ordem: mata o PID que o arranque registou, mata quem estiver à
# escuta na porta (é o que funciona quando o servidor foi arrancado noutro terminal,
# onde não temos o PID), e confirma que a porta ficou livre.
set -u
cd "$(dirname "$0")" || exit 1
PORTA="${1:-8123}"
matou=0

parar_pid() {
  local p="$1"
  [ -z "$p" ] && return 1
  # Windows (Git Bash): taskkill precisa das barras duplas para não serem tratadas como caminho.
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //PID "$p" >/dev/null 2>&1 && { echo "  terminado PID $p (taskkill)"; matou=1; return 0; }
  fi
  kill "$p" 2>/dev/null && { echo "  terminado PID $p (kill)"; matou=1; return 0; }
  return 1
}

# 1) PID registado no arranque
if [ -f "pid_servidor.txt" ]; then
  PID=$(tr -d '[:space:]' < pid_servidor.txt)
  parar_pid "$PID" || echo "  o PID $PID já não existia"
  rm -f pid_servidor.txt
fi

# 2) quem estiver à escuta na porta (em Windows a última coluna do netstat é o PID;
#    em Linux/macOS o PID não vem no netstat, por isso tenta-se o lsof)
PIDS=""
if command -v netstat >/dev/null 2>&1; then
  PIDS=$(netstat -ano 2>/dev/null | grep LISTENING | grep ":$PORTA[[:space:]]" | awk '{print $NF}' | grep -E '^[0-9]+$' | sort -u)
fi
if [ -z "$PIDS" ] && command -v lsof >/dev/null 2>&1; then
  PIDS=$(lsof -ti tcp:"$PORTA" -sTCP:LISTEN 2>/dev/null | sort -u)
fi
for p in $PIDS; do parar_pid "$p"; done

# 3) confirmação — sem isto, "parei" era uma promessa
AINDA=""
if command -v netstat >/dev/null 2>&1; then
  AINDA=$(netstat -ano 2>/dev/null | grep LISTENING | grep ":$PORTA[[:space:]]")
fi
if [ -n "$AINDA" ]; then
  echo "A porta $PORTA continua ocupada:"
  echo "$AINDA"
  echo "Se foi arrancado noutro terminal, Ctrl+C lá é o caminho mais simples."
  exit 1
fi
[ "$matou" = "1" ] && echo "Porta $PORTA livre." || echo "Não havia nada à escuta na porta $PORTA — ou seja, já estava parado."
