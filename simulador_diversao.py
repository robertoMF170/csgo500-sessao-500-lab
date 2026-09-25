"""
MODO DIVERSÃO  --  Desafio: $5, apostas de $0.30 a $0.80, NUNCA all-in,
variando multiplicador e numero de minas. Objetivo: maximizar TEMPO DE JOGO
e nao apostar na emocao.

Metrica central:  o $5 compra-te  $5 / edge = $500 de VOLUME de apostas.
                  Com $0.30 por aposta isso da ~1.667 rondas.
                  Cada aposta consome  stake * edge  desse orcamento.

Medimos: duracao da sessao, pico (se chegou a estar a ganhar) e saldo final.

Uso:  python3 simulador_diversao.py
"""

import math
import random
import statistics

random.seed(7)

BUDGET = 5.0
MIN_STAKE = 0.30
MAX_STAKE = 0.80          # limite auto-imposto pelo utilizador
MIN_BET_ALLOWED = 0.30    # o site/jogador nao aposta abaixo disto
CAP = 60000               # teto de rondas por simulacao
EDGE = 0.01


def dice_delta(stake, mult):
    """Retorno adicional do Dice: ganha stake*(mult-1) ou perde stake."""
    return stake * (mult - 1.0) if random.random() < (1 - EDGE) / mult else -stake


def mines_multiplier(m, k):
    p = math.comb(25 - m, k) / math.comb(25, k)
    return (1 - EDGE) / p, p


# ----------------------------------------------------------- ESTRATEGIAS
# Cada estrategia decide, ronda a ronda, (stake, mult) a partir do estado.
def make_flat(stake, mult):
    def pick(i, bal, streak, last_win):
        return stake, mult
    return pick


def pick_multiplicador_rotativo():
    """Utilizador: vai mudando o multiplicador em GANHOS e PERDAS, stake 0.30-0.80."""
    ciclo = [1.5, 2.0, 3.0, 5.0, 1.2, 2.0, 10.0, 1.5]
    stakes = [0.30, 0.40, 0.30, 0.50, 0.30, 0.80, 0.40, 0.60]

    def pick(i, bal, streak, last_win):
        return stakes[i % len(stakes)], ciclo[i % len(ciclo)]
    return pick


def pick_minas_rotativo():
    """Minas: muda nº de minas e nº de casas a cada ronda -> multiplicador varia."""
    cfg = [(1, 3), (3, 2), (3, 4), (5, 2), (5, 5), (3, 8), (1, 10), (5, 1)]

    def pick(i, bal, streak, last_win):
        m, k = cfg[i % len(cfg)]
        mult, _ = mines_multiplier(m, k)
        return 0.30, mult
    return pick


def pick_stake_por_derrota():
    """Anti-emocao: stake SOBE na derrota (25% -> 60% do limite), mas nunca all-in."""
    def pick(i, bal, streak, last_win):
        s = min(0.30 + 0.10 * streak, 0.80)
        return s, 2.0
    return pick


def pick_anti_martingale():
    """Stake sobe no GANHO e volta ao minimo na derrota (o oposto do martingale)."""
    def pick(i, bal, streak, last_win):
        s = 0.80 if last_win else 0.30
        return s, 1.5
    return pick


STRATEGIES = [
    ("Flat $0.30  1.1x  (variancia minima)", make_flat(0.30, 1.1)),
    ("Flat $0.30  1.5x", make_flat(0.30, 1.5)),
    ("Flat $0.30  2.0x", make_flat(0.30, 2.0)),
    ("Flat $0.30  10x", make_flat(0.30, 10.0)),
    ("Flat $0.30  100x", make_flat(0.30, 100.0)),
    ("Flat $0.50  2.0x", make_flat(0.50, 2.0)),
    ("Flat $0.80  2.0x", make_flat(0.80, 2.0)),
    ("Multiplicador rotativo $0.30-0.80", pick_multiplicador_rotativo()),
    ("Minas rotativas (minas/casas a mudar)", pick_minas_rotativo()),
    ("Stake sobe na derrota ate $0.80", pick_stake_por_derrota()),
    ("Stake sobe no ganho (anti-martingale)", pick_anti_martingale()),
]


def simulate(pick, bankroll=BUDGET, cap=CAP):
    bal = bankroll
    peak = bal
    i = 0
    streak = 0
    last_win = False
    wagered = 0.0
    while bal >= MIN_BET_ALLOWED and i < cap:
        stake, mult = pick(i, bal, streak, last_win)
        stake = min(max(stake, MIN_BET_ALLOWED), MAX_STAKE, bal)
        wagered += stake
        delta = dice_delta(stake, mult)
        bal += delta
        last_win = delta > 0
        streak = 0 if last_win else streak + 1
        peak = max(peak, bal)
        i += 1
        if bal < 0:
            bal = 0.0
    return bal, i, peak, wagered


