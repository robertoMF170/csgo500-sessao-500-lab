"""
Desafio 5 USD -> 1000 USD  (200x)  --  500 Casino
Modelo: Dice (edge 1%, multiplicador livre em [1.0102 ; 9900], limite de ganho 200.000 USD)
        Mines (edge 1%, grelha 5x5 = 25 casas, combinatorio, limite de ganho 50.000 USD)

Objetivo: testar, com evidencia empirica, o que acontece quando se "vai mudando
o valor apostado e o multiplicador / o numero de minas" para subir a banca devagar.

Uso:  python3 simulador_desafio.py
"""

import math
import random
import statistics

random.seed(500)

B0 = 5.0
GOAL = 1000.0
EDGE = 0.01
MAX_MULT = 9900.0
MAX_WIN_DICE = 200000.0
MAX_WIN_MINES = 50000.0


# ----------------------------------------------------------------- MOTOR
def dice_round(stake: float, mult: float) -> float:
    if stake * mult > MAX_WIN_DICE:
        stake = MAX_WIN_DICE / mult
    return stake * mult if random.random() < (1.0 - EDGE) / mult else 0.0


def build_mines_table():
    tab = []
    for m in range(1, 25):
        safe = 25 - m
        for k in range(1, safe + 1):
            p = math.comb(safe, k) / math.comb(25, k)
            tab.append(((1.0 - EDGE) / p, m, k, p))
    tab.sort()
    return tab


MINES = build_mines_table()


def mines_cfg_at_least(needed: float):
    for mult, m, k, p in MINES:
        if mult >= needed:
            return mult, m, k, p
    return None


def mines_cfg_nearest(target: float):
    return min(MINES, key=lambda r: abs(r[0] - target))


def mines_round(stake: float, m: int, k: int) -> float:
    p = math.comb(25 - m, k) / math.comb(25, k)
    return stake * (1.0 - EDGE) / p if random.random() < p else 0.0


# ------------------------------------------------------------ ESTRATEGIAS
def s_unica_200x():
    """BOLD PLAY OTIMO: uma aposta, all-in, multiplicador 200.0000x no Dice."""
    return (B0 * 200.0 if random.random() < (1 - EDGE) / 200.0 else 0.0), 1, B0


def make_allin_fixo(mult):
    """All-in SEMPRE, com o mesmo multiplicador (escala de lucro fixa)."""
    def f():
        bal, wag, n = B0, 0.0, 0
        while 0 < bal < GOAL and n < 5000:
            if bal * MAX_MULT < GOAL:
                break
            wag += bal
            n += 1
            bal = dice_round(bal, mult)
        return bal, n, wag
    return f


def s_bold_play_2x():
    """BOLD PLAY (Dubins-Savage) quando SO existem apostas de 2x:
    stake = min(banca, o-que-falta-para-o-objetivo)."""
    bal, wag, n = B0, 0.0, 0
    while 0 < bal < GOAL and n < 200:
        stake = min(bal, GOAL - bal)
        if stake < 0.01:
            break
        wag += stake
        n += 1
        bal = bal - stake + dice_round(stake, 2.0)
    return bal, n, wag


def s_mines_fixo(m=5, k=15):
    bal, wag, n = B0, 0.0, 0
    while 0 < bal < GOAL and n < 200:
        wag += bal
        n += 1
        bal = mines_round(bal, m, k)
    return bal, n, wag


def s_mines_variavel():
    """VARIAR O NUMERO DE MINAS a cada ronda, sempre all-in."""
    bal, wag, n = B0, 0.0, 0
    while 0 < bal < GOAL and n < 200:
        cfg = mines_cfg_at_least(GOAL / bal)
        if cfg is None:
            break
        _, m, k, _ = cfg
        wag += bal
        n += 1
        bal = mines_round(bal, m, k)
    return bal, n, wag


