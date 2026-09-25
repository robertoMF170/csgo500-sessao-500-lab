import pathlib
p = pathlib.Path("vigia-500.py")
t = p.read_text(encoding="utf-8")

def rep(old,new,label):
    global t
    if old not in t:
        print(f"SKIP {label}")
        return False
    t=t.replace(old,new,1)
    print(f"OK {label}")
    return True

# 1. mostrar() -> HUD completo com saldo/P&L, caixa, ganho/perda, sessão
rep(
    'def mostrar(leitura: Leitura, conselho, travoes: Travoes) -> str:\n    linhas = ["", "─" * 68]\n    linhas.append(f"JOGO: {leitura.jogo or \'?\'}   SALDO: "\n                  f"{\'($%.2f\' % leitura.saldo) if leitura.saldo is not None else \'—\'}"\n                  f"   (lido «{leitura.saldo_cru}»)\")\n    linhas.append(f"MULTIPLICADOR: "\n                  f"{(\'%.2fx\' % leitura.multiplicador) if leitura.multiplicador else \'—\'}"\n                  f"   MINAS: {leitura.minas if leitura.minas is not None else \'—\'}"\n                  f"   CASAS ABERTAS: "\n                  f"{leitura.casas if leitura.casas is not None else \'—\'}"\n                  f"  (células: {leitura.casas_abertas}, contas: {leitura.casas_por_mult})\")\n    for a in leitura.avisos:\n        linhas.append(f"⚠ {a}")\n    linhas.append("")\n    linhas.append(f"▶ {conselho.titulo}")\n    for l in conselho.linhas:\n        linhas.append("   " + l)\n    linhas.append("")\n    linhas.append("  " + travoes.resumo())\n    return "\\n".join(linhas)',
    '''def mostrar(leitura: Leitura, conselho, travoes: Travoes, pausa_ate: float = 0.0) -> str:
    r = travoes.resumo_rico()
    linhas = ["", "═" * 68]
    # linha 1: saldo + P/L
    if leitura.saldo is not None:
        pnl = r["pnl"]
        pnl_s = f"{pnl:+.2f}" if pnl is not None else "—"
        pnl_pct = f" ({r[\\"pnl_pct\\"]:+.1f}%)" if r["pnl_pct"] is not None else ""
        linhas.append(f"SALDO  ${leitura.saldo:.2f}  (lido «{leitura.saldo_cru}»)  ·  P/L  ${pnl_s}{pnl_pct}  ·  pico ${r[\\"pico\\"]:.2f}" if r["pico"] is not None else f"SALDO  ${leitura.saldo:.2f}  (lido «{leitura.saldo_cru}»)")
    else:
        linhas.append(f"SALDO  —  (sem leitura)")
    linhas.append(f"JOGO  {leitura.jogo or \'?\'}  ·  MULT  {(\'%.2fx\' % leitura.multiplicador) if leitura.multiplicador else \'—\'}  ·  MINAS  {leitura.minas if leitura.minas is not None else \'—\'}  ·  CASAS  {leitura.casas if leitura.casas is not None else \'—\'}  (células:{leitura.casas_abertas} contas:{leitura.casas_por_mult})")
    # caixa: o que fazer AGORA
    caixa = travoes.CaixaAcao(conselho)
    linhas.append(f"CAIXA  ▶  {caixa}  ·  {conselho.titulo}")
    for a in leitura.avisos:
        linhas.append(f"⚠ {a}")
    linhas.append("")
    for l in conselho.linhas:
        linhas.append("   " + l)
    if conselho.ganho is not None or conselho.perda is not None:
        g = f"+${conselho.ganho:.2f}" if conselho.ganho is not None else "—"
        p = f"-${conselho.perda:.2f}" if conselho.perda is not None else "—"
        linhas.append(f"   podes ganhar {g}  ·  podes perder {p}  ·  aposta ${travoes.aposta:.2f}")
    linhas.append("")
    # sessão
    dur = int(r["duracao_s"])
    linhas.append(f"SESSÃO  {r[\\"rondas\\"]} rondas  ·  {dur//60:02d}:{dur%60:02d}  ·  {r[\\"ritmo\\"]:.1f} r/min  ·  vol ${r[\\"volume\\"]:.2f} de ${r[\\"volume_max\\"]:.2f} ({r[\\"vol_pct\\"]:.0f}%)  ·  edge ${r[\\"edge_pago\\"]:.2f}")
    linhas.append(f"        streak {r[\\"sequencia\\"]} derrotas  ·  maior ganho +${r[\\"maior_ganho\\"]:.2f}  ·  maior perda ${r[\\"maior_perda\\"]:.2f}  ·  vale ${r[\\"vale\\"]:.2f}" if r["vale"] is not None else f"        streak {r[\\"sequencia\\"]} derrotas")
    if time.time() < pausa_ate:
        linhas.append(f"⏸ EM PAUSA  {int(pausa_ate - time.time())}s — esta pausa custou $0.00 de edge. Foi a única coisa gratuita da sessão.")
    # guerra?
    if any("fim" in x for x in []):  # placeholder, real check below
        pass
    # fim/guerra hint
    tem_fim = False
    # checa travoes.volume vs max sem precisar de ordens aqui; o _laco já decide
    if r["vol_pct"] >= 100 or (leitura.saldo is not None and leitura.saldo < travoes.aposta):
        linhas.append("⛔ MODO GUERRA — orçamento esgotado ou saldo abaixo da aposta. Este painel não te impede de abrir o site. Só te obriga a ler isto antes.")
        tem_fim = True
    elif r["vol_pct"] >= 85:
        linhas.append(f"⚠ {100 - r[\\"vol_pct\\"]:.0f}% do orçamento de volume ainda disponível — prepara o fim.")
    linhas.append("  " + travoes.resumo())
    return "\\n".join(linhas)''',
    "mostrar"
)

