"""vigia-500.py — ler o csgo500 pelos OLHOS, e cobrar disciplina. Nunca clica em nada.

    python vigia-500.py                     # UM COMANDO: faz o que falta e começa a vigiar

Os passos separados continuam a existir para quando se quer mandar só uma coisa:

    python vigia-500.py calibrar            # apontar para o saldo, o mult, as minas e a grelha
    python vigia-500.py aprender            # responder uma vez por campo ao que está escrito nele
    python vigia-500.py ver                 # ver o que ele vê, desenho a desenho
    python vigia-500.py ler --png foto.png  # ler uma imagem e dizer o que viu (sem tocar no site)
    python vigia-500.py vigiar              # modo de sessão: lê de 900 em 900 ms e cobra espera

O QUE ISTO É: um leitor de ecrã + o mesmo motor de disciplina do HUD. Recebe pixels, devolve
conselho. Não tem API nenhuma do casino, não conhece selectores, não envia um único clique — é por
isso que o site pode mudar de HTML quantas vezes quiser que isto continua a ver o mesmo número.

O QUE ISTO NÃO É: não é um bot. Não aposta, não abre casas, não retira. Esse clique é teu, e é o
único acto que este projecto nunca automatiza.

POUPAR RECURSOS, que é uma decisão de desenho e não um detalhe: um só processo (o modo `tudo` não
lança subprocessos nem deixa ficheiros a meio), UMA captura por leitura — da caixa que contém as
regiões, ou uma por região quando a soma das regiões é muito menor do que a caixa —, um `mss` por
processo em vez de um por captura, e nada de ler o ecrã inteiro quando se precisa de quatro
números. Uma sessão deixada a correr ao lado do jogo tem de se notar o menos possível.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import sys
import threading
import time
from typing import Callable

import cv2
import numpy as np

from vigia_motor import Leitura, Travoes, recomendar, reverso_casas, rotacao
from vigia_visao import (PASTA_GLIFOS, Mapa, abrir_imagem, aprender_por_texto, aprender_tabuleiro,
                         caixa_da_grelha, caixa_do_texto, capturar_regiao, desenhar_leitura,
                         ler_linha, ler_numero_estavel, ler_tabuleiro, recortar, segmentar,
                         uniao_de_regioes)

try:
    import vigia_debug
    _HAS_DEBUG = True
except ImportError:
    vigia_debug = None  # type: ignore
    _HAS_DEBUG = False

def _dbg(tag, msg, *a, **kw):
    if _HAS_DEBUG and vigia_debug is not None and getattr(vigia_debug, "activo", lambda: False)():
        vigia_debug.log(tag, msg, *a, **kw)

# Regiões que o programa sabe ler. `tabuleiro` é opcional mas é o que permite CONFERIR o número
# de casas abertas por duas vias independentes (as células e o multiplicador).
REGIOES = {
    "saldo": "o NÚMERO do saldo (só o número, sem o cartão nem o rótulo)",
    "multiplicador": "o texto do multiplicador no ecrã (ex.: «1.29x»)",
    "minas": "o número de minas escolhido (ex.: o «3» da caixa)",
    "tabuleiro": "a GRELHA das minas inteira (as 25 casas)",
}


# ============================== ARRANQUE ==============================
def preparar_consola() -> None:
    """A consola do Windows é cp1252 por defeito e rebenta a imprimir «−» ou «✓»."""
    for fluxo in (sys.stdout, sys.stderr):
        try:
            fluxo.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def preparar_dpi() -> None:
    """Sem isto, `mss` devolve pixels FÍSICOS e o tkinter pixels LÓGICOS.

    Num ecrã a 125% as duas medidas divergem 25%, e as regiões da calibração ficariam todas
    deslocadas — um erro que parece «o programa lê o sítio errado» e não tem nada a ver com leitura.
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)      # per-monitor v2
    except Exception:
        try:
            import ctypes
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def origem_do_ecra() -> tuple[int, int, int, int]:
    """O canto e o tamanho do ecrã virtual (o que `mss` captura quando não se dá região)."""
    _dbg("core.origem_do_ecra", "IN")
    import mss
    with mss.mss() as sct:
        m = sct.monitors[0]
        _dbg("core.origem_do_ecra", "monitors[0]=%r all=%r", m, getattr(sct, "monitors", None))
    out = (int(m["left"]), int(m["top"]), int(m["width"]), int(m["height"]))
    _dbg("core.origem_do_ecra", "OUT %r", out)
    return out


# ============================== GLIFOS DESCONHECIDOS ==============================
def _png_do_recorte(img: np.ndarray, zoom: int = 3) -> str:
    """Um recorte inteiro (não um glifo) em PNG/base64, ampliado e em tinta escura sobre branco."""
    _dbg("ia._png_do_recorte", "IN  img.shape=%r zoom=%d", getattr(img, "shape", None), zoom)
    grande = cv2.resize(img, (img.shape[1] * zoom, img.shape[0] * zoom),
                        interpolation=cv2.INTER_NEAREST)
    grande = 255 - cv2.cvtColor(grande, cv2.COLOR_BGR2GRAY)
    ok, buf = cv2.imencode(".png", cv2.cvtColor(grande, cv2.COLOR_GRAY2BGR))
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    _dbg("ia._png_do_recorte", "OUT %d chars ok=%s", len(b64), ok)
    return b64


def texto_do_campo(texto: str | None) -> str | None:
    _dbg("ia.texto_do_campo", "IN  %r", texto)
    """Valida a transcrição de um campo antes de a usar para aprender seja o que for.

    Regras mínimas e explícitas: no máximo 24 caracteres, só dígitos, letras, espaços, vírgulas e
    pontos. Uma resposta com aspas, linhas ou símbolos estranhos é uma resposta que não serve — e o
    pior que poderia acontecer aqui não é falhar: é aprender rótulos todos errados de uma vez.
    """
    if texto is None:
        _dbg("ia.texto_do_campo", "OUT None (input None)")
        return None
    t = texto.strip().strip("`'").strip()
    _dbg("ia.texto_do_campo", "  stripped -> %r", t)
    if t.upper().startswith("IGNORE"):
        _dbg("ia.texto_do_campo", "OUT '' (IGNORE)")
        return ""
    if not 1 <= len(t) <= 24:
        _dbg("ia.texto_do_campo", "OUT None (len %d fora 1..24) %r", len(t), t)
        return None
    if not all(c.isalnum() or c in " .," for c in t):
        _dbg("ia.texto_do_campo", "OUT None (chars invalidos) %r", t)
        return None
    _dbg("ia.texto_do_campo", "OUT %r", t)
    return t


def perguntador_texto_ia(modelo: str | None = None, endpoint: str | None = None,
                         pedir: Callable[[str], str | None] | None = None) -> callable:
    """A IA a transcrever o campo INTEIRO — uma pergunta por campo em vez de catorze.

    É o trabalho mais fácil que se pode pedir a um modelo de visão («lê este número»), e o
    resultado não fica a valer nada por si: só serve para preencher o dicionário, e só se a
    contagem de caracteres bater com a contagem de desenhos que o programa cortou. Se não bater,
    a resposta é deitada fora e as perguntas voltam a ser uma a uma.
    """
    pedir = pedir or cliente_ia(modelo, endpoint, prompt=PROMPT_CAMPO)

    def perguntar(img: np.ndarray) -> str | None:
        _dbg("ia.perguntador_texto_ia", "IN  img.shape=%r", getattr(img, "shape", None))
        try:
            b64 = _png_do_recorte(img)
            _dbg("ia.perguntador_texto_ia", "  a pedir IA  b64 len=%d", len(b64))
            texto = pedir(b64)
            _dbg("ia.perguntador_texto_ia", "  IA respondeu %r", texto)
        except Exception as e:
            _dbg("ia.perguntador_texto_ia", "  IA falhou", exc=e)
            print(f"  (a IA falhou a ler o campo: {type(e).__name__}: {str(e)[:60]})")
            return None
        out = texto_do_campo(texto)
        _dbg("ia.perguntador_texto_ia", "OUT %r", out)
        return out
    return perguntar


def perguntador_terminal() -> callable:
    """Pergunta no terminal, mostrando o DESENHO do glifo — adivinhar por um borrão é que não.

    O desenho sai em texto no próprio terminal (rampa de cinzentos), porque quem está a olhar para
    um terminal não vê imagens: sem isto, a pergunta «que carácter é este?» obrigava a abrir um
    ficheiro a cada glifo — e um professor que obriga a sair da conversa é um professor que se
    ignora. O PNG ampliado fica gravado em `glifos/<assinatura>_<rótulo>.png` quando a resposta é
    dada, que é onde a auditoria acontece.

    Enter devolve «ignora este glifo» (''), que é a resposta certa para a letra de «USD». Fica
    guardado como aprendido: nunca mais pergunta a mesma coisa.
    """
    def perguntar(g: dict) -> str | None:
        print(f"\n  glifo novo: {g['largura']}×{g['altura']} px, assinatura {g['assinatura']}")
        for linha in _ascii(g["bmp"], largura_max=72):
            print("   " + linha)
        try:
            r = input("  que carácter é? (0-9 , . ; Enter = ignorar; q = parar) ").strip()
        except EOFError:
            return None
        if r.lower() == "q":
            raise KeyboardInterrupt
        return r[:1] if r else ""
    return perguntar


PROMPT_GLIFO = ("This image contains a SINGLE character cropped from a casino's on-screen number. "
                "Reply with exactly that one character and nothing else. If it is not a digit, a "
                "comma or a period, reply with the single letter IGNORE.")

