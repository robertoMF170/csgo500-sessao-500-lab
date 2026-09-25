"""vigia_debug.py — logger centralizado com máximo de detalhe.

Usado por vigia_visao.py, vigia-500.py e vigia_motor.py.
Sem este ficheiro o resto funciona igual (debug desligado por omissão).

Ativação:
  - variável de ambiente VIGIA_DEBUG=1
  - ou chamar vigia_debug.activar() no início do programa
  - ou passar --debug na linha de comandos do vigia-500.py

Saída:
  - stderr (sempre que ativo)
  - ficheiro (capturas/vigia-debug.log por omissão quando --debug)
  - linha com timestamp absoluto, delta desde o início, tag e mensagem
"""

from __future__ import annotations

import datetime
import json
import os
import sys
import time
import traceback

_ATIVO = os.environ.get("VIGIA_DEBUG") in ("1", "true", "True", "yes", "on")
_FICHEIRO: str | None = os.environ.get("VIGIA_DEBUG_FILE")
_FH = None
_T0 = time.monotonic()
_CONTADOR = 0

def _agora() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]

def _elapsed() -> str:
    return f"+{time.monotonic() - _T0:07.3f}s"

def activar(ficheiro: str | None = None, para_stderr: bool = True) -> None:
    """Liga o debug. Se ficheiro for dado, escreve lá também (append)."""
    global _ATIVO, _FICHEIRO, _FH, _T0
    _ATIVO = True
    _T0 = time.monotonic()
    if ficheiro:
        _FICHEIRO = ficheiro
        try:
            os.makedirs(os.path.dirname(ficheiro) or ".", exist_ok=True)
            _FH = open(ficheiro, "a", encoding="utf-8", buffering=1)
            _FH.write(f"\n{'='*72}\n# vigia-debug iniciado em {_agora()} pid={os.getpid()} ficheiro={ficheiro}\n{'='*72}\n")
        except Exception as e:
            print(f"[vigia_debug] não consegui abrir {ficheiro}: {e}", file=sys.stderr)
            _FH = None
    # primeira linha no stderr para confirmar que está ligado
    if para_stderr:
        print(f"[DBG {_agora()} {_elapsed()}] [debug] ATIVADO  pid={os.getpid()} ficheiro={_FICHEIRO or '-'}", file=sys.stderr, flush=True)

def desactivar() -> None:
    global _ATIVO, _FH
    _ATIVO = False
    if _FH:
        try:
            _FH.close()
        except Exception:
            pass
        _FH = None

def activo() -> bool:
    return bool(_ATIVO)

def log(tag: str, msg: str, *args, extra: dict | None = None, exc: BaseException | None = None) -> None:
    """Loga uma linha com tag. Máximo de info, sem filtrar.

    tag: módulo/função curta, ex.: visao.capturar_regiao, motor.recomendar
    msg: texto livre; usa *args se quiser formatação com %s
    extra: dict para largar JSON na mesma linha (truncado se muito grande)
    """
    if not _ATIVO:
        return
    global _CONTADOR
    _CONTADOR += 1
    if args:
        try:
            msg = msg % args
        except Exception:
            msg = msg + " | args=" + " ".join(map(repr, args))
    linha = f"[DBG {_agora()} {_elapsed()} #{_CONTADOR:05d}] [{tag}] {msg}"
    if extra is not None:
        try:
            j = json.dumps(extra, ensure_ascii=False, default=str)
            if len(j) > 1200:
                j = j[:1150] + f"... (+{len(j)-1150} chars truncados)"
            linha += f" | {j}"
        except Exception:
            linha += f" | extra={extra!r}"
    if exc is not None:
        linha += f" | EXC {type(exc).__name__}: {exc}"
        # stack curto
        try:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            # limita a 2k
            if len(tb) > 2000:
                tb = tb[:2000] + "..."
            linha += "\n" + tb
        except Exception:
            pass
    # stderr
    try:
        print(linha, file=sys.stderr, flush=True)
    except Exception:
        pass
    if _FH:
        try:
            _FH.write(linha + "\n")
            _FH.flush()
        except Exception:
            pass

def dump(tag: str, nome: str, obj, max_len: int = 1200) -> None:
    """Atalho para largar um objeto JSON na mesma linha."""
    if not _ATIVO:
        return
    log(tag, "%s = %r", nome, obj, extra={nome: obj} if isinstance(obj, dict) else None)
    # também tenta json
    try:
        j = json.dumps(obj, ensure_ascii=False, default=str)
        if len(j) > max_len:
            j = j[:max_len] + "..."
        log(tag, "%s (json) %s", nome, j)
    except Exception:
        pass

class cronometro:
    """with vigia_debug.cronometro('visao.segmentar'):  mede e loga duração."""
    def __init__(self, tag: str, msg: str = ""):
        self.tag = tag
        self.msg = msg
        self.t0 = 0.0
    def __enter__(self):
        self.t0 = time.perf_counter()
        if _ATIVO:
            log(self.tag, "IN  %s", self.msg)
        return self
    def __exit__(self, *a):
        dt = (time.perf_counter() - self.t0) * 1000.0
        if _ATIVO:
            log(self.tag, "OUT %s  %.2f ms", self.msg, dt)