# 2. _linhas_painel -> rico
rep(
    'def _linhas_painel(leitura: Leitura, conselho, travoes: Travoes, pausa_ate: float) -> list[str]:\n    linhas = [f"saldo {(\'$%.2f\' % leitura.saldo) if leitura.saldo is not None else \'—\'}"\n              f"   mult {(\'%.2fx\' % leitura.multiplicador) if leitura.multiplicador else \'—\'}"\n              f"   minas {leitura.minas if leitura.minas is not None else \'—\'}"\n              f"   casas {leitura.casas if leitura.casas is not None else \'—\'}"]\n    if time.time() < pausa_ate:\n        linhas.append(f"EM PAUSA: {int(pausa_ate - time.time())}s")\n    linhas += ["· " + l for l in conselho.linhas[:4]]\n    linhas += ["⚠ " + a for a in leitura.avisos[:2]]\n    linhas.append(travoes.resumo())\n    return linhas',
    '''def _linhas_painel(leitura: Leitura, conselho, travoes: Travoes, pausa_ate: float) -> list[str]:
    r = travoes.resumo_rico()
    caixa = travoes.CaixaAcao(conselho)
    pnl_s = f"{r[\\"pnl\\"]:+.2f}" if r["pnl"] is not None else "—"
    # linha compacta para a janela pequena: tem de caber
    linhas = [
        f"saldo ${leitura.saldo:.2f}  P/L {pnl_s}  caixa: {caixa}" if leitura.saldo is not None else f"saldo —  caixa: {caixa}",
        f"mult {(\'%.2fx\' % leitura.multiplicador) if leitura.multiplicador else \'—\'}  minas {leitura.minas if leitura.minas is not None else \'—\'}  casas {leitura.casas if leitura.casas is not None else \'—\'}",
    ]
    if conselho.ganho is not None or conselho.perda is not None:
        g = f"+${conselho.ganho:.2f}" if conselho.ganho is not None else "—"
        p_ = f"-${conselho.perda:.2f}" if conselho.perda is not None else "—"
        linhas.append(f"ganhas {g}  perdes {p_}  aposta ${travoes.aposta:.2f}")
    if time.time() < pausa_ate:
        linhas.append(f"⏸ EM PAUSA {int(pausa_ate - time.time())}s — $0.00 de edge")
    # só 4 linhas de conselho cabem no painel pequeno
    linhas += ["· " + l for l in conselho.linhas[:3]]
    linhas += ["⚠ " + a for a in leitura.avisos[:1]]
    # barra de volume + ritmo
    dur = int(r["duracao_s"])
    linhas.append(f"{r[\\"rondas\\"]}r  {dur//60:02d}:{dur%60:02d}  {r[\\"ritmo\\"]:.1f}r/m  vol {r[\\"vol_pct\\"]:.0f}%  edge ${r[\\"edge_pago\\"]:.2f}")
    if r["vol_pct"] >= 100 or (leitura.saldo is not None and leitura.saldo < travoes.aposta):
        linhas.append("⛔ MODO GUERRA — só leitura")
    linhas.append(travoes.resumo())
    return linhas''',
    "_linhas_painel"
)