def s_recuperacao_suave():
    """IDEIA DO UTILIZADOR: stake em % da banca que cresce apos cada derrota,
    multiplicador tambem muda; sem 'recuperar tudo', so subir devagar."""
    bal, wag, n, losses = B0, 0.0, 0, 0
    while 0 < bal < GOAL and n < 5000:
        frac = min(0.25 + 0.09 * losses, 0.60)
        stake = bal * frac
        if stake < 0.01:
            break
        wag += stake
        n += 1
        mult = [2.0, 3.0, 5.0, 8.0][min(losses, 3)]
        if random.random() < (1 - EDGE) / mult:
            bal += stake * (mult - 1.0)
            losses = 0
        else:
            bal -= stake
            losses += 1
    return bal, n, wag


def s_mines_soft():
    """Minas + stake fracionado + numero de minas a variar a cada ronda."""
    bal, wag, n, losses = B0, 0.0, 0, 0
    while 0 < bal < GOAL and n < 5000:
        frac = min(0.20 + 0.08 * losses, 0.55)
        stake = bal * frac
        if stake < 0.01:
            break
        target = [1.5, 2.0, 3.0, 5.0][min(losses, 3)]
        mult, m, k, _ = mines_cfg_nearest(target)
        wag += stake
        n += 1
        p = math.comb(25 - m, k) / math.comb(25, k)
        if random.random() < p:
            bal += stake * (mult - 1.0)
            losses = 0
        else:
            bal -= stake
            losses += 1
    return bal, n, wag


def s_caos():
    """Muda TUDO a cada ronda: stake aleatorio 5-60%, multiplicador 1.2x-30x."""
    bal, wag, n = B0, 0.0, 0
    while 0 < bal < GOAL and n < 5000:
        stake = bal * random.uniform(0.05, 0.60)
        mult = random.uniform(1.2, 30.0)
        if stake < 0.01:
            break
        wag += stake
        n += 1
        if random.random() < (1 - EDGE) / mult:
            bal += stake * (mult - 1.0)
        else:
            bal -= stake
    return bal, n, wag


def s_martingale():
    """Martingale: base 1% da banca, dobra na derrota, reseta na vitoria."""
    bal, wag, n = B0, 0.0, 0
    base, stake = B0 * 0.01, B0 * 0.01
    while 0 < bal < GOAL and n < 5000:
        s = min(stake, bal)
        if s < 0.005:
            break
        wag += s
        n += 1
        if random.random() < (1 - EDGE) / 2.0:
            bal += s
            stake = base
        else:
            bal -= s
            stake = stake * 2.0
    return bal, n, wag


def s_grind_10pct():
    """Grind: 10% da banca a 1.2x."""
    bal, wag, n = B0, 0.0, 0
    while 0 < bal < GOAL and n < 2000:
        stake = bal * 0.10
        if stake < 0.005:
            break
        wag += stake
        n += 1
        if random.random() < (1 - EDGE) / 1.2:
            bal += stake * 0.2
        else:
            bal -= stake
    return bal, n, wag


# ----------------------------------------------------------------- HARNESS
STRATEGIES = [
    ("1 aposta all-in Dice 200x    << OTIMO", s_unica_200x, 2_000_000, 1),
    ("Bold play com apostas de 2x", s_bold_play_2x, 1_000_000, 200),
    ("All-in fixo 1.5x", make_allin_fixo(1.5), 1_000_000, 5000),
    ("All-in fixo 1.2x", make_allin_fixo(1.2), 1_000_000, 5000),
    ("All-in fixo 1.05x", make_allin_fixo(1.05), 500_000, 5000),
    ("All-in fixo 1.02x", make_allin_fixo(1.02), 200_000, 5000),
    ("Mines fixo 5 minas / 15 casas", s_mines_fixo, 1_000_000, 200),
    ("Mines VARIAVEL (all-in)", s_mines_variavel, 1_000_000, 200),
    ("Recuperacao suave %+mult (Dice)", s_recuperacao_suave, 60_000, 5000),
    ("Mines soft (% + minas a variar)", s_mines_soft, 60_000, 5000),
    ("CAOS (stake e mult aleatorios)", s_caos, 60_000, 5000),
    ("Martingale classico", s_martingale, 60_000, 5000),
    ("Grind 10% da banca a 1.2x", s_grind_10pct, 60_000, 2000),
]


CAPS = {}