# O segundo trabalho da IA, e o mais fácil para ela: transcrever o CAMPO INTEIRO de uma vez.
# Uma pergunta por campo em vez de uma por desenho — e, se a contagem não bater com o que o
# programa cortou, a resposta é recusada e as perguntas voltam a ser uma a uma.
PROMPT_CAMPO = ("This image is a small crop of a casino's on-screen interface. Reply with exactly "
                "the text printed in it (digits, commas, periods, letters, spaces) and nothing "
                "else. If there is no text at all, reply with the single word IGNORE.")


def _png_do_glifo(g: dict) -> str:
    _dbg("ia._png_do_glifo", "IN  sig=%r %dx%d", g.get("assinatura"), g.get("largura"), g.get("altura"))
    """O glifo em PNG/base64, ampliado 6× e com tinta ESCURA sobre fundo BRANCO.

    O recorte vem em tinta clara sobre preto (é assim que o texto está no ecrã). Invertê-lo aqui
    não é cosmética: é a diferença entre perguntar a um modelo o que está numa imagem e perguntar-
    -lhe o que está no negativo dela.
    """
    grande = cv2.resize(g["bmp"], (g["bmp"].shape[1] * 6, g["bmp"].shape[0] * 6),
                        interpolation=cv2.INTER_NEAREST)
    grande = 255 - grande
    ok, buf = cv2.imencode(".png", cv2.cvtColor(grande, cv2.COLOR_GRAY2BGR))
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    _dbg("ia._png_do_glifo", "OUT %d chars ok=%s", len(b64), ok)
    return b64


def rotulo_da_resposta(texto: str | None) -> str | None:
    _dbg("ia.rotulo_da_resposta", "IN  %r", texto)
    """Traduz a resposta de um modelo em rótulo de dicionário — ou em «não serve».

    A parte que importa: uma resposta que NÃO é um carácter só não é uma resposta. Um modelo
    conversador que escreva «The character is 3.» não pode ser lido como «ignora este glifo» —
    seria gravar para sempre que aquele desenho não é nada, e o dígito desaparecia do saldo em
    silêncio. Quando a resposta não é utilizável devolve None, e a pergunta passa para ti.
    """
    if texto is None:
        _dbg("ia.rotulo_da_resposta", "OUT None (None)")
        return None
    r = texto.strip().strip("`'\"").strip()
    _dbg("ia.rotulo_da_resposta", "  stripped -> %r", r)
    if r.upper().startswith("IGNORE"):
        _dbg("ia.rotulo_da_resposta", "OUT '' (IGNORE)")
        return ""                      # «não é número»: ignora-se
    if len(r) != 1:
        _dbg("ia.rotulo_da_resposta", "OUT None (len!=1) %r", r)
        return None                    # resposta utilizável: um carácter, e só um
    if r.isdigit():
        _dbg("ia.rotulo_da_resposta", "OUT %r (digito)", r)
        return r
    if r in (",", "."):
        _dbg("ia.rotulo_da_resposta", "OUT %r (pontuacao)", r)
        return r
    if r.isalpha():
        _dbg("ia.rotulo_da_resposta", "OUT '' (letra -> ignorar)")
        return ""                      # uma letra não faz parte de um número
    _dbg("ia.rotulo_da_resposta", "OUT None (char invalido) %r", r)
    return None


def _perguntar_anthropic(b64: str, modelo: str, _endpoint: str | None,
                         prompt: str = PROMPT_GLIFO) -> str:
    import anthropic
    cli = anthropic.Anthropic()
    r = cli.messages.create(
        model=modelo, max_tokens=32,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": b64}},
            {"type": "text", "text": prompt}]}])
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text")


def _perguntar_openai(b64: str, modelo: str, endpoint: str | None,
                      prompt: str = PROMPT_GLIFO) -> str:
    from openai import OpenAI
    cli = OpenAI(base_url=endpoint) if endpoint else OpenAI()
    r = cli.chat.completions.create(
        model=modelo, max_tokens=32,
        messages=[{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}}]}])
    return r.choices[0].message.content or ""


def cliente_ia(modelo: str | None = None, endpoint: str | None = None,
               prompt: str = PROMPT_GLIFO,
               avisar=print) -> Callable[[str], str | None]:
    """O cliente de visão a usar, por ordem de preferência — e dito, nunca adivinhado.

    A ordem é: endpoint explícito (`--ia-endpoint`) -> Anthropic (é o que o Freebuff serve, e o
    modelo vem de ANTHROPIC_MODEL) -> qualquer serviço compatível com OpenAI. Cada um deles é
    tentado UMA vez; se nenhum responder, devolve-se None e as perguntas passam para o terminal.

    As chaves vêm só do ambiente. Este ficheiro não tem (nem precisa de ter) uma chave escrita.
    """
    _dbg("ia.cliente_ia", "IN  modelo=%r endpoint=%r prompt=%.40r", modelo, endpoint, prompt)
    m_anthropic = modelo or os.environ.get("ANTHROPIC_MODEL") or "claude-3-5-sonnet-latest"
    m_openai = modelo or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini"
    tentativas: list[tuple[str, Callable[..., str]]] = []
    if endpoint:
        tentativas.append((f"OpenAI-compatível em {endpoint} (modelo {m_openai})", _perguntar_openai))
    if os.environ.get("ANTHROPIC_API_KEY"):
        tentativas.append((f"Anthropic (modelo {m_anthropic})", _perguntar_anthropic))
    if os.environ.get("OPENAI_API_KEY"):
        tentativas.append((f"OpenAI (modelo {m_openai})", _perguntar_openai))
    if not tentativas:
        avisar("  (não há nenhuma IA configurada: falta ANTHROPIC_API_KEY ou OPENAI_API_KEY — "
               "pergunto-te a ti)")
        return lambda _b64: None
    # Dito por palavras no início: quem corre isto deve saber a QUEM está a mandar o desenho do
    # ecrã, em que ordem, e com que modelo. Um envio de imagem implícito é um envio de imagem que
    # ninguém autorizou.
    avisar("  IA configurada: " + "  →  ".join(nome for nome, _ in tentativas)
           + (f"  ·  via {os.environ['ANTHROPIC_BASE_URL']}"
              if os.environ.get("ANTHROPIC_BASE_URL") else ""))

    estado = {"falhados": set()}

    def pedir(b64: str) -> str | None:
        for nome, fn in tentativas:
            if nome in estado["falhados"]:
                continue
            try:
                texto = fn(b64, m_anthropic if fn is _perguntar_anthropic else m_openai, endpoint,
                           prompt)
                if texto is not None:
                    return texto
            except Exception as e:
                estado["falhados"].add(nome)
                avisar(f"  (a IA «{nome}» não respondeu: {type(e).__name__}: {str(e)[:70]})")
        return None
    return pedir


def perguntador_ia(modelo: str | None = None, endpoint: str | None = None,
                   pedir: Callable[[str], str | None] | None = None) -> callable:
    """Um leitor de IMAGEM por IA, para os glifos que ainda não estão aprendidos.

    Isto é o sítio certo para pôr uma IA a ler imagens, e vale a pena ser explícito sobre o
    porquê: um modelo de visão é bom a dizer «isto é um 3» sobre um recorte de 20×24 pixels — e é
    mau a ler o saldo inteiro de forma reprodutível. Portanto usa-se como PROFESSOR, uma vez por
    glifo, e não como leitor de todas as rondas. O resultado fica gravado no dicionário local e a
    partir daí a leitura é determinística, offline e auditável: a IA pode estar em baixo, a chave
    pode expirar, e o programa continua a ler o mesmo número.

    E se a resposta não for utilizável, o glifo NÃO fica aprendido: fica em falta e a pergunta
    segue para ti. É a diferença entre um professor e um oráculo.
    """
    pedir = pedir or cliente_ia(modelo, endpoint)

    def perguntar(g: dict) -> str | None:
        try:
            texto = pedir(_png_do_glifo(g))
        except Exception as e:              # qualquer cliente pode cair a meio
            print(f"  (a IA falhou: {type(e).__name__}: {str(e)[:70]} — pergunto-te a ti)")
            return None
        rotulo = rotulo_da_resposta(texto)
        if rotulo is None:
            print(f"  (a IA não deu uma resposta utilizável para o glifo {g['assinatura']} — "
                  f"pergunto-te a ti)")
        return rotulo
    return perguntar


def construir_perguntador(args) -> callable:
    _dbg("core.construir_perguntador", "IN  ia=%r sem_perguntas=%r", getattr(args, "ia", None), getattr(args, "sem_perguntas", None))
    """A ordem das perguntas diz o que se espera: primeiro a IA (rápida), depois tu."""
    if args.ia:
        ia = perguntador_ia(getattr(args, "ia_modelo", None), getattr(args, "ia_endpoint", None))
        humano = perguntador_terminal()

        def ambos(g):
            r = ia(g)
            if r is not None:
                print(f"  IA: o glifo {g['assinatura']} é «{r or 'ignorar'}»")
                return r
            return humano(g)
        return ambos
    return perguntador_terminal()


# ============================== CALIBRAÇÃO (a mira) ==============================
# O que se pede a cada região, na ordem em que se aponta. «Clica no NÚMERO» e não «desenha uma
# caixa»: apontar é o que uma pessoa faz naturalmente, e a caixa é a resposta a uma pergunta que o
# programa tem de saber responder sozinho (onde é que este texto começa e acaba).
PEDIDO = {
    "saldo": "aponta para o NÚMERO do saldo (clica mesmo em cima dele)",
    "multiplicador": "aponta para o MULTIPLICADOR no ecrã (ex.: 1.47x)",
    "minas": "aponta para o NÚMERO DE MINAS (o 3 da caixa)",
    "tabuleiro": "aponta para o CENTRO da casa do canto superior esquerdo",
}