# 3. _laco: fix docstring position + add saldo/delta/pause handling
# fix _dbg before docstring
if 'def _laco(mapa: Mapa, args, painel, parar: threading.Event, travoes: Travoes) -> dict:\n    _dbg("core._laco"' in t:
    t=t.replace('def _laco(mapa: Mapa, args, painel, parar: threading.Event, travoes: Travoes) -> dict:\n    _dbg("core._laco", "IN  args=%r painel=%s travoes=%r", vars(args) if hasattr(args, "__dict__") else args, bool(painel), travoes)\n    """O coração do modo sessão. Devolve o resumo final (útil nos testes)."""',
                'def _laco(mapa: Mapa, args, painel, parar: threading.Event, travoes: Travoes) -> dict:\n    """O coração do modo sessão. Devolve o resumo final (útil nos testes)."""\n    _dbg("core._laco", "IN  args=%r painel=%s travoes=%r", vars(args) if hasattr(args, "__dict__") else args, bool(painel), travoes)')
    print("fixed _laco docstring")

# patch the pause branch to handle all pause types + guerra
rep(
    '                        if o["tipo"] in ("micro-pausa", "cooldown-derrotas"):\n                            pausa_ate = time.time() + o["segundos"]\n                            if painel:\n                                painel.publicar({"tipo": "mensagem", "texto":\n                                                 f"⏸ {o[\'tipo\']} — {o[\'porque\']}"})',
    '                        if o["tipo"] in ("micro-pausa", "cooldown-derrotas", "cooldown-ganho"):\n                            pausa_ate = time.time() + o["segundos"]\n                            if painel:\n                                painel.publicar({"tipo": "mensagem", "texto":\n                                                 f"⏸ {o[\'tipo\']} — {o[\'porque\']}"})\n                        if o["tipo"] == "fim":\n                            pausa_ate = float("inf")\n                            print("  ⛔ MODO GUERRA — orçamento/saldo esgotado. O travão que trava de verdade é o limite de depósito na tua conta.")\n                            if painel:\n                                painel.publicar({"tipo": "mensagem", "texto": "⛔ MODO GUERRA — fecha a sessão"})',
    "_laco pausa+guerra"
)

# 4. _laco: call registar with saldo/delta and handle mostrar with pausa_ate
rep(
    '                    ordem = travoes.registar(resultado)\n                    _dbg("core._laco", "  travoes -> %r", ordem)',
    '                    ordem = travoes.registar(resultado, saldo=leitura.saldo, delta=delta)\n                    _dbg("core._laco", "  travoes -> %r", ordem)',
    "_laco registar saldo"
)

# 5. _laco: mostrar call needs pausa_ate
rep(
    '            else:\n                print(mostrar(leitura, conselho, travoes))\n            time.sleep(args.intervalo)',
    '            else:\n                print(mostrar(leitura, conselho, travoes, pausa_ate))\n            time.sleep(args.intervalo)',
    "_laco mostrar"
)

# 6. _Painel: add barra de volume, caixa destaque, overlay pausa
# We will patch __init__ to add volume bar + caixa label + overlay frame
old_painel_init = '''    def __init__(self):
        import tkinter as tk
        self.tk = tk
        self.fila: queue.Queue = queue.Queue()
        self.raiz = tk.Tk()
        self.raiz.title("vigia-500 · só leitura")
        self.raiz.attributes("-topmost", True)
        self.raiz.configure(bg="#141220")
        self.titulo = tk.Label(self.raiz, text="a olhar…", font=("Segoe UI", 15, "bold"),
                               bg="#141220", fg="#f5c451", anchor="w", justify="left",
                               padx=12, pady=8, wraplength=430)
        self.titulo.pack(fill="x")
        self.corpo = tk.Label(self.raiz, text="", font=("Consolas", 10), bg="#141220",
                              fg="#e8e6f0", anchor="w", justify="left", padx=12)
        self.corpo.pack(fill="both")
        botoes = tk.Frame(self.raiz, bg="#141220")
        botoes.pack(fill="x", pady=8)
        for texto, cmd in (("Pausa 45s", self.pedir_pausa), ("Impulso registado", self.impulso),
                           ("Terminar sessão", self.fechar)):
            tk.Button(botoes, text=texto, command=cmd, bg="#232032", fg="#e8e6f0",
                      relief="flat", padx=10, pady=5).pack(side="left", padx=6)
        self.pausa_ate = 0.0
        self.raiz.protocol("WM_DELETE_WINDOW", self.fechar)'''