def run(name, pick, trials=5000):
    rounds, peaks, finals, wags = [], [], [], []
    ge100 = ge500 = ge1000 = capped = 0
    peak10 = peak20 = peak5 = 0
    for _ in range(trials):
        bal, n, peak, wag = simulate(pick)
        rounds.append(n)
        peaks.append(peak)
        finals.append(bal)
        wags.append(wag)
        ge100 += n >= 100
        ge500 += n >= 500
        ge1000 += n >= 1000
        capped += n >= CAP
        peak5 += peak >= 5.01
        peak10 += peak >= 10.0
        peak20 += peak >= 20.0
    rounds.sort()
    return dict(name=name, e_n=statistics.fmean(rounds),
                p10_n=rounds[int(0.10 * trials)],
                med_n=statistics.median(rounds),
                p90_n=rounds[int(0.90 * trials)],
                capped=capped / trials,
                p100=ge100 / trials, p500=ge500 / trials, p1000=ge1000 / trials,
                peak5=peak5 / trials, peak10=peak10 / trials, peak20=peak20 / trials,
                e_final=statistics.fmean(finals),
                med_final=statistics.median(finals),
                wag=statistics.fmean(wags))


def main():
    W = 128
    print("=" * W)
    print("MODO DIVERSÃO  |  banca $5  |  aposta $0.30-$0.80  |  sem all-in  |  Dice 1% edge")
    print("=" * W)

    print("\n[1] O QUE OS $5 COMPRAM\n")
    for stake in (0.30, 0.50, 0.80):
        print(f"    aposta ${stake:.2f}  ->  $5 / 1% = $500 de volume  ->  "
              f"{500/stake:8.0f} rondas   |   custo por ronda: ${stake*EDGE:.4f}")

    print("\n[2] CUSTO POR HORA (o teu relógio, não a tua sorte)\n")
    for caden in (1.5, 3.0, 6.0):
        rph = 3600 / caden
        print(f"    {caden:4.1f}s por aposta = {rph:7.0f} apostas/hora  ->  "
              f"${rph*0.30*EDGE:5.2f}/h a $0.30   ${rph*0.50*EDGE:5.2f}/h a $0.50   "
              f"${rph*0.80*EDGE:5.2f}/h a $0.80   "
              f"-> banca dura {5/(rph*0.30*EDGE):4.1f}h")

    print("\n[3] MONTE CARLO  (5.000 sessoes por estrategia)\n")
    res = []
    for name, pick in STRATEGIES:
        r = run(name, pick)
        res.append(r)
        print(f"    ok  {name}")

    print("\n" + "=" * W)
    print(f"{'ESTRATEGIA':<40}{'p10':>7}{'MEDIANA':>9}{'p90':>8}{'P>=100':>7}{'P>=500':>7}"
          f"{'P>=1000':>8}{'pico>=5.01':>11}{'pico>=$10':>10}{'final':>8}")
    print("-" * W)
    for r in res:
        print(f"{r['name']:<40}{r['p10_n']:>7d}{r['med_n']:>9.0f}{r['p90_n']:>8d}"
              f"{r['p100']*100:>6.0f}%{r['p500']*100:>6.0f}%{r['p1000']*100:>7.0f}%"
              f"{r['peak5']*100:>10.1f}%{r['peak10']*100:>9.1f}%{r['e_final']:>7.2f}$")
    print("=" * W)
    print("  p10/p90 = sessao curta/longa tipica.  MEDIANA e o numero que importa para")
    print("  'quanto tempo vou jogar'.  Teto de rondas truncou " 
          f"{max(x['capped'] for x in res)*100:.0f}% das sessoes no pior caso.")

    print("\n[4] EFEITOS QUE MUDAM O JOGO (mas nao a sorte)\n")
    best = res[2]
    eh = best["e_n"]
    print(f"    a) CUSTO POR RONDA = stake x 1%  ->  fixo, nao depende do multiplicador.")
    print(f"       Multiplicador só muda a VARIANCIA, nunca o custo esperado.")
    print(f"       Diz-se: E[saldo final] = 5 - 0.01 x volume apostado.")
    print(f"    b) Volume medio apostado nesta estrategia: ${best['wag']:.0f}"
          f" -> perda esperada ${best['wag']*EDGE:.2f}  (de $5)")
    print(f"    c) Rakeback 20% da borda (nivel VIP) -> edge efetivo 0.8%"
          f" -> mesma banca dura {eh/0.8*1.0/eh:.2f}x mais tempo")
    print(f"    d) ${500:.0f} de volume / $0.30 = {500/0.30:.0f} rondas teoricas"
          f"  (a mediana do Monte Carlo e menor por causa da variancia)")

    print("\n[5] TROCA TEMPO <-> PROBABILIDADE (o câmbio exacto)\n")
    print("    objetivo: duplicar $5 -> $10")
    print("    All-in 2x        : 49.50% de chance  |   1 ronda de duracao")
    print(f"    Flat $0.30 a 2x  : ~45% de chance    |  ~{res[2]['e_n']:.0f} rondas de duracao")
    print("    -> renuncias ~4 pontos percentuais e recebes ~1.600 rondas de diversão.")
    print("       Se a tua utilidade e TEMPO, este e um excelente negocio.")


if __name__ == "__main__":
    main()
