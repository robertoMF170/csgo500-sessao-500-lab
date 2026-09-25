import pathlib
p = pathlib.Path("vigia-500.py")
t = p.read_text(encoding="utf-8")
a = t.find("def mostrar(leitura:")
b = t.find("# ============================== VIGIL", a)
print("a",a,"b",b,"slice",b-a)
# build replacement
new = (
'def mostrar(leitura: Leitura, conselho, travoes: Travoes, pausa_ate: float = 0.0) -> str:\n'
'    r = travoes.resumo_rico()\n'
'    linhas = ["", "=" * 68]\n'
'    if leitura.saldo is not None:\n'
'        pnl = r["pnl"]\n'
'        pnl_s = f"{pnl:+.2f}" if pnl is not None else "--"\n'
'        pnl_pct = f" ({r[\'pnl_pct\']:+.1f}%)" if r["pnl_pct"] is not None else ""\n'
'        pico_s = f"  pico ${r[\'pico\']:.2f}" if r["pico"] is not None else ""\n'
'        linhas.append(f"SALDO  ${leitura.saldo:.2f}  (lido \\u00ab{leitura.saldo_cru}\\u00bb)  \\u00b7  P/L  ${pnl_s}{pnl_pct}{pico_s}")\n'
'    else:\n'
'        linhas.append(f"SALDO  --  (sem leitura)")\n'
'    linhas.append(f"JOGO  {leitura.jogo or \'?\' }  \\u00b7  MULT  {(\'%.2fx\' % leitura.multiplicador) if leitura.multiplicador else \'--\'}  \\u00b7  MINAS  {leitura.minas if leitura.minas is not None else \'--\'}  \\u00b7  CASAS  {leitura.casas if leitura.casas is not None else \'--\'}  (celulas:{leitura.casas_abertas} contas:{leitura.casas_por_mult})")\n'
'    caixa = travoes.CaixaAcao(conselho)\n'
'    linhas.append(f"CAIXA  \\u25b6  {caixa}  \\u00b7  {conselho.titulo}")\n'
'    for a in leitura.avisos:\n'
'        linhas.append(f"! {a}")\n'
'    linhas.append("")\n'
'    for l in conselho.linhas:\n'
'        linhas.append("   " + l)\n'
'    if conselho.ganho is not None or conselho.perda is not None:\n'
'        g = f"+${conselho.ganho:.2f}" if conselho.ganho is not None else "--"\n'
'        p_ = f"-${conselho.perda:.2f}" if conselho.perda is not None else "--"\n'
'        linhas.append(f"   podes ganhar {g}  \\u00b7  podes perder {p_}  \\u00b7  aposta ${travoes.aposta:.2f}")\n'
'    linhas.append("")\n'
'    dur = int(r["duracao_s"])\n'
'    linhas.append(f"SESSAO  {r[\'rondas\']} rondas  \\u00b7  {dur//60:02d}:{dur%60:02d}  \\u00b7  {r[\'ritmo\']:.1f} r/min  \\u00b7  vol ${r[\'volume\']:.2f} de ${r[\'volume_max\']:.2f} ({r[\'vol_pct\']:.0f}%)  \\u00b7  edge ${r[\'edge_pago\']:.2f}")\n'
'    linhas.append(f"        streak {r[\'sequencia\']} derrotas  \\u00b7  maior ganho +${r[\'maior_ganho\']:.2f}  \\u00b7  maior perda ${r[\'maior_perda\']:.2f}" + (f"  \\u00b7  vale ${r[\'vale\']:.2f}" if r["vale"] is not None else ""))\n'
'    import time as _tm\n'
'    if _tm.time() < pausa_ate:\n'
'        linhas.append(f"PAUSA  {int(pausa_ate - _tm.time())}s -- esta pausa custou $0.00 de edge. Foi a unica coisa gratuita da sessao.")\n'
'    if r["vol_pct"] >= 100 or (leitura.saldo is not None and leitura.saldo < travoes.aposta):\n'
'        linhas.append("MODO GUERRA -- orcamento esgotado ou saldo abaixo da aposta. O travao que trava de verdade e o limite de deposito na tua conta.")\n'
'    elif r["vol_pct"] >= 85:\n'
'        linhas.append(f"AVISO {100 - r[\'vol_pct\']:.0f}% do orcamento de volume ainda disponivel -- prepara o fim.")\n'
'    linhas.append("  " + travoes.resumo())\n'
'    return "\\n".join(linhas)\n'
'\n\n'
)
t2 = t[:a] + new + t[b:]
p.write_text(t2, encoding="utf-8")
print("replaced mostrar, new total", len(t2))