new_painel_init = '''    def __init__(self):
        import tkinter as tk
        self.tk = tk
        self.fila: queue.Queue = queue.Queue()
        self.raiz = tk.Tk()
        self.raiz.title("vigia-500 · só leitura  —  saldo · caixa · pausas")
        self.raiz.attributes("-topmost", True)
        self.raiz.configure(bg="#141220")
        # topo: caixa (o que fazer na grelha)
        self.caixa_var = tk.StringVar(value="a olhar…")
        self.caixa = tk.Label(self.raiz, textvariable=self.caixa_var, font=("Segoe UI", 13, "bold"),
                              bg="#1a1830", fg="#f5c451", anchor="w", justify="left",
                              padx=12, pady=6, wraplength=460)
        self.caixa.pack(fill="x", pady=(6,0))
        # saldo + P/L
        self.saldo_var = tk.StringVar(value="")
        self.saldo = tk.Label(self.raiz, textvariable=self.saldo_var, font=("Consolas", 10, "bold"),
                              bg="#141220", fg="#3ddc97", anchor="w", justify="left", padx=12)
        self.saldo.pack(fill="x")
        # barra de volume (canvas)
        self.bar_frame = tk.Frame(self.raiz, bg="#141220", padx=12, pady=4)
        self.bar_frame.pack(fill="x")
        tk.Label(self.bar_frame, text="volume", font=("Segoe UI", 8), bg="#141220", fg="#8a88a0").pack(side="left")
        self.bar = tk.Canvas(self.bar_frame, height=10, width=220, bg="#232032", highlightthickness=0)
        self.bar.pack(side="left", padx=8)
        self.bar_fill = self.bar.create_rectangle(0,0,0,10, fill="#3ddc97", outline="")
        self.bar_text = tk.StringVar(value="0%")
        tk.Label(self.bar_frame, textvariable=self.bar_text, font=("Consolas", 9), bg="#141220", fg="#e8e6f0").pack(side="left")
        # ritmo
        self.ritmo_var = tk.StringVar(value="")
        tk.Label(self.bar_frame, textvariable=self.ritmo_var, font=("Consolas", 9), bg="#141220", fg="#8a88a0").pack(side="right")
        self.titulo = tk.Label(self.raiz, text="", font=("Segoe UI", 10, "bold"),
                               bg="#141220", fg="#f5c451", anchor="w", justify="left",
                               padx=12, wraplength=430)
        self.titulo.pack(fill="x")
        self.corpo = tk.Label(self.raiz, text="", font=("Consolas", 9), bg="#141220",
                              fg="#e8e6f0", anchor="w", justify="left", padx=12)
        self.corpo.pack(fill="both")
        botoes = tk.Frame(self.raiz, bg="#141220")
        botoes.pack(fill="x", pady=8)
        for texto, cmd in (("Pausa 45s", self.pedir_pausa), ("Impulso registado", self.impulso),
                           ("Terminar sessão", self.fechar)):
            tk.Button(botoes, text=texto, command=cmd, bg="#232032", fg="#e8e6f0",
                      relief="flat", padx=10, pady=5).pack(side="left", padx=6)
        self.pausa_ate = 0.0
        self._overlay = None
        self._estado_cache = None
        self.raiz.protocol("WM_DELETE_WINDOW", self.fechar)'''
rep(old_painel_init, new_painel_init, "_Painel.__init__")

