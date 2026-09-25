"""Motor de disciplina do vigia-500 — o mesmo que o HUD, em Python.

Este ficheiro é um PORTE do motor que vive em `painel-500.user.js` (secções 1, 3.1, 3.2, 6).
Um porte é uma segunda verdade, e duas verdades divergem sempre — por isso existe
`ponte-motor.js` + `teste-vigia.py`: o teste corre o motor JavaScript REAL e compara os números
com os daqui. Sem esse teste, isto seria uma reescrita com esperança.

O que aqui está:
  - `parse_moeda`      — o mesmo parser de moeda do HUD (formatos reais do csgo500)
  - `JOGOS`            — a tabela de edge oficial do 500
  - `rotacao`          — a DSL da rotação: `dice 2.0`, `mines 3 2`
  - `reverter_casas`   — multiplicador -> quantas casas seguras estão abertas
  - `recomendar`       — a recomendação das Mines/Dice, sem decidir por ninguém
  - `Travoes`          — micro-pausas, sequências de derrotas e orçamento de volume
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Iterable

ESPACOS = "\u0020\u00a0\u202f\u2009\t\r\n"

try:
    import vigia_debug
    _HAS_DEBUG = True
except ImportError:
    vigia_debug = None  # type: ignore
    _HAS_DEBUG = False

def _dbg(tag, msg, *a, **kw):
    if _HAS_DEBUG and vigia_debug is not None and getattr(vigia_debug, "activo", lambda: False)():
        vigia_debug.log(tag, msg, *a, **kw)


# ============================== 1. PARSER DE MOEDA ==============================
def parse_moeda(bruto) -> float | None:
    """O mesmo que `parseMoney` do userscript, passo por passo.

    Formatos reais observados no site: "199 999,91 USD", "5 805,80", "398,02", "0,72 USD".
    Ambiguidade documentada: "1.234" é 1234 em formato europeu e 1.234 em formato US — por isso
    o programa mostra SEMPRE o texto cru ao lado do valor interpretado.
    """
    _dbg("motor.parse_moeda", "IN  bruto=%r", bruto)
    if bruto is None:
        _dbg("motor.parse_moeda", "OUT None (bruto is None)")
        return None
    orig = str(bruto)
    s = str(bruto)
    s = re.sub(r"[\s\u00a0\u202f\u2009]", "", s)
    s = re.sub(r"[^\d.,\-\u2212]", "", s).replace("\u2212", "-")
    _dbg("motor.parse_moeda", "  limpo %r -> %r", orig, s)
    if not s or not re.search(r"\d", s):
        _dbg("motor.parse_moeda", "OUT None (sem dígitos)")
        return None
    ultima_virgula = s.rfind(",")
    ultimo_ponto = s.rfind(".")
    antes = s
    if ultima_virgula > -1 and ultimo_ponto > -1:
        if ultima_virgula > ultimo_ponto:
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif ultima_virgula > -1:
        depois = len(s) - ultima_virgula - 1
        s = s.replace(",", ".", 1) if depois in (1, 2) else s.replace(",", "")
    elif ultimo_ponto > -1:
        depois = len(s) - ultimo_ponto - 1
        if depois == 3 and re.fullmatch(r"\d{1,3}\.\d{3}", s):
            s = s.replace(".", "", 1)
    if antes != s:
        _dbg("motor.parse_moeda", "  separadores %r -> %r", antes, s)
    try:
        v = float(s)
    except ValueError as e:
        _dbg("motor.parse_moeda", "OUT None (float falhou)", exc=e)
        return None
    out = v if math.isfinite(v) else None
    _dbg("motor.parse_moeda", "OUT %r  (de %r)", out, bruto)
    return out


def texto_da_aposta(v: float | str) -> str:
    """Escreve o valor com 2 decimais como o plano o mostra — e NUNCA arredonda.

    0.005 continua "0.005" porque uma aposta arredondada é uma aposta que ninguém autorizou.
    """
    n = v if isinstance(v, (int, float)) else parse_moeda(v)
    if n is None or not isinstance(n, (int, float)) or not math.isfinite(n):
        return str(v)
    duas = round(n + 0.0, 2)
    return f"{n:.2f}" if abs(duas - n) < 1e-12 else str(v)


# ============================== 2. EDGE DE CADA JOGO ==============================
# A tabela oficial do 500: é ela que transforma "jogo a jogo" em números.
JOGOS = {
    "blackjack": {"nome": "Blackjack", "edge": 0.0052, "tipo": "cartas"},
    "dice": {"nome": "Dice", "edge": 0.01, "tipo": "dados"},
    "mines": {"nome": "Mines", "edge": 0.01, "tipo": "minas"},
    "baccarat": {"nome": "Baccarat", "edge": 0.01, "tipo": "cartas"},
    "keno": {"nome": "Keno", "edge": 0.02, "tipo": "tabela"},
    "limbo": {"nome": "Limbo", "edge": 0.02, "tipo": "tabela"},
    "hilo": {"nome": "Hi-Lo", "edge": 0.02, "tipo": "cartas"},
    "blitz": {"nome": "Blitz", "edge": 0.02, "tipo": "tabela"},
    "trader": {"nome": "Trader", "edge": 0.02, "tipo": "tabela"},
    "cross": {"nome": "Cross", "edge": 0.02, "tipo": "tabela"},
    "sports": {"nome": "Desporto", "edge": 0.03, "tipo": "tabela"},
    "plinko": {"nome": "Plinko", "edge": 0.04, "tipo": "tabela"},
    "towers": {"nome": "Towers", "edge": 0.05, "tipo": "escada"},
    "duels": {"nome": "Duels", "edge": 0.05, "tipo": "pvp"},
    "wheel": {"nome": "Wheel", "edge": 0.0501, "tipo": "tabela"},
    "crash": {"nome": "Crash", "edge": 0.06, "tipo": "tabela"},
    "roulette": {"nome": "Roleta", "edge": 0.0666, "tipo": "tabela"},
    "cases": {"nome": "Cases", "edge": 0.10, "tipo": "tabela"},
}

# ============================== 3. ROTAÇÃO ==============================


@dataclass
class Passo:
    jogo: str
    mult: float = 0.0
    minas: int = 0
    casas: int = 0
    label: str = ""
    chance: float = 0.0

    def __post_init__(self):
        if not self.label:
            if self.jogo == "Dice":
                self.label = f"Dice {self.mult:.2f}x"
            else:
                self.label = f"Mines {self.minas}m/{self.casas}c"


def _combinacoes(n: int, k: int) -> int:
    if k < 0 or k > n:
        return 0
    return math.comb(n, k)


def rotacao(linhas: Iterable[str], edge: float = 0.01) -> list[Passo]:
    """A DSL da rotação, igual à do HUD: `dice 2.0` e `mines 3 2` (minas, casas seguras)."""
    _dbg("motor.rotacao", "IN  linhas=%r edge=%.4f", list(linhas) if not isinstance(linhas, list) else linhas, edge)
    # re-itera se foi consumido pelo log acima
    if not isinstance(linhas, list):
        linhas = list(linhas)
    saida: list[Passo] = []
    for cru in linhas:
        partes = str(cru).strip().split()
        if not partes:
            _dbg("motor.rotacao", "  linha vazia -> ignora")
            continue
        nome = partes[0].lower()
        if nome == "dice":
            try:
                m = float(partes[1])
            except (IndexError, ValueError) as e:
                _dbg("motor.rotacao", "  dice parse falhou %r", cru, exc=e)
                continue
            if math.isfinite(m) and m > 1:
                p = Passo("Dice", mult=m, chance=(1 - edge) / m)
                _dbg("motor.rotacao", "  dice %r -> %r", cru, p)
                saida.append(p)
            else:
                _dbg("motor.rotacao", "  dice fora de intervalo %r m=%r", cru, m)
        elif nome == "mines":
            try:
                minas, casas = int(partes[1]), int(partes[2])
            except (IndexError, ValueError) as e:
                _dbg("motor.rotacao", "  mines parse falhou %r", cru, exc=e)
                continue
            if 1 <= minas <= 24 and 0 <= casas <= 25 - minas:
                p = _combinacoes(25 - minas, casas) / _combinacoes(25, casas)
                passo = Passo("Mines", minas=minas, casas=casas, chance=p, mult=(1 - edge) / p)
                _dbg("motor.rotacao", "  mines %r -> %r", cru, passo)
                saida.append(passo)
            else:
                _dbg("motor.rotacao", "  mines fora de intervalo %r", cru)
        else:
            _dbg("motor.rotacao", "  jogo desconhecido %r", cru)
    _dbg("motor.rotacao", "OUT %d passos", len(saida))
    return saida


def reverso_casas(minas: int, mult: float, edge: float = 0.01) -> int:
    """Quantas casas seguras produzem este multiplicador. O MESMO algoritmo do HUD."""
    _dbg("motor.reverso_casas", "IN  minas=%d mult=%.4f edge=%.4f", minas, mult, edge)
    for k in range(0, 25 - minas + 1):
        p = _combinacoes(25 - minas, k) / _combinacoes(25, k)
        m = (1 - edge) / p
        _dbg("motor.reverso_casas", "  k=%d p=%.6f m=%.4f", k, p, m)
        if m >= mult - 0.005:
            _dbg("motor.reverso_casas", "OUT %d", k)
            return k
    _dbg("motor.reverso_casas", "OUT 0 (nenhum k atingiu)")
    return 0


def multiplicador(minas: int, casas: int, edge: float = 0.01) -> float:
    p = _combinacoes(25 - minas, casas) / _combinacoes(25, casas)
    return (1 - edge) / p if p else float("inf")


# ============================== 4. RECOMENDAÇÃO ==============================


@dataclass
class Leitura:
    """O que os olhos viram. Tudo opcional: o programa nunca inventa."""

    jogo: str | None = None
    saldo: float | None = None
    saldo_cru: str = ""
    multiplicador: float | None = None
    minas: int | None = None
    casas_abertas: int | None = None          # contadas nas CÉLULAS (cor)
    casas_por_mult: int | None = None         # contadas pelo MULTIPLICADOR
    avisos: list[str] = field(default_factory=list)

    @property
    def casas(self) -> int | None:
        """Duas medições independentes do mesmo número — e o desacordo é informação."""
        if self.casas_abertas is not None and self.casas_por_mult is not None:
            if self.casas_abertas != self.casas_por_mult:
                return None
        return self.casas_abertas if self.casas_abertas is not None else self.casas_por_mult


@dataclass
class Conselho:
    jogo: str = ""
    titulo: str = ""
    ok: bool | None = None
    ganho: float | None = None
    perda: float | None = None
    linhas: list[str] = field(default_factory=list)
    passo: Passo | None = None


def recomendar(leitura: Leitura, aposta: float, orcamento: float = 5.0, edge: float = 0.01,
               passos: list[Passo] | None = None, indice: int = 0) -> Conselho:
    """A jogada do plano, com o número que os olhos deram. Não decide: descreve.

    Reproduz o essencial das três decisões do HUD nas Minas:
      - mais casas abertas do que o plano pede  -> FORA DO PLANO · RETIRAR
      - exactamente as do plano                 -> RETIRAR
      - menos                                   -> ABRIR MAIS 1
    E repete, sempre, a única frase que interessa dentro de uma ronda das Mines: a margem de 1%
    foi paga na entrada, e a partir daí abrir ou retirar é uma escolha de variância, não de valor.
    """
    _dbg("motor.recomendar", "IN  leitura=%r aposta=%.2f orc=%.2f edge=%.4f indice=%d passos=%d",
         leitura, aposta, orcamento, edge, indice, len(passos) if passos else 0)
    jogo = leitura.jogo or ""
    meta = JOGOS.get(jogo)
    _dbg("motor.recomendar", "  jogo=%r meta=%r", jogo, meta)
    c = Conselho(jogo=jogo)
    if not meta:
        c.titulo = "SEM RECOMENDAÇÃO"
        c.ok = None
        c.linhas.append("Não sei que jogo é este. Se estiveres no Dice ou nas Minas, diz-me "
                        "(é a única coisa que o programa não consegue ver sozinho).")
        return c

    passo = passos[indice] if passos and 0 <= indice < len(passos) else None
    c.passo = passo
    _dbg("motor.recomendar", "  passo=%r", passo)
    c.linhas.append(f"Edge do {meta['nome']}: {meta['edge'] * 100:.2f}% por ronda apostada")

    if jogo == "mines":
        minas = leitura.minas or (passo.minas if passo and passo.jogo == "Mines" else 3)
        pedidas = passo.casas if passo and passo.jogo == "Mines" else 3
        mult_site = leitura.multiplicador
        c.linhas.append(f"{minas} minas  ·  plano: {minas} minas / {pedidas} casas")
        if mult_site is None:
            c.ok = None
            c.titulo = "SEM LEITURA DO MULTIPLICADOR"
            c.linhas.append("Não consigo ler o multiplicador no ecrã — sem ele não sei quantas casas "
                            "tens abertas, e não invento.")
            return c
        abertas = max(0, reverso_casas(minas, mult_site, edge))
        p_prox = (25 - minas - abertas) / (25 - abertas) if 25 - abertas else 0
        c.ganho = aposta * multiplicador(minas, max(1, abertas), edge) - aposta if abertas else None
        _dbg("motor.recomendar", "  mines minas=%d pedidas=%d mult=%.4f -> abertas=%d p_prox=%.3f", minas, pedidas, mult_site, abertas, p_prox)

        if leitura.casas_abertas is not None and leitura.casas_abertas != abertas:
            _dbg("motor.recomendar", "  DESACORDO células=%r vs mult=%r", leitura.casas_abertas, abertas)
            c.linhas.append(f"⚠ CONTAS DIFERENTES: nas células vejo {leitura.casas_abertas} casas "
                            f"abertas e pelo multiplicador conto {abertas}. Não recomendo nada com "
                            f"duas respostas diferentes — confirma no ecrã.")
            c.ok = None
            c.titulo = "LEITURA EM DESACORDO"
            _dbg("motor.recomendar", "OUT %r ok=%r", c.titulo, c.ok)
            return c

        if pedidas > 0 and abertas > pedidas:
            c.titulo, c.ok = "FORA DO PLANO · RETIRAR", False
            c.linhas.append(f"Abriste {abertas} casas e o plano pedia {pedidas}. Passaste o alvo.")
        elif pedidas > 0 and abertas == pedidas:
            c.titulo, c.ok = "RETIRAR", True
            c.linhas.append(f"Atingiste o alvo ({pedidas}). É aqui que se retira — antes de mais "
                            f"nenhuma, não depois.")
        else:
            c.titulo, c.ok = "ABRIR MAIS 1", True
            c.linhas.append(f"Faltam {max(0, pedidas - abertas)} casas para o alvo do plano.")
        c.perda = aposta * multiplicador(minas, max(1, abertas), edge) if abertas else None
        c.linhas.append(f"Próxima casa: p = {p_prox * 100:.1f}%")
        c.linhas.append("A margem de 1% foi paga na ENTRADA. A partir daí o jogo é justo: "
                        "abrir ou retirar é escolha de VARIÂNCIA, não de valor.")
        c.linhas.append("O clique continua a ser teu. Este programa não clica em nada.")
        _dbg("motor.recomendar", "OUT %r ok=%r ganho=%r", c.titulo, c.ok, c.ganho)
        return c

    if jogo == "dice":
        alvo = passo.mult if passo and passo.jogo == "Dice" else 2.0
        p = (1 - edge) / alvo
        c.titulo = f"APOSTAR {alvo:.2f}x  ·  ${aposta:.2f}"
        c.ok = True
        c.ganho = aposta * alvo - aposta
        c.perda = aposta
        c.linhas.append(f"Ganhas com {p * 100:.2f}% das jogadas. Perdes {aposta:.2f} para ganhar "
                        f"{c.ganho:.2f}.")
        c.linhas.append("O clique em Apostar é teu.")
        _dbg("motor.recomendar", "OUT %r ok=%r", c.titulo, c.ok)
        return c

    c.titulo = "SEM RECOMENDAÇÃO DE APOSTA"
    c.ok = False
    c.linhas.append(f"{meta['nome']} não se adapta à rotação: se o plano não te diz para estar aqui, "
                    f"não estejas. O EV de uma aposta de ${aposta:.2f} é "
                    f"−${meta['edge'] * aposta:.4f}.")
    _dbg("motor.recomendar", "OUT %r ok=%r (sem rotação)", c.titulo, c.ok)
    return c


# ============================== 5. TRAVÕES ==============================


@dataclass
class Travoes:
    """Os mesmos travões do HUD: nada aqui olha para o jogo, só para o comportamento.

    Agora com TUDO o que o HUD cobra: micro-pausa, sequência de derrotas, ganho grande,
    orçamento de volume + sessão (saldo, P/L, ritmo, picos). É o mesmo que vês no
    painel-500.user.js e no painel-sessao.html, portado 1:1.
    """

    micro_cada: int = 25
    micro_segundos: int = 45
    derrotas_seguidas: int = 5
    derrotas_pausa: int = 180
    ganho_gatilho: float = 1.0       # winCoolAmount — ganho numa ronda que dispara pausa
    ganho_pausa: int = 120           # winCoolSecs
    orcamento: float = 5.0
    edge: float = 0.01
    aposta: float = 0.30

    rondas: int = 0
    sequencia: int = 0
    volume: float = 0.0
    pausas: int = 0
    # --- sessão (saldo) ---
    saldo_inicial: float | None = None
    saldo_atual: float | None = None
    saldo_pico: float | None = None
    saldo_vale: float | None = None
    maior_ganho: float = 0.0
    maior_perda: float = 0.0
    inicio_ts: float | None = None
    # janela de timestamps para ritmo (últimos 5 min)
    _ritmo_ts: list[float] = field(default_factory=list)

    @property
    def volume_maximo(self) -> float:
        """O orçamento é de DINHEIRO; o que se gasta a jogar é volume. volume = orçamento / edge."""
        return self.orcamento / self.edge if self.edge else float("inf")

    # ===== helpers de sessão =====
    @property
    def pnl(self) -> float | None:
        if self.saldo_inicial is None or self.saldo_atual is None:
            return None
        return self.saldo_atual - self.saldo_inicial

    @property
    def pnl_pct(self) -> float | None:
        if self.pnl is None or not self.saldo_inicial:
            return None
        return self.pnl / self.saldo_inicial * 100.0

    def ritmo(self) -> float:
        """Rondas por minuto na janela dos últimos 5 min."""
        if len(self._ritmo_ts) < 2:
            return 0.0
        janela = 300.0
        agora = self._ritmo_ts[-1]
        dentro = [t for t in self._ritmo_ts if agora - t <= janela]
        span = max(1.0, dentro[-1] - dentro[0])
        return len(dentro) / (span / 60.0)

    def CaixaAcao(self, conselho) -> str:
        """O que fazer NA CAIXA: CLICAR / SAIR / FICAR / —."""
        t = (conselho.titulo or "").upper()
        if "ABRIR MAIS" in t:
            return "CLICAR numa casa"
        if "RETIRAR" in t:
            return "SAIR (RETIRAR)"
        if "APOSTAR" in t:
            return "APOSTAR"
        if "SEM" in t or "DESACORDO" in t or "FORA DO PLANO" in t:
            return "PARAR — confirmar no ecrã"
        return "—"

    def registar(self, resultado: str, aposta: float | None = None,
                 saldo: float | None = None, delta: float | None = None) -> dict:
        """Uma ronda classificada pelos olhos ('win'|'lose'|'push'). Devolve o que fazer agora.

        saldo/delta são opcionais mas é com eles que o vigia aprende saldo, P/L, picos e ritmo
        — e é só com delta que o gatilho de ganho grande existe.
        """
        _dbg("motor.Travoes.registar", "IN  resultado=%r aposta=%r saldo=%r delta=%r  rondas=%d vol=%.2f seq=%d",
             resultado, aposta, saldo, delta, self.rondas, self.volume, self.sequencia)
        valor = self.aposta if aposta is None else aposta
        self.rondas += 1
        self.volume += valor
        self.sequencia = self.sequencia + 1 if resultado == "lose" else 0
        agora = __import__("time").time()
        if self.inicio_ts is None:
            self.inicio_ts = agora
        self._ritmo_ts.append(agora)
        # corta janela antiga
        self._ritmo_ts = [t for t in self._ritmo_ts if agora - t <= 600]
        # saldo / P&L / picos
        if saldo is not None:
            self.saldo_atual = saldo
            if self.saldo_inicial is None:
                self.saldo_inicial = saldo
                self.saldo_pico = saldo
                self.saldo_vale = saldo
            else:
                if self.saldo_pico is None or saldo > self.saldo_pico:
                    self.saldo_pico = saldo
                if self.saldo_vale is None or saldo < self.saldo_vale:
                    self.saldo_vale = saldo
        if delta is not None:
            if delta > self.maior_ganho:
                self.maior_ganho = delta
            if delta < self.maior_perda:
                self.maior_perda = delta
        _dbg("motor.Travoes.registar", "  -> rondas=%d vol=%.2f seq=%d max=%.2f saldo=%r pnl=%r",
             self.rondas, self.volume, self.sequencia, self.volume_maximo, self.saldo_atual, self.pnl)
        ordens = []
        # 1) cooldown por sequência de derrotas (tem prioridade sobre micro-pausa)
        if self.sequencia >= self.derrotas_seguidas:
            ordens.append({"tipo": "cooldown-derrotas", "segundos": self.derrotas_pausa,
                           "porque": f"{self.sequencia} derrotas seguidas — é o momento clássico de apostar na emoção"})
            _dbg("motor.Travoes.registar", "  gatilho cooldown-derrotas")
        # 2) cooldown por ganho grande (se não houve streak)
        elif delta is not None and delta >= self.ganho_gatilho:
            ordens.append({"tipo": "cooldown-ganho", "segundos": self.ganho_pausa,
                           "porque": f"ganho de ${delta:.2f} numa ronda — é aqui que se sobe o stake"})
            _dbg("motor.Travoes.registar", "  gatilho cooldown-ganho")
        elif self.micro_cada and self.rondas % self.micro_cada == 0:
            ordens.append({"tipo": "micro-pausa", "segundos": self.micro_segundos,
                           "porque": f"{self.rondas} rondas — cansaço de julgamento"})
            _dbg("motor.Travoes.registar", "  gatilho micro-pausa")
        if self.volume >= self.volume_maximo:
            ordens.append({"tipo": "fim", "segundos": 0,
                           "porque": "orçamento de volume esgotado — modo guerra"})
            _dbg("motor.Travoes.registar", "  gatilho fim (volume)")
        elif self.volume > 0.85 * self.volume_maximo:
            ordens.append({"tipo": "aviso", "segundos": 0,
                           "porque": f"{100 * (1 - self.volume / self.volume_maximo):.0f}% do orçamento de volume ainda disponível"})
            _dbg("motor.Travoes.registar", "  gatilho aviso volume")
        # saldo abaixo do stake -> fim prático
        if saldo is not None and saldo < self.aposta:
            # só adiciona se ainda não for fim por volume
            if not any(o["tipo"] == "fim" for o in ordens):
                ordens.append({"tipo": "fim", "segundos": 0,
                               "porque": f"saldo ${saldo:.2f} abaixo da aposta ${self.aposta:.2f}"})
                _dbg("motor.Travoes.registar", "  gatilho fim (saldo)")
        return {"ordens": ordens, "volume": self.volume, "rondas": self.rondas,
                "edge_pago": self.volume * self.edge,
                "saldo": self.saldo_atual, "pnl": self.pnl, "ritmo": self.ritmo()}

    def resumo(self) -> str:
        base = (f"{self.rondas} rondas · volume ${self.volume:.2f} de ${self.volume_maximo:.2f} "
                f"· edge já pago ${self.volume * self.edge:.2f} · "
                f"{self.sequencia} derrotas seguidas")
        if self.saldo_atual is not None:
            pnl_s = f"{self.pnl:+.2f}" if self.pnl is not None else "—"
            base += f" · saldo ${self.saldo_atual:.2f} (P/L {pnl_s})"
        if self.ritmo():
            base += f" · {self.ritmo():.1f} r/min"
        return base

    def resumo_rico(self) -> dict:
        """Tudo o que o painel precisa numa só chamada."""
        return {
            "rondas": self.rondas,
            "volume": self.volume,
            "volume_max": self.volume_maximo,
            "vol_pct": (self.volume / self.volume_maximo * 100.0) if self.volume_maximo else 0.0,
            "edge_pago": self.volume * self.edge,
            "saldo": self.saldo_atual,
            "saldo_ini": self.saldo_inicial,
            "pnl": self.pnl,
            "pnl_pct": self.pnl_pct,
            "pico": self.saldo_pico,
            "vale": self.saldo_vale,
            "maior_ganho": self.maior_ganho,
            "maior_perda": self.maior_perda,
            "sequencia": self.sequencia,
            "ritmo": self.ritmo(),
            "duracao_s": ( (__import__("time").time() - self.inicio_ts) if self.inicio_ts else 0.0 ),
        }