def run(name, func, trials, cap):
    wins = broke = unresolved = 0
    finals, bets, wags = [], [], []
    for _ in range(trials):
        bal, n, wag = func()
        if bal >= GOAL:
            wins += 1
        elif bal <= 0.0:
            broke += 1
        else:
            unresolved += 1
        finals.append(bal)
        bets.append(n)
        wags.append(wag)
    return dict(name=name, trials=trials, p=wins / trials, e=statistics.fmean(finals),
                med=statistics.median(finals), broke=broke / trials,
                unres=unresolved / trials,
                n=statistics.fmean(bets), wag=statistics.fmean(wags))


def main():
    W = 122
    print("=" * W)
    print("DESAFIO  $5 -> $1.000  (200x)     500 Casino: Dice 1% edge | Mines 1% edge")
    print("=" * W)

    print("\n[1] A MELHOR CONFIGURACAO DE MINAS PARA 200x\n")
    rows = []
    for m in range(1, 25):
        for k in range(1, 26 - m):
            p = math.comb(25 - m, k) / math.comb(25, k)
            if (1 - EDGE) / p >= 200:
                rows.append((p, (1 - EDGE) / p, m, k))
                break
    rows.sort(reverse=True)
    print(f"    {'chance':>9} {'mult':>9} {'minas':>6} {'casas':>6}   desperdicio")
    for p, mult, m, k in rows[:6]:
        print(f"    {p*100:8.4f}% {mult:8.1f}x {m:6d} {k:6d}   {mult/200-1:+.1%} sobre os 200x")
    print(f"\n    MELHOR config de minas : {rows[0][3]} casas seguras / {rows[0][2]} minas"
          f" -> {rows[0][1]:.1f}x @ {rows[0][0]*100:.4f}%")
    print(f"    DICE a 200.0000x exato : 200.0x @ {0.99/200*100:.4f}%"
          f"   (vantagem do Dice: {0.99/200/rows[0][0]-1:+.1%})")

    print("\n[2] O PRECO DA LENTIDAO  --  P = (1-edge)^n / 200\n")
    print(f"    {'n apostas':>9} {'mult. fixo':>11} {'P (mult fixo)':>15} "
          f"{'P (mult livre)':>16} {'E[saldo]':>10} {'1 em ...':>9}")
    for M, n in [(200.0, 1), (2.0, 8), (1.5, 14), (1.2, 30), (1.1, 56), (1.05, 109), (1.02, 268)]:
        pf = ((1 - EDGE) / M) ** n
        pl = ((1 - EDGE) ** n) / 200
        print(f"    {n:9d} {M:10.2f}x {pf*100:14.4f}% {pl*100:15.4f}% {pf*GOAL:9.2f}$ {1/pf:8.0f}")

    print("\n[3] MONTE CARLO\n")
    res = []
    for name, func, trials, cap in STRATEGIES:
        r = run(name, func, trials, cap)
        res.append(r)
        print(f"    ok  {name:<36} ({trials:,})")

    print("\n" + "=" * W)
    print(f"{'ESTRATEGIA':<36}{'apostas':>9}{'P($1000)':>11}{'E[final]':>11}"
          f"{'%quebrou':>10}{'%aberto':>9}{'$ apostado':>12}")
    print("-" * W)
    for r in res:
        print(f"{r['name']:<36}{r['n']:>9.1f}{r['p']*100:>10.4f}%{r['e']:>10.2f}$"
              f"{r['broke']*100:>9.1f}%{r['unres']*100:>8.1f}%{r['wag']:>11.0f}$")
    print("=" * W)
    print("  %aberto = nao chegou a $1000 nem quebrou dentro do teto de rondas")

    print("\n[4] IDENTIDADE CONTABILISTICA:  E[saldo final] ~= 5 - 0.01 x E[total apostado]\n")
    for r in res:
        pred = 5 - 0.01 * r['wag']
        print(f"    {r['name']:<36} 5 - 0.01x{r['wag']:>6.0f} = "
              f"{pred:>6.2f}$   (sim: {r['e']:>8.2f}$)")


if __name__ == "__main__":
    main()