# 7. _Painel._aplicar -> novo com saldo/barra/caixa/overlay
rep(
    '    def _aplicar(self, ev: dict) -> None:\n        if ev.get("tipo") == "estado":\n            ok = ev.get("ok")\n            cor = "#3ddc97" if ok is True else ("#ff6b6b" if ok is False else "#f5c451")\n            self.titulo.config(text=ev.get("titulo", ""), fg=cor)\n            if time.time() < self.pausa_ate:\n                texto = f"EM PAUSA: {int(self.pausa_ate - time.time())}s\\n"\n            else:\n                texto = ""\n            self.corpo.config(text=texto + "\\n".join(ev.get("linhas", [])))\n        elif ev.get("tipo") == "mensagem":\n            print("  " + ev.get("texto", ""))',
    '''    def _aplicar(self, ev: dict) -> None:
        if ev.get("tipo") == "estado":
            self._estado_cache = ev
            ok = ev.get("ok")
            cor = "#3ddc97" if ok is True else ("#ff6b6b" if ok is False else "#f5c451")
            self.titulo.config(text=ev.get("titulo", ""), fg=cor)
            # caixa + saldo + barra vêm no evento se o _laco os mandar
            if "caixa" in ev:
                self.caixa_var.set(ev["caixa"])
                # cor da caixa: verde=abrir, amarelo=sair, vermelho=parar
                c = ev["caixa"].lower()
                if "clicar" in c or "abrir" in c:
                    self.caixa.config(fg="#3ddc97")
                elif "sair" in c or "retirar" in c:
                    self.caixa.config(fg="#f5c451")
                elif "parar" in c or "guerra" in c:
                    self.caixa.config(fg="#ff6b6b")
                else:
                    self.caixa.config(fg="#f5c451")
            if "saldo_txt" in ev:
                self.saldo_var.set(ev["saldo_txt"])
            if "vol_pct" in ev:
                pct = max(0, min(100, float(ev["vol_pct"])))
                w = 220 * pct / 100.0
                self.bar.coords(self.bar_fill, 0,0, w, 10)
                # verde -> amarelo -> vermelho
                col = "#3ddc97" if pct < 85 else ("#f5c451" if pct < 100 else "#ff6b6b")
                self.bar.itemconfig(self.bar_fill, fill=col)
                self.bar_text.set(f"{pct:.0f}%")
            if "ritmo" in ev:
                self.ritmo_var.set(f"{ev[\\"ritmo\\"]:.1f} r/min")
            # overlay de pausa (bloqueia visualmente)
            em_pausa = time.time() < self.pausa_ate or ev.get("em_pausa")
            if em_pausa:
                if self._overlay is None:
                    self._overlay = self.tk.Label(self.raiz, text="", font=("Segoe UI", 11, "bold"),
                                                  bg="#1a0a0a", fg="#ff6b6b", wraplength=420,
                                                  padx=12, pady=12)
                secs = int(self.pausa_ate - time.time()) if self.pausa_ate > time.time() else int(ev.get("pausa_secs", 0))
                motivo = ev.get("pausa_motivo", "pausa")
                self._overlay.config(text=f"⏸ EM PAUSA {max(0,secs)}s\\n{motivo}\\nEsta pausa custou $0.00 de edge. Foi a única coisa gratuita da sessão.")
                self._overlay.pack(fill="x", before=self.corpo)
            else:
                if self._overlay is not None:
                    try:
                        self._overlay.pack_forget()
                    except Exception:
                        pass
            # corpo: linhas já vêm prontas do _linhas_painel
            prefix = ""
            if time.time() < self.pausa_ate:
                prefix = f"EM PAUSA: {int(self.pausa_ate - time.time())}s\\n"
            self.corpo.config(text=prefix + "\\n".join(ev.get("linhas", [])))
        elif ev.get("tipo") == "mensagem":
            txt = ev.get("texto", "")
            print("  " + txt)
            # mensagens de pausa/guerra também disparam overlay
            if "⏸" in txt or "⛔" in txt:
                secs = 0
                try:
                    import re as _re
                    m = _re.search(r"(\\d+)s", txt)
                    if m:
                        secs = int(m.group(1))
                except Exception:
                    pass
                self.pausa_ate = max(self.pausa_ate, time.time() + secs) if secs else self.pausa_ate
                # força refresh do overlay com o motivo
                if self._estado_cache:
                    self._estado_cache = dict(self._estado_cache)
                    self._estado_cache["em_pausa"] = time.time() < self.pausa_ate
                    self._estado_cache["pausa_motivo"] = txt
                    self._estado_cache["pausa_secs"] = secs''',
    "_Painel._aplicar"
)

# 8. _laco: enriquecer publicar com caixa/saldo/barra/ritmo
rep(
    '            if painel:\n                painel.publicar({"tipo": "estado", "titulo": conselho.titulo,\n                                 "ok": conselho.ok, "linhas": _linhas_painel(leitura, conselho,\n                                                                            travoes, pausa_ate)})',
    '''            if painel:
                r2 = travoes.resumo_rico()
                caixa = travoes.CaixaAcao(conselho)
                pnl_s = f"{r2[\\"pnl\\"]:+.2f}" if r2["pnl"] is not None else "—"
                saldo_txt = f"saldo ${leitura.saldo:.2f}  P/L ${pnl_s}" if leitura.saldo is not None else "saldo —"
                if r2["pnl_pct"] is not None:
                    saldo_txt += f" ({r2[\\"pnl_pct\\"]:+.1f}%)"
                painel.publicar({"tipo": "estado", "titulo": conselho.titulo,
                                 "ok": conselho.ok, "linhas": _linhas_painel(leitura, conselho, travoes, pausa_ate),
                                 "caixa": caixa, "saldo_txt": saldo_txt,
                                 "vol_pct": r2["vol_pct"], "ritmo": r2["ritmo"],
                                 "em_pausa": time.time() < pausa_ate, "pausa_secs": max(0, int(pausa_ate - time.time())) if pausa_ate else 0})''',
    "_laco publicar rico"
)

p.write_text(t, encoding="utf-8")
print("DONE", len(t))