def calibrar(mapa: Mapa, png: str | None = None) -> int:
    """Apontar, ver o que vai ser lido, e só então aceitar. Um ponto por região.

    Sem isto, tudo o resto é adivinhação: o programa não sabe onde está o saldo de uma página que
    nunca viu e — ao contrário do HUD no browser — não pode perguntar ao DOM. Pergunta-te a ti, que
    és a única autoridade sobre onde as coisas estão no TEU ecrã.

    A ordem dos gestos é deliberada e vale a pena dizê-lo: primeiro apontas, depois VÊS o recorte
    ampliado do que vai ser lido, e só no fim aceitas (Enter). Se a caixa saiu torta, arrastas: o
    arrasto continua a existir, mas como correcção — não como o gesto principal. Uma ferramenta em
    que se desenha às cegas e se descobre o erro três passos à frente ensina a desconfiar dela.
    """
    import tkinter as tk
    from PIL import Image, ImageTk

    if png:
        img = abrir_imagem(png)
        origem = (0, 0)
        tamanho_ecra = (img.shape[1], img.shape[0])
    else:
        ox, oy, lw, lh = origem_do_ecra()
        img = capturar_regiao(None)
        origem = (ox, oy)
        tamanho_ecra = (lw, lh)

    raiz = tk.Tk()
    raiz.title("vigia-500 · calibrar — aponta para o que queres que eu leia")
    ecra_w, ecra_h = raiz.winfo_screenwidth(), raiz.winfo_screenheight()
    escala = min(1.0, (ecra_w * 0.92) / img.shape[1], (ecra_h * 0.74) / img.shape[0])
    vis = cv2.resize(img, (int(img.shape[1] * escala), int(img.shape[0] * escala)))

    tela = tk.Canvas(raiz, width=vis.shape[1], height=vis.shape[0], highlightthickness=0,
                     cursor="crosshair")
    tela.pack()
    foto = ImageTk.PhotoImage(Image.fromarray(cv2.cvtColor(vis, cv2.COLOR_BGR2RGB)))
    tela.create_image(0, 0, anchor="nw", image=foto)
    tela.image = foto

    titulo = tk.Label(raiz, text="", font=("Segoe UI", 13, "bold"), anchor="w", justify="left",
                      bg="#141220", fg="#f5c451", padx=10, pady=6)
    titulo.pack(fill="x")
    rodape = tk.Frame(raiz, bg="#141220")
    rodape.pack(fill="x", padx=10, pady=6)
    vista = tk.Label(rodape, bg="#141220")
    vista.pack(side="left")
    detalhe = tk.Label(rodape, text="", font=("Consolas", 10), anchor="nw", justify="left",
                       bg="#141220", fg="#e8e6f0", padx=12, wraplength=520)
    detalhe.pack(side="left", fill="both", expand=True)

    fila = list(REGIOES.keys())
    feito: dict[str, list[int]] = dict(mapa.regioes)
    estado: dict = {"rect": None, "marca": None, "inicio": None, "proposta": None,
                    "primeiro": None, "escala": escala}

    def em_imagem(x: int, y: int) -> tuple[int, int]:
        return int(round(x / escala)), int(round(y / escala))

    def mostrar_proposta(caixa: list[int] | None, nota: str = ""):
        """Desenha a caixa proposta E mostra o recorte ampliado — ver antes de aceitar."""
        if estado["rect"]:
            tela.delete(estado["rect"])
            estado["rect"] = None
        if not caixa:
            return
        x, y, w, h = caixa
        estado["rect"] = tela.create_rectangle(x * escala, y * escala, (x + w) * escala,
                                              (y + h) * escala, outline="#3ddc97", width=2)
        recorte = recortar(img, caixa)
        zoom = max(1, min(6, 300 // max(1, recorte.shape[1]), 90 // max(1, recorte.shape[0])))
        grande = cv2.resize(recorte, (recorte.shape[1] * zoom, recorte.shape[0] * zoom),
                            interpolation=cv2.INTER_NEAREST)
        estado["preview"] = ImageTk.PhotoImage(Image.fromarray(cv2.cvtColor(grande,
                                                                         cv2.COLOR_BGR2RGB)))
        vista.config(image=estado["preview"])
        detalhe.config(text=f"vou ler isto: {w}×{h} px (ampliado {zoom}×)\n{nota}"
                            f"\n\nEnter aceita · arrasta para corrigir · clica noutro sítio para "
                            f"reapontar · Esc salta")

    def instruir():
        if not fila:
            titulo.config(text="Terminado. Fecha a janela (ou Enter).")
            detalhe.config(text="regiões guardadas:" + "\n" +
                                "\n".join(f"{k}: {v}" for k, v in feito.items()))
            return
        nome = fila[0]
        opcional = "  (opcional: Esc salta)" if nome != "saldo" else ""
        passo = f"PONTO {len(REGIOES) - len(fila) + 1}/{len(REGIOES)}"
        segunda = "  → agora a casa do canto INFERIOR direito" if (nome == "tabuleiro"
                                                                 and estado["primeiro"]) else ""
        titulo.config(text=f"{passo} · {nome.upper()}: {PEDIDO[nome]}{segunda}{opcional}")

    def apontar(e):
        """Um clique: apontar. Para o tabuleiro são dois (primeira e última casa)."""
        nome = fila[0]
        xi, yi = em_imagem(e.x, e.y)
        if nome == "tabuleiro":
            if estado["primeiro"] is None:
                estado["primeiro"] = (xi, yi)
                if estado["marca"]:
                    tela.delete(estado["marca"])
                estado["marca"] = tela.create_oval(e.x - 4, e.y - 4, e.x + 4, e.y + 4,
                                                   outline="#f5c451", width=2)
                instruir()
                return
            caixa = caixa_da_grelha(estado["primeiro"], (xi, yi), 5)
            estado["proposta"] = caixa
            mostrar_proposta(caixa, "grelha 5×5, pelas duas casas que apontaste")
            return
        caixa = caixa_do_texto(img, xi, yi)
        if caixa is None:
            detalhe.config(text="não vejo tinta nenhuma aí à volta. Clica mesmo em cima do texto. "
                                "(Esc salta esta região)")
            return
        estado["proposta"] = caixa
        mostrar_proposta(caixa, f"texto encontrado a partir do ponto ({xi}, {yi})")

    def ao_pressionar(e):
        if not fila:
            return
        estado["inicio"] = (e.x, e.y)
        if estado["rect"]:
            tela.delete(estado["rect"])
        estado["rect"] = tela.create_rectangle(e.x, e.y, e.x, e.y, outline="#ff5773", width=2)

    def ao_arrastar(e):
        if estado["inicio"] is None:
            return
        tela.coords(estado["rect"], estado["inicio"][0], estado["inicio"][1], e.x, e.y)

    def ao_soltar(e):
        """Clique ou arrasto? A distância decide — 4 px é a mão a tremer, não um gesto."""
        inicio, estado["inicio"] = estado["inicio"], None
        if inicio is None or not fila:
            return
        if max(abs(e.x - inicio[0]), abs(e.y - inicio[1])) < 4:
            apontar(e)
            return
        x0, y0 = min(inicio[0], e.x), min(inicio[1], e.y)
        x1, y1 = max(inicio[0], e.x), max(inicio[1], e.y)
        ix0, iy0 = em_imagem(x0, y0)
        ix1, iy1 = em_imagem(x1, y1)
        estado["proposta"] = [ix0, iy0, ix1 - ix0, iy1 - iy0]
        mostrar_proposta(estado["proposta"], "caixa desenhada à mão (arrasto)")

    def aceitar(_e=None):
        if not fila or not estado["proposta"]:
            if not fila:
                raiz.destroy()
            return
        nome = fila.pop(0)
        feito[nome] = list(estado["proposta"])
        estado["proposta"] = None
        estado["primeiro"] = None
        if estado["rect"]:
            tela.delete(estado["rect"])
            estado["rect"] = None
        if estado["marca"]:
            tela.delete(estado["marca"])
            estado["marca"] = None
        vista.config(image="")
        print(f"  {nome}: {feito[nome]}")
        instruir()

    def saltar(_e=None):
        if not fila:
            raiz.destroy()
            return
        nome = fila.pop(0)
        feito.pop(nome, None)
        estado["proposta"], estado["primeiro"] = None, None
        if estado["rect"]:
            tela.delete(estado["rect"])
            estado["rect"] = None
        vista.config(image="")
        print(f"  {nome}: saltado")
        instruir()

    tela.bind("<ButtonPress-1>", ao_pressionar)
    tela.bind("<B1-Motion>", ao_arrastar)
    tela.bind("<ButtonRelease-1>", ao_soltar)
    raiz.bind("<Return>", aceitar)
    raiz.bind("<space>", aceitar)
    raiz.bind("<Escape>", saltar)
    instruir()
    raiz.mainloop()

    mapa.regioes = {k: v for k, v in feito.items() if v}
    mapa.ecra = list(tamanho_ecra)
    if origem != (0, 0):
        mapa.origem = list(origem)
    caminho = mapa.guardar()
    print(f"regiões guardadas em {caminho}: {json.dumps(mapa.regioes, ensure_ascii=False)}")
    if png:
        print("NOTA: calibrei sobre um PNG — as coordenadas são as da IMAGEM. Para vigiar o ecrã, "
              "repete `calibrar` sobre o ecrã real.")
    return 0


# ============================== LEITURA ==============================
# Onde é que compensa capturar tudo numa caixa em vez de uma região de cada vez. Não é intuição:
# medido nesta máquina (2560×1440), uma captura a mais custa ~6 ms de overhead e copiar custa
# ~220 MB/s, portanto ~4,5 ms por MB. Com quatro regiões, o desperdício da caixa única compensa até
# ~4 MB (≈1,33 Mpx a 3 bytes por pixel); acima disso, ir buscar cada região por si é mais rápido.
# Nesta página: ecrã inteiro 11,1 MB e 50 ms; caixa única 1,48 MB e 12,5 ms; quatro recortes 0,24 MB
# e 25 ms — ou seja, a caixa única ganha, e era o contrário do que a minha primeira regra escolhia.
DESPERDICIO_ACEITAVEL = 1_333_333        # em pixéis, equivalentes a ~4 MB


def escolha_de_captura(regioes) -> tuple[str, list[int] | None]:
    """Uma captura da caixa que contém tudo, ou uma captura por região — o que for mais barato.

    O que se decide aqui é a diferença entre o que se copia e o que se precisa: uma captura só tem
    o overhead de uma chamada ao sistema, mas copia a caixa toda; quatro capturas copiam o mínimo e
    pagam o overhead quatro vezes.
    """
    caixa = uniao_de_regioes(regioes)
    if caixa is None:
        _dbg("core.escolha_de_captura", "OUT nada (sem caixa)")
        return "nada", None
    area_caixa = caixa[2] * caixa[3]
    area_soma = sum(int(r[2]) * int(r[3]) for r in regioes.values() if r and len(r) == 4)
    desperdicio = area_caixa - area_soma
    _dbg("core.escolha_de_captura", "caixa=%r area_caixa=%d soma=%d desperdicio=%d limite=%d", caixa, area_caixa, area_soma, desperdicio, DESPERDICIO_ACEITAVEL)
    if desperdicio <= DESPERDICIO_ACEITAVEL:
        _dbg("core.escolha_de_captura", "OUT caixa %r", caixa)
        return "caixa", caixa
    _dbg("core.escolha_de_captura", "OUT separado")
    return "separado", None


def capturar_regioes(mapa: Mapa) -> dict[str, np.ndarray]:
    """Os recortes que interessam, e só eles. É aqui que se poupa o ecrã inteiro."""
    _dbg("core.capturar_regioes", "IN  regioes=%r", getattr(mapa, "regioes", None))
    regioes = {k: v for k, v in mapa.regioes.items() if v}
    modo, caixa = escolha_de_captura(regioes)
    _dbg("core.capturar_regioes", "  modo=%r caixa=%r", modo, caixa)
    if modo == "nada":
        _dbg("core.capturar_regioes", "OUT {} (nada)")
        return {}
    if modo == "caixa":
        import time as _t
        _t0 = _t.perf_counter()
        img = capturar_regiao(caixa)
        dt = (_t.perf_counter()-_t0)*1000
        _dbg("core.capturar_regioes", "  captura caixa %.2f ms shape=%r", dt, getattr(img, "shape", None))
        ox, oy = caixa[0], caixa[1]
        out = {nome: recortar(img, [r[0] - ox, r[1] - oy, r[2], r[3]])
                for nome, r in regioes.items()}
        _dbg("core.capturar_regioes", "OUT %d recortes via caixa", len(out))
        return out
    out = {nome: capturar_regiao(r) for nome, r in regioes.items()}
    _dbg("core.capturar_regioes", "OUT %d recortes separados", len(out))
    return out


def recortes_de(mapa: Mapa, png: str | None = None) -> dict[str, np.ndarray]:
    """Os recortes das regiões: de um PNG (modo de ensaio) ou do ecrã (modo de sessão)."""
    _dbg("core.recortes_de", "IN  png=%r regioes=%r", png, getattr(mapa, "regioes", None))
    if png:
        _dbg("core.recortes_de", "  via PNG %r", png)
        img = abrir_imagem(png)
        _dbg("core.recortes_de", "  img.shape=%r", getattr(img, "shape", None))
        out = {nome: recortar(img, r) for nome, r in mapa.regioes.items() if r}
        _dbg("core.recortes_de", "OUT %d recortes de PNG", len(out))
        return out
    out = capturar_regioes(mapa)
    _dbg("core.recortes_de", "OUT %d recortes de ecrã", len(out))
    return out


def ler_tudo(mapa: Mapa, dic: Dicionario, perguntar, png: str | None = None,
             jogo: str | None = None, guardar_em: str | None = None,
             estavel: bool = True, recortes: dict | None = None) -> Leitura:
    """Lê o que estiver calibrado. O que não estiver calibrado fica em falta — não é inventado.

    `recortes` permite entregar já os recortes (a captura é a parte caras desta função, e o modo
    sessão faz capturas pequenas de propósito); sem ela, captura-se agora.
    """
    recortes = recortes if recortes is not None else recortes_de(mapa, png)
    leitura = Leitura(jogo=jogo or mapa.motor.get("jogo"))

    def avisar(r: dict | None, nome: str):
        """Um glifo por aprender não é um erro do programa: é uma conta que fica em aberto."""
        if r and r.get("desconhecidos"):
            leitura.avisos.append(f"{len(r['desconhecidos'])} glifo(s) de {nome} por aprender "
                                  f"— corre `aprender` (ou `ler --ia`) para os nomear")

    def campo(nome: str, tentativas: int = 1):
        recorte = recortes.get(nome)
        if recorte is None or recorte.size == 0:
            return None
        if tentativas > 1:
            def outro() -> np.ndarray:
                """Uma captura NOVA do mesmo campo — e `or` com arrays não serve: dá ValueError."""
                fresco = recortes_de(mapa, png).get(nome)
                return fresco if fresco is not None and fresco.size else recorte
            return ler_numero_estavel(outro, dic, tentativas=tentativas, perguntar=perguntar)
        return ler_linha(recorte, dic, perguntar)

    r_saldo = campo("saldo", 3 if estavel and not png else 1)
    if r_saldo:
        leitura.saldo = r_saldo.get("valor")
        leitura.saldo_cru = r_saldo.get("texto", "")
        if not r_saldo.get("ok", True):
            leitura.avisos.append(r_saldo.get("nota") or "não li o saldo com acordo entre leituras")
        elif r_saldo.get("nota"):
            leitura.avisos.append("saldo: " + r_saldo["nota"])
        avisar(r_saldo, "saldo")
        if guardar_em:
            desenhar_leitura(recorte, r_saldo, guardar_em)

    r_mult = campo("multiplicador")
    if r_mult:
        leitura.multiplicador = r_mult.get("valor")
        avisar(r_mult, "multiplicador")

    r_minas = campo("minas")
    if r_minas:
        if r_minas.get("valor") is not None:
            leitura.minas = int(round(r_minas["valor"]))
        avisar(r_minas, "nº de minas")

    _dbg("core.ler_tudo", "  saldo=%r minas=%r mult=%r", leitura.saldo, leitura.minas, leitura.multiplicador)
    recorte_tab = recortes.get("tabuleiro")
    _dbg("core.ler_tudo", "  tabuleiro recorte=%s ref=%s", "sim" if recorte_tab is not None else "None", "sim" if mapa.tabuleiro_ref else "None")
    if recorte_tab is not None and mapa.tabuleiro_ref:
        _dbg("core.ler_tudo", "  a ler tabuleiro")
        t = ler_tabuleiro(recorte_tab, mapa.tabuleiro_ref)
        leitura.casas_abertas = t["abertas"]
        # Um IMPOSSÍVEL é diferente de um desacordo: com N minas no tabuleiro nunca pode haver mais
        # de 25−N casas abertas. Se isto aparecer, o problema não está no jogo — está na referência
        # das casas (foi aprendida noutro ecrã, noutro zoom, ou com a grelha meio aberta), e o aviso
        # diz isso em vez de deixar o número passar como se fosse uma leitura.
        if leitura.minas and leitura.casas_abertas > 25 - leitura.minas:
            leitura.avisos.append(f"contei {leitura.casas_abertas} casas abertas com "
                                  f"{leitura.minas} minas — isso não é possível. A referência das "
                                  f"casas deve estar velha: re-aprende-a com a grelha TAPADA "
                                  f"(`tudo`, passo da grelha).")
    # A SEGUNDA medição do mesmo número, e é isto que dá valor ao ler o ecrã: o multiplicador
    # escrito no ecrã diz quantas casas estão abertas, e as células dizem-no também. Quando as
    # duas contas discordam, uma das duas leituras está errada — e o motor fica calado em vez de
    # recomendar em cima de um palpite.
    if leitura.multiplicador and leitura.minas:
        _dbg("core.ler_tudo", "  reverso_casas minas=%r mult=%r", leitura.minas, leitura.multiplicador)
        leitura.casas_por_mult = reverso_casas(leitura.minas, leitura.multiplicador,
                                               mapa.motor["edge"])
        _dbg("core.ler_tudo", "  -> casas_por_mult=%r", leitura.casas_por_mult)
    _dbg("core.ler_tudo", "OUT leitura=%r avisos=%r", leitura, leitura.avisos)
    return leitura


def mostrar(leitura: Leitura, conselho, travoes: Travoes, pausa_ate: float = 0.0) -> str:
    r = travoes.resumo_rico()
    linhas = ["", "=" * 68]
    if leitura.saldo is not None:
        pnl = r["pnl"]
        pnl_s = f"{pnl:+.2f}" if pnl is not None else "--"
        pnl_pct = f" ({r['pnl_pct']:+.1f}%)" if r["pnl_pct"] is not None else ""
        pico_s = f"  pico ${r['pico']:.2f}" if r["pico"] is not None else ""
        linhas.append(f"SALDO  ${leitura.saldo:.2f}  (lido \u00ab{leitura.saldo_cru}\u00bb)  \u00b7  P/L  ${pnl_s}{pnl_pct}{pico_s}")
    else:
        linhas.append(f"SALDO  --  (sem leitura)")
    linhas.append(f"JOGO  {leitura.jogo or '?' }  \u00b7  MULT  {('%.2fx' % leitura.multiplicador) if leitura.multiplicador else '--'}  \u00b7  MINAS  {leitura.minas if leitura.minas is not None else '--'}  \u00b7  CASAS  {leitura.casas if leitura.casas is not None else '--'}  (celulas:{leitura.casas_abertas} contas:{leitura.casas_por_mult})")
    caixa = travoes.CaixaAcao(conselho)
    linhas.append(f"CAIXA  \u25b6  {caixa}  \u00b7  {conselho.titulo}")
    for a in leitura.avisos:
        linhas.append(f"! {a}")
    linhas.append("")
    for l in conselho.linhas:
        linhas.append("   " + l)
    if conselho.ganho is not None or conselho.perda is not None:
        g = f"+${conselho.ganho:.2f}" if conselho.ganho is not None else "--"
        p_ = f"-${conselho.perda:.2f}" if conselho.perda is not None else "--"
        linhas.append(f"   podes ganhar {g}  \u00b7  podes perder {p_}  \u00b7  aposta ${travoes.aposta:.2f}")
    linhas.append("")
    dur = int(r["duracao_s"])
    linhas.append(f"SESSAO  {r['rondas']} rondas  \u00b7  {dur//60:02d}:{dur%60:02d}  \u00b7  {r['ritmo']:.1f} r/min  \u00b7  vol ${r['volume']:.2f} de ${r['volume_max']:.2f} ({r['vol_pct']:.0f}%)  \u00b7  edge ${r['edge_pago']:.2f}")
    linhas.append(f"        streak {r['sequencia']} derrotas  \u00b7  maior ganho +${r['maior_ganho']:.2f}  \u00b7  maior perda ${r['maior_perda']:.2f}" + (f"  \u00b7  vale ${r['vale']:.2f}" if r["vale"] is not None else ""))
    import time as _tm
    if _tm.time() < pausa_ate:
        linhas.append(f"PAUSA  {int(pausa_ate - _tm.time())}s -- esta pausa custou $0.00 de edge. Foi a unica coisa gratuita da sessao.")
    if r["vol_pct"] >= 100 or (leitura.saldo is not None and leitura.saldo < travoes.aposta):
        linhas.append("MODO GUERRA -- orcamento esgotado ou saldo abaixo da aposta. O travao que trava de verdade e o limite de deposito na tua conta.")
    elif r["vol_pct"] >= 85:
        linhas.append(f"AVISO {100 - r['vol_pct']:.0f}% do orcamento de volume ainda disponivel -- prepara o fim.")
    linhas.append("  " + travoes.resumo())
    return "\n".join(linhas)


# ============================== VIGILÂNCIA ==============================
def vigiar(mapa: Mapa, args) -> int:
    """O laço: ler, classificar a ronda pelo delta do saldo, e cobrar disciplina.

    A classificação por DELTA é a mesma ideia do HUD e não precisa de saber as regras do jogo:
    se o saldo desceu a aposta, foi derrota; se subiu, foi vitória. O site não tem de contar nada.

    Nota de arquitectura, porque aqui a maneira certa não é a óbvia: o tkinter não é seguro entre
    threads. O laço de leitura corre numa thread própria e comunica por uma fila; a janela vive no
    thread principal. Chamar `label.config()` de dentro do laço parecia funcionar — até deixar de
    funcionar, sem erro, a meio de uma sessão.
    """
    travoes = Travoes(orcamento=mapa.motor["orcamento"], edge=mapa.motor["edge"],
                      aposta=mapa.motor["aposta"])
    parar = threading.Event()
    painel = None
    if not args.sem_painel and not args.png:
        try:
            painel = _Painel()
        except Exception as e:
            print(f"(painel gráfico indisponível: {type(e).__name__}: {e} — sigo na consola)")
            painel = None
    if painel is None:
        _laco(mapa, args, None, parar, travoes)
        return 0
    trabalhadora = threading.Thread(target=_laco, args=(mapa, args, painel, parar, travoes),
                                    daemon=True)
    trabalhadora.start()
    try:
        painel.correr()
    except KeyboardInterrupt:
        pass
    parar.set()
    trabalhadora.join(timeout=3)
    return 0


def _laco(mapa: Mapa, args, painel, parar: threading.Event, travoes: Travoes) -> dict:
    """O coração do modo sessão. Devolve o resumo final (útil nos testes)."""
    _dbg("core._laco", "IN  args=%r painel=%s travoes=%r", vars(args) if hasattr(args, "__dict__") else args, bool(painel), travoes)
    dic = mapa.dicionario
    perguntar = construir_perguntador(args)
    passos = rotacao(mapa.motor["rotacao"], mapa.motor["edge"])
    saldo_anterior = None
    pausa_ate = 0.0
    indice = 0
    aviso = "vigia-500 a olhar para o ecrã. Fecha a janela (ou Ctrl+C) para parar. Não clico em nada."
    print(aviso)
    try:
        while not parar.is_set():
            if time.time() < pausa_ate:
                time.sleep(0.4)
                continue
            leitura = ler_tudo(mapa, dic, perguntar, args.png, jogo=mapa.motor.get("jogo"),
                               guardar_em=(os.path.join("capturas", "saldo_lido.png")
                                           if args.depurar else None))
            mapa.guardar_dicionario(dic)
            conselho = recomendar(leitura, mapa.motor["aposta"], mapa.motor["orcamento"],
                                  mapa.motor["edge"], passos, indice)
            _dbg("core._laco", "  leitura saldo=%r anterior=%r", leitura.saldo, saldo_anterior)
            if leitura.saldo is not None and saldo_anterior is not None:
                delta = leitura.saldo - saldo_anterior
                _dbg("core._laco", "  delta=%.4f", delta)
                if abs(delta) > 1e-9:
                    resultado = _classificar(delta, mapa.motor["aposta"])
                    _dbg("core._laco", "  classificado -> %r  aposta=%.2f", resultado, mapa.motor["aposta"])
                    ordem = travoes.registar(resultado, saldo=leitura.saldo, delta=delta)
                    _dbg("core._laco", "  travoes -> %r", ordem)
                    indice = (indice + 1) % len(passos) if passos else 0
                    print(f"  ronda {travoes.rondas}: {resultado} "
                          f"({'+' if delta >= 0 else ''}{delta:.2f})")
                    for o in ordem["ordens"]:
                        print(f"  ⏸ {o['tipo']}: {o['porque']}")
                        _dbg("core._laco", "  ordem %r", o)
                        if o["tipo"] in ("micro-pausa", "cooldown-derrotas", "cooldown-ganho"):
                            pausa_ate = time.time() + o["segundos"]
                            if painel:
                                painel.publicar({"tipo": "mensagem", "texto":
                                                 f"⏸ {o['tipo']} — {o['porque']}"})
                        if o["tipo"] == "fim":
                            pausa_ate = float("inf")
                            print("  ⛔ MODO GUERRA — orçamento/saldo esgotado. O travão que trava de verdade é o limite de depósito na tua conta.")
                            if painel:
                                painel.publicar({"tipo": "mensagem", "texto": "⛔ MODO GUERRA — fecha a sessão"})
            if leitura.saldo is not None:
                saldo_anterior = leitura.saldo
            if painel:
                r2 = travoes.resumo_rico()
                caixa = travoes.CaixaAcao(conselho)
                pnl_s = f"{r2['pnl']:+.2f}" if r2['pnl'] is not None else "--"
                saldo_txt = f"saldo ${leitura.saldo:.2f}  P/L ${pnl_s}" if leitura.saldo is not None else "saldo —"
                if r2["pnl_pct"] is not None:
                    saldo_txt += f" ({r2['pnl_pct']:+.1f}%)"
                painel.publicar({"tipo": "estado", "titulo": conselho.titulo,
                                 "ok": conselho.ok, "linhas": _linhas_painel(leitura, conselho, travoes, pausa_ate),
                                 "caixa": caixa, "saldo_txt": saldo_txt,
                                 "vol_pct": r2["vol_pct"], "ritmo": r2["ritmo"],
                                 "em_pausa": time.time() < pausa_ate, "pausa_secs": max(0, int(pausa_ate - time.time())) if pausa_ate else 0})
            else:
                print(mostrar(leitura, conselho, travoes, pausa_ate))
            time.sleep(args.intervalo)
    except KeyboardInterrupt:
        print("\nfim a pedido. " + travoes.resumo())
    finally:
        mapa.guardar_dicionario(dic)
    return {"rondas": travoes.rondas, "volume": travoes.volume, "resumo": travoes.resumo()}


def _linhas_painel(leitura: Leitura, conselho, travoes: Travoes, pausa_ate: float) -> list[str]:
    r = travoes.resumo_rico()
    caixa = travoes.CaixaAcao(conselho)
    pnl_s = f"{r['pnl']:+.2f}" if r['pnl'] is not None else "--"
    # linha compacta para a janela pequena: tem de caber
    linhas = [
        f"saldo ${leitura.saldo:.2f}  P/L {pnl_s}  caixa: {caixa}" if leitura.saldo is not None else f"saldo —  caixa: {caixa}",
        f"mult {('%.2fx' % leitura.multiplicador) if leitura.multiplicador else '—'}  minas {leitura.minas if leitura.minas is not None else '—'}  casas {leitura.casas if leitura.casas is not None else '—'}",
    ]
    if conselho.ganho is not None or conselho.perda is not None:
        g = f"+${conselho.ganho:.2f}" if conselho.ganho is not None else "--"
        p_ = f"-${conselho.perda:.2f}" if conselho.perda is not None else "--"
        linhas.append(f"ganhas {g}  perdes {p_}  aposta ${travoes.aposta:.2f}")
    if time.time() < pausa_ate:
        linhas.append(f"⏸ EM PAUSA {int(pausa_ate - time.time())}s — $0.00 de edge")
    # só 4 linhas de conselho cabem no painel pequeno
    linhas += ["· " + l for l in conselho.linhas[:3]]
    linhas += ["⚠ " + a for a in leitura.avisos[:1]]
    # barra de volume + ritmo
    dur = int(r["duracao_s"])
    linhas.append(f"{r['rondas']}r  {dur//60:02d}:{dur%60:02d}  {r['ritmo']:.1f}r/m  vol {r['vol_pct']:.0f}%  edge ${r['edge_pago']:.2f}")
    if r["vol_pct"] >= 100 or (leitura.saldo is not None and leitura.saldo < travoes.aposta):
        linhas.append("⛔ MODO GUERRA — só leitura")
    linhas.append(travoes.resumo())
    return linhas


def _classificar(delta: float, aposta: float) -> str:
    _dbg("core._classificar", "IN  delta=%.4f aposta=%.2f", delta, aposta)
    if delta < 0:
        _dbg("core._classificar", "OUT lose")
        return "lose"
    if abs(delta) < 1e-9:
        _dbg("core._classificar", "OUT push")
        return "push"
    if delta >= aposta * 0.5:
        _dbg("core._classificar", "OUT win (>=0.5 aposta)")
        return "win"
    _dbg("core._classificar", "OUT win (<0.5 aposta mas positivo)")
    return "win"


class _Painel:
    """Uma janela pequena, sempre por cima, com o essencial — e botões de disciplina.

    Não é enfeite: o programa corre ao lado do casino, e a informação que interessa tem de estar
    visível sem se mudar de janela. Os botões não tocam no site nenhum: registam decisões tuas,
    exactamente como no HUD — e é essa a linha que este projecto não atravessa.

    Vive no thread principal e só conversa com o laço por uma FILA. O laço de leitura nunca toca
    num widget: o tkinter não é seguro entre threads, e o modo de falha disso é uma janela que
    congela sem dizer nada.
    """

    def __init__(self):
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
        self.raiz.protocol("WM_DELETE_WINDOW", self.fechar)
        # 250 ms chega e sobra para uma etiqueta de texto: a 120 ms o painel acordava oito vezes
        # por segundo para não mudar nada. Uma sessão de horas é feita destes pequenos nadas.
        self.raiz.after(250, self._poll)

    # --- chamado PELO LAÇO (noutra thread): só mete na fila ---
    def publicar(self, evento: dict) -> None:
        self.fila.put(evento)

    # --- tudo o que mexe em widgets corre AQUI, no thread da janela ---
    def _poll(self) -> None:
        try:
            while True:
                self._aplicar(self.fila.get_nowait())
        except queue.Empty:
            pass
        self.raiz.after(250, self._poll)

    def _aplicar(self, ev: dict) -> None:
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
                self.ritmo_var.set(f"{ev['ritmo']:.1f} r/min")
            # overlay de pausa (bloqueia visualmente)
            em_pausa = time.time() < self.pausa_ate or ev.get("em_pausa")
            if em_pausa:
                if self._overlay is None:
                    self._overlay = self.tk.Label(self.raiz, text="", font=("Segoe UI", 11, "bold"),
                                                  bg="#1a0a0a", fg="#ff6b6b", wraplength=420,
                                                  padx=12, pady=12)
                secs = int(self.pausa_ate - time.time()) if self.pausa_ate > time.time() else int(ev.get("pausa_secs", 0))
                motivo = ev.get("pausa_motivo", "pausa")
                self._overlay.config(text=f"⏸ EM PAUSA {max(0,secs)}s\n{motivo}\nEsta pausa custou $0.00 de edge. Foi a única coisa gratuita da sessão.")
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
                prefix = f"EM PAUSA: {int(self.pausa_ate - time.time())}s\n"
            self.corpo.config(text=prefix + "\n".join(ev.get("linhas", [])))
        elif ev.get("tipo") == "mensagem":
            txt = ev.get("texto", "")
            print("  " + txt)
            # mensagens de pausa/guerra também disparam overlay
            if "⏸" in txt or "⛔" in txt:
                secs = 0
                try:
                    import re as _re
                    m = _re.search(r"(\d+)s", txt)
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
                    self._estado_cache["pausa_secs"] = secs

    def pedir_pausa(self) -> None:
        self.pausa_ate = time.time() + 45
        print("  pausa voluntária de 45s registada")

    def impulso(self) -> None:
        print("  impulso registado, não seguido. É a jogada mais barata da sessão ($0.00).")

    def correr(self) -> None:
        self.raiz.mainloop()

    def fechar(self) -> None:
        try:
            self.raiz.destroy()
        except Exception:
            pass


# ============================== COMANDOS ==============================
def _ascii(img: np.ndarray, largura_max: int = 108) -> list[str]:
    """O recorte desenhado em TEXTO. É a forma de se poder ver o que ele está a olhar sem abrir
    nada: um leitor de ecrã que não se consegue inspeccionar não é uma ferramenta.

    A rampa vai do escuro ao claro, portanto a tinta brilhante aparece como «@» e o fundo como
    espaço. """
    cinza = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = cinza.shape
    escala = max(1, -(-w // largura_max), -(-h // 34))
    if escala > 1:
        cinza = cv2.resize(cinza, (max(1, w // escala), max(1, h // escala)),
                           interpolation=cv2.INTER_AREA)
    baixo, alto = float(cinza.min()), float(cinza.max())
    rampa = " .:-=+*#%@"
    largura = max(1e-9, alto - baixo)
    return ["|" + "".join(rampa[min(9, int((float(v) - baixo) / largura * 9.999))] for v in linha) + "|"
            for linha in cinza]


def o_que_falta(mapa: Mapa, dic: Dicionario, recortes: dict | None = None) -> list[str]:
    """Os passos de preparação que ainda faltam — é esta a única decisão do comando `tudo`.

    Existe como função separada porque é uma pergunta sobre o ESTADO («o que já está feito?») e não
    sobre o ecrã: assim pode ser testada sem abrir janela nenhuma, e o `tudo` fica só com a cola.
    """
    if not mapa.regioes:
        return ["regioes"]
    faltas = []
    if recortes:
        # Só as regiões que estão MESMO calibradas: uma região que não existe no mapa não tem
        # desenhos nenhuns para aprender, e contá-la faria o `tudo` abrir a aprendizagem para nada.
        for nome in ("saldo", "multiplicador", "minas"):
            if nome not in mapa.regioes:
                continue
            recorte = recortes.get(nome)
            if recorte is None or recorte.size == 0:
                continue
            if any(dic.get(g["assinatura"]) is None for g in segmentar(recorte)):
                faltas.append("glifos")
                break
    if mapa.regioes.get("tabuleiro") and not mapa.tabuleiro_ref:
        faltas.append("referencia")
    _dbg("core.o_que_falta", "OUT %r", faltas)
    return faltas


def comando_tudo(mapa: Mapa, args) -> int:
    """O único comando que é preciso decorar: faz o que falta e depois vigia.

    Porquê juntar os passos: quatro comandos separados obrigam a saber a ordem deles de cor, e cada
    execução é um processo novo com os seus imports (o OpenCV sozinho custa quase um segundo). Aqui
    é um processo só, que pergunta apenas o que ainda não sabe — e que mostra a lista do que já
    está feito antes de começar, para não haver surpresas a meio de uma sessão.

    A ordem das perguntas é a ordem das dependências: sem regiões não se sabe onde ler; sem os
    desenhos aprendidos não se lê nada; e a referência das casas tapadas só faz sentido depois de a
    grelha estar calibrada (e com a grelha tapada, que é o estado em que ela existe).
    """
    _dbg("core.comando_tudo", "IN  args=%r", vars(args) if hasattr(args, "__dict__") else args)
    print("vigia-500 · um comando só. Vejo o que falta e trato disso antes de começar.")
    if not mapa.regioes:
        print("\n[1] Ainda não sei onde estão as coisas no teu ecrã. Aponta-me.")
        calibrar(mapa, args.png)
        if not mapa.regioes:
            print("Não ficou nenhuma região calibrada — sem isso não há nada a ler. Até à próxima.")
            return 2
        print(f"\n[1] pronto: {json.dumps(mapa.regioes, ensure_ascii=False)}")
    recortes = recortes_de(mapa, args.png)
    dic = mapa.dicionario
    faltas = o_que_falta(mapa, dic, recortes)
    if "glifos" in faltas:
        print("\n[2] Vou ensinar os desenhos que ainda não sei ler.")
        args.referencia_tabuleiro = False       # a referência é o passo [3], e é aqui que se controla
        comando_aprender(mapa, args)
        dic = mapa.dicionario
    if "referencia" in faltas:
        print("\n[3] A grelha das minas precisa de uma referência do estado TAPADO.")
        if args.png:
            mapa.tabuleiro_ref = aprender_tabuleiro(recortes["tabuleiro"])
            mapa.guardar()
            print("   (num PNG assumo que a grelha está como está; confirma com `ver`)")
        else:
            resposta = input("   A grelha está TODA TAPADA agora? [Enter = sim, guardo / n = agora "
                             "não] ").strip().lower()
            if resposta.startswith("n"):
                print("   Ficou sem referência: leio o multiplicador e não cruzo com as casas.")
            else:
                fresco = capturar_regioes(mapa)
                if "tabuleiro" in fresco:
                    mapa.tabuleiro_ref = aprender_tabuleiro(fresco["tabuleiro"])
                    mapa.guardar()
                    print("   Referência guardada.")
    if args.png:
        print("\n[4] Estou a ler um PNG (e não o ecrã), portanto faço UMA leitura e saio.")
        return comando_ler(mapa, args)
    print("\n[4] A vigiar. Fecha a janela (ou Ctrl+C) para parar. Não clico em nada.")
    return vigiar(mapa, args)


def comando_ver(mapa: Mapa, args) -> int:
    """Mostra o que o programa VÊ em cada região: números, glifos, caixas e cores.

    Existe porque um leitor que não se pode inspeccionar não é uma ferramenta — é uma caixa preta
    com opiniões. Quando uma leitura sai errada, a pergunta é sempre a mesma («o que é que ele
    está a olhar?»), e este comando responde com medidas em vez de com uma opinião.
    """
    _dbg("core.comando_ver", "IN  png=%r ascii=%r", getattr(args, "png", None), getattr(args, "ascii", None))
    recortes = recortes_de(mapa, args.png)
    os.makedirs("capturas", exist_ok=True)
    dic = mapa.dicionario
    print(f"dicionário: {len(dic)} glifo(s) aprendidos")
    for nome, regiao in mapa.regioes.items():
        recorte = recortes.get(nome)
        if recorte is None or recorte.size == 0:
            print(f"{nome}: FORA do ecrã (região {regiao}) — re-calibra esta região")
            continue
        cinza = recorte.mean(axis=2)
        print(f"\n{nome}: região {regiao} → recorte {recorte.shape[1]}×{recorte.shape[0]}")
        print(f"   cor média BGR {np.round(recorte.reshape(-1, 3).mean(axis=0), 1).tolist()}"
              f"   cinzentos {cinza.min():.0f}..{cinza.max():.0f}"
              f"   (amplitude {cinza.max() - cinza.min():.0f})")
        if cinza.max() - cinza.min() < 12:
            print("   ⚠ este recorte é quase liso: ou a região está deslocada, ou aqui não há nada "
                  "escrito. Re-calibra.")
        glifos = segmentar(recorte)
        if glifos:
            # Cada glifo com o RÓTULO que o dicionário lhe dá. É isto que se revê quando uma
            # leitura sai mal: não «o programa leu mal», mas «este desenho está registado como 0»
            # — uma frase sobre a qual se pode agir.
            print(f"   {len(glifos)} glifo(s):")
            for g in glifos[:14]:
                rotulo = dic.get(g["assinatura"])
                estado = ("por aprender" if rotulo is None else
                          ("(ignorado)" if rotulo == "" else f"= «{rotulo}»"))
                print(f"     [{g['x0']:>3}-{g['x1']:>3} {g['largura']:>2}×{g['altura']:>2}] "
                      f"{g['assinatura']}  {estado}")
            if len(glifos) > 14:
                print(f"     … e mais {len(glifos) - 14}")
        else:
            print("   nenhum glifo (texto) aqui")
        if getattr(args, "ascii", False):
            print("   desenho do recorte (tinta clara = @):")
            for linha in _ascii(recorte):
                print("   " + linha)
        if nome == "tabuleiro" and mapa.tabuleiro_ref:
            t = ler_tabuleiro(recorte, mapa.tabuleiro_ref)
            print(f"   casas: {t['abertas']} abertas, {t['minas']} minas, "
                  f"{t['estados'].count('fechada')} fechadas")
            print("   estado por linha: " + str([t["estados"][i * 5:(i + 1) * 5] for i in range(5)]))
        cv2.imwrite(os.path.join("capturas", f"{nome}.png"), recorte)
        if glifos:
            desenhar_leitura(recorte, {"glifos": glifos, "rotulos": ["?"] * len(glifos)},
                             os.path.join("capturas", f"{nome}_anotado.png"))
    print("\nrecortes guardados em capturas/ — abre-os e vê o que ele está mesmo a olhar.")
    return 0


def esquecer_glifos(dic, pasta: str = PASTA_GLIFOS) -> int:
    """Deita fora o dicionário aprendido e os PNGs que o documentam.

    Existe porque um dicionário pode ficar ERRADO sem ficar vazio: se o site mudar o zoom ou a
    fonte, as assinaturas antigas deixam de corresponder — e uma assinatura que ainda corresponda
    por acaso é uma leitura errada dita com confiança. Re-aprender do zero custa duas dúzias de
    perguntas uma vez; confiar num dicionário de outro ecrã custa dinheiro.
    """
    quantos = len(dic.rotulos)
    dic.rotulos.clear()
    try:
        for ficheiro in os.listdir(pasta):
            if ficheiro.lower().endswith(".png"):
                os.remove(os.path.join(pasta, ficheiro))
    except FileNotFoundError:
        pass
    return quantos


def revisao_de_tamanhos(rotulos: list, glifos: list[dict], tolerancia: float = 0.12,
                        px_minimos: int = 2) -> list[str]:
    """Avisos sobre rótulos que não podem estar certos: o MESMO carácter com dois tamanhos.

    Isto nasceu de um erro meu, e vale a pena contá-lo como ele foi: ao responder às perguntas com
    a lista de respostas deslocada por um lugar (uma pergunta a menos, porque dois «0» iguais
    partilham uma só assinatura), a letra «U» do «USD» ficou registada como «0». O programa passou
    a ler «5,000» — um número plausível **e errado**, lido com toda a confiança. Nenhum teste
    apanha isso, porque não há nada de ilegal no que ele fez.

    O que apanhava, e agora apanha sozinho: dentro de uma região há UMA fonte e UM tamanho, logo o
    mesmo carácter tem sempre a mesma caixa. «0» com 13×17 px e «0» com 17×16 px é uma contradição
    — não uma dúvida. O aviso não muda a leitura: diz-te para ires ver, que é a única coisa honesta
    a fazer quando os dados se contradizem.
    """
    caixas: dict[str, list[tuple[int, int, int]]] = {}
    for i, rotulo in enumerate(rotulos):
        if not rotulo or rotulo == "?" or i >= len(glifos):
            continue
        caixas.setdefault(rotulo, []).append((glifos[i]["largura"], glifos[i]["altura"], i))
    avisos = []
    # O critério é por DIFERENÇA e não por razão, e a diferença de 2 px é o chão: entre duas
    # capturas o mesmo carácter pode ganhar ou perder um pixel de antialiasing. A letra «U» vestida
    # de «0» media 17×16 contra 13×17 do «0» verdadeiro — 4 px de largura. É esse o tamanho de erro
    # que aqui interessa, e uma razão (1,31) escondia-o.
    for rotulo, lista in caixas.items():
        for eixo, nome in ((0, "largura"), (1, "altura")):
            medidas = sorted({c[eixo] for c in lista})
            if len(medidas) < 2:
                continue
            if medidas[-1] - medidas[0] > max(px_minimos, tolerancia * medidas[-1]):
                avisos.append(f"o «{rotulo}» aparece com {nome}s {medidas} px na mesma região — "
                              f"um carácter não muda de {nome}. Revê com `ver`.")
    return avisos


def comando_aprender(mapa: Mapa, args) -> int:
    """Pergunta UMA VEZ por campo o que está escrito — em vez de catorze vezes por glifo.

    A diferença não é de velocidade, é de acertar: ler «5,00 USD» no ecrã e escrevê-lo é uma coisa
    que uma pessoa faz sem pensar; responder catorze vezes «que carácter é este desenho?» é uma
    tarefa em que se erra — e um erro aqui grava um rótulo errado para sempre. As perguntas uma a
    uma continuam a existir (tecla `g`, ou quando a contagem não bate), mas como rede, não como
    caminho principal.
    """
    dic = mapa.dicionario
    if getattr(args, "esquecer", False):
        print(f"  esqueci {esquecer_glifos(dic)} glifo(s) aprendidos: vou re-aprender do zero")
        mapa.guardar_dicionario(dic)
    perguntar = construir_perguntador(args)
    ler_campo_ia = (perguntador_texto_ia(getattr(args, "ia_modelo", None),
                                        getattr(args, "ia_endpoint", None))
                    if getattr(args, "ia", False) else None)
    recortes = recortes_de(mapa, args.png)
    aprendidos = 0
    # O TABULEIRO fica de fora de propósito: ele não é texto, é cor. Ensinar-lhe os «?» das 25
    # casas enchia o dicionário de glifos que ninguém vai ler — e um dicionário com lixo é um
    # dicionário que ninguém confia.
    for nome in ("saldo", "multiplicador", "minas"):
        recorte = recortes.get(nome)
        if recorte is None or recorte.size == 0:
            continue
        aprendidos += aprender_regiao(recorte, dic, nome, args, perguntar, ler_campo_ia)
    if "tabuleiro" in mapa.regioes and args.referencia_tabuleiro:
        recorte = recortes.get("tabuleiro")
        if recorte is not None:
            mapa.tabuleiro_ref = aprender_tabuleiro(recorte)
            print("  tabuleiro: referência das 25 casas TAPADAS guardada")
    mapa.guardar_dicionario(dic)
    print(f"dicionário: {len(dic)} glifos aprendidos ({aprendidos} nesta passagem)")
    return 0


def aprender_regiao(recorte: np.ndarray, dic, nome: str, args, perguntar, ler_campo_ia) -> int:
    """Uma região: mostra o que vê, pergunta o texto todo, e só aprende se as contas baterem."""
    _dbg("core.aprender_regiao", "IN  nome=%r shape=%r dic=%d ia=%s", nome, getattr(recorte, "shape", None), len(dic), bool(ler_campo_ia))
    glifos = segmentar(recorte)
    if not glifos:
        print(f"  {nome}: nenhum texto aqui — a região está deslocada? (corre `ver`)")
        return 0
    faltam = [g for g in glifos if dic.get(g["assinatura"]) is None]
    if not faltam:
        print(f"  {nome}: já sei ler estes {len(glifos)} desenhos")
        return 0

    print(f"\n  {nome}: {len(glifos)} desenho(s), {len(faltam)} por aprender")
    for linha in _ascii(recorte, largura_max=96):
        print("   " + linha)

    texto = None
    if ler_campo_ia is not None:
        texto = ler_campo_ia(recorte)
        if texto is not None:
            print(f"  a IA leu «{texto}» neste campo")
        else:
            print("  (a IA não deu uma leitura utilizável deste campo — pergunto-te a ti)")
    if texto is None and not args.sem_perguntas and not args.glifo_a_glifo:
        try:
            texto = input("  o que está escrito aí? (tal e qual; `_` = desenho que não é número; "
                          "Enter = não sei; g = desenho a desenho) ").strip()
        except EOFError:
            texto = ""
        if texto.lower() in ("g", "glifo"):
            texto = None

    if texto is not None and texto != "":
        resultado = aprender_por_texto(glifos, texto)
        if resultado["erro"] is None:
            for g, rotulo in zip(glifos, resultado["rotulos"]):
                if rotulo is not None:
                    dic.aprender(g, rotulo)
            print(f"  {nome}: aprendi {resultado['aprendidos']} carácter(es) e "
                  f"{resultado['ignorados']} «não é número»")
            for aviso in revisao_de_tamanhos(resultado["rotulos"], glifos):
                print(f"  ⚠ {aviso}")
            return resultado["aprendidos"]
        print(f"  ⚠ {resultado['erro']}")
        print("  → vou perguntar desenho a desenho, que é a única forma de eu não adivinhar.")

    r = ler_linha(recorte, dic, perguntar)
    estado = "li «" + r["texto"] + "»" if r["texto"] else "não li nada"
    print(f"  {nome}: {estado}"
          + (f" → {r['valor']}" if r["valor"] is not None else ""))
    for aviso in revisao_de_tamanhos(r["rotulos"], r["glifos"]):
        print(f"  ⚠ {aviso}")
    return r["aprendidos"]


def comando_ler(mapa: Mapa, args) -> int:
    _dbg("core.comando_ler", "IN  png=%r jogo=%r sem_perguntas=%r", getattr(args, "png", None), getattr(args, "jogo", None), getattr(args, "sem_perguntas", None))
    dic = mapa.dicionario
    perguntar = construir_perguntador(args) if not args.sem_perguntas else None
    leitura = ler_tudo(mapa, dic, perguntar, args.png, jogo=args.jogo,
                       guardar_em=getattr(args, "depurar_imagem", None))
    mapa.guardar_dicionario(dic)
    passos = rotacao(mapa.motor["rotacao"], mapa.motor["edge"])
    conselho = recomendar(leitura, mapa.motor["aposta"], mapa.motor["orcamento"],
                          mapa.motor["edge"], passos, 0)
    travoes = Travoes(orcamento=mapa.motor["orcamento"], edge=mapa.motor["edge"],
                      aposta=mapa.motor["aposta"])
    print(mostrar(leitura, conselho, travoes))
    return 0


def construir_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="vigia-500", description="Lê o csgo500 pelos olhos e cobra disciplina. Nunca clica.")
    p.add_argument("comando", nargs="?", default="tudo",
                   choices=["tudo", "calibrar", "aprender", "ler", "ver", "vigiar"],
                   help="por omissão: `tudo` — faz o que falta e começa a vigiar")
    p.add_argument("--png", help="usa um PNG em vez do ecrã (calibrar/ler/aprender)")
    p.add_argument("--jogo", help="força o jogo (dice|mines): o programa não adivinha pelo URL")
    p.add_argument("--intervalo", type=float, default=0.9, help="segundos entre leituras")
    p.add_argument("--sem-painel", action="store_true", help="só consola, sem janela")
    p.add_argument("--sem-perguntas", action="store_true",
                   help="não pergunta glifos novos (deixa-os em falta)")
    p.add_argument("--ia", action="store_true",
                   help="usa um modelo de visão para ler o campo (e, se preciso, cada glifo)")
    p.add_argument("--ia-modelo", help="modelo de visão (por omissão: gpt-4o-mini / claude)")
    p.add_argument("--ia-endpoint", help="endpoint compatível com OpenAI")
    p.add_argument("--referencia-tabuleiro", action="store_true",
                   help="em `aprender`: guarda as 25 casas como estado TAPADO")
    p.add_argument("--esquecer", action="store_true",
                   help="em `aprender`: deita fora o dicionário e re-aprende do zero")
    p.add_argument("--glifo-a-glifo", action="store_true",
                   help="em `aprender`: pergunta desenho a desenho em vez de pedir o texto do campo")
    p.add_argument("--depurar", action="store_true", help="grava em capturas/ o que leu")
    p.add_argument("--ascii", action="store_true", help="em `ver`: desenha os recortes em texto")
    p.add_argument("--depurar-imagem", help="grava o recorte do saldo anotado neste caminho")
    p.add_argument("--debug", action="store_true", help="logs máximos em stderr + ficheiro capturas/vigia-debug.log")
    p.add_argument("--debug-file", help="ficheiro para logs de debug (implica --debug)")
    p.add_argument("--ficheiro", default="vigia-500.json", help="mapa a usar")
    return p


def main(argv: list[str] | None = None) -> int:
    preparar_consola()
    preparar_dpi()
    args = construir_parser().parse_args(argv)
    # debug máximo: liga antes de qualquer outra coisa
    if getattr(args, "debug", False) or getattr(args, "debug_file", None) or os.environ.get("VIGIA_DEBUG"):
        try:
            import vigia_debug
            alvo = getattr(args, "debug_file", None) or os.environ.get("VIGIA_DEBUG_FILE") or "capturas/vigia-debug.log"
            vigia_debug.activar(alvo)
            vigia_debug.log("core.main", "debug ATIVADO", extra={"args": vars(args), "pid": os.getpid(), "ficheiro": alvo})
        except Exception as e:
            print(f"[debug] falhou a ativar: {e}", file=sys.stderr)
    if getattr(args, "depurar", False):
        os.makedirs("capturas", exist_ok=True)
    _dbg("core.main", "IN  comando=%r args=%r", getattr(args, "comando", None), vars(args))
    # O mapa (e os glifos) vivem ao lado do programa, não do sítio de onde se chama o comando.
    # Sem isto, correr `python3 caminho/vigia-500.py ver` de outra pasta dava «ainda não há regiões
    # calibradas» — uma mensagem verdadeira e inútil, porque o mapa existia a três pastas dali.
    caminho_mapa = args.ficheiro
    if not os.path.exists(caminho_mapa):
        ao_lado = os.path.join(os.path.dirname(os.path.abspath(__file__)), caminho_mapa)
        if os.path.exists(ao_lado):
            print(f"(não há «{caminho_mapa}» nesta pasta; uso o que está ao lado do programa)")
            caminho_mapa = ao_lado
    mapa = Mapa.carregar(caminho_mapa)
    if args.comando == "calibrar":
        return calibrar(mapa, args.png)
    if args.comando == "tudo":
        return comando_tudo(mapa, args)
    if not mapa.regioes and os.path.exists(caminho_mapa):
        print(f"⚠ o mapa «{caminho_mapa}» existe mas não tem regiões: corre `calibrar` com "
              f"`--ficheiro {caminho_mapa}`.")
    if not mapa.regioes:
        print("Ainda não há regiões calibradas. Corre primeiro:  python vigia-500.py calibrar")
        return 2
    if getattr(mapa, "ecra", None) and not args.png:
        _, _, lw, lh = origem_do_ecra()
        if [lw, lh] != list(mapa.ecra):
            print(f"⚠ o ecrã era {mapa.ecra} na calibração e agora é {[lw, lh]}: as regiões podem "
                  f"estar deslocadas. Se ele leu mal, re-calibra.")
    if args.comando == "ver":
        return comando_ver(mapa, args)
    if args.comando == "aprender":
        return comando_aprender(mapa, args)
    if args.comando == "ler":
        return comando_ler(mapa, args)
    return vigiar(mapa, args)


if __name__ == "__main__":
    raise SystemExit(main())
