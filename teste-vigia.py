"""Testes do vigia-500 — sem ecrã, sem casino, sem rede.

    python teste-vigia.py

O que se testa, e porquê:
  [1] PARIDADE COM O JAVASCRIPT. O motor do vigia é um porte do motor do HUD. Dois motores para a
      mesma decisão divergem em silêncio, e aqui diverge a recomendação que decide dinheiro real.
      O teste corre `node ponte-motor.js` — o userscript VERDADEIRO — e compara número a número.
  [2] LEITURA DE GLIFOS. Imagens sintéticas com uma fonte fixa (o mesmo cenário do casino): o
      programa tem de aprender os glifos e ler «5,00» como 5.00 — e, com um glifo desconhecido,
      tem de devolver «?» e NÃO inventar um número.
  [3] TABULEIRO POR COR. 25 células desenhadas com 3 abertas e 1 mina: a leitura por cor tem de as
      contar. É esta contagem que permitiria ao motor detectar uma leitura errada.
  [4] O CRUZAMENTO. Multiplicador e células a dar números diferentes -> o motor CALA-SE.
  [5] TRAVÕES e parser de moeda, incluindo o sinal de menos U+2212 do site.
  [6] A IA COMO PROFESSORA DE GLIFOS, com um modelo de mentira no lugar da rede. O que se testa não
      é o modelo: é o CONTRATO dele — nomeia uma vez, nunca é chamado duas vezes pelo mesmo glifo,
      e uma resposta que não serve deixa o glifo em falta em vez de o aprender errado.
  [7] AS FIXTURES REAIS. PNGs de verdade da página (capturas/*.png) e o mapa `capturas/demo-vigia.json`:
      fim-a-fim, do pixel ao veredicto — e a prova de que a leitura por cor das casas se transfere
      de uma captura para OUTRA (a referência foi aprendida numa e aplicada nas outras).
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

import vigia_visao

from vigia_motor import (JOGOS, Leitura, Travoes, parse_moeda, recomendar, reverso_casas, rotacao,
                         texto_da_aposta)
from vigia_visao import (Dicionario, _resumo_celula, aprender_por_texto, aprender_tabuleiro,
                         caixa_da_grelha, caixa_do_texto, classificar_celula, ler_linha,
                         ler_tabuleiro, recortar, segmentar)

AQUI = os.path.dirname(os.path.abspath(__file__))
passou = 0
falhou = 0

# Os glifos que os testes aprendem vão para uma pasta TEMPORÁRIA, e não para a pasta de auditoria do
# projecto. Sem isto, correr os testes deixava em `glifos/` dezenas de desenhos da fonte sintética
# dos testes — ou seja, a pasta que serve para eu conferir o que ele aprendeu enchia-se de coisas
# que ele nunca vai ler. Uma auditoria que mente é pior do que não ter auditoria nenhuma.
PASTA_GLIFOS_TESTE = tempfile.mkdtemp(prefix="vigia-glifos-teste-")
vigia_visao.PASTA_GLIFOS = PASTA_GLIFOS_TESTE


def ok(nome: str, cond, extra=None):
    global passou, falhou
    if cond:
        passou += 1
        print("  ok   " + nome)
    else:
        falhou += 1
        print("  FALHA " + nome + (("  -> " + str(extra)) if extra is not None else ""))


def igual(nome: str, obtido, esperado):
    ok(nome, obtido == esperado, f"obtido {obtido!r}, esperado {esperado!r}")


def perto(nome: str, obtido, esperado, eps=1e-4):
    bom = obtido is not None and abs(obtido - esperado) < eps
    ok(nome, bom, f"obtido {obtido!r}, esperado {esperado!r}")


def seccao(t: str):
    print("\n" + t)


# ============================== FONTE E IMAGENS SINTÉTICAS ==============================
def fonte(tamanho: int):
    """Uma fonte monoespaçada de verdade, se existir; senão a de recurso do Pillow."""
    candidatos = ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
                  "/System/Library/Fonts/Menlo.ttc"]
    for caminho in candidatos:
        if os.path.exists(caminho):
            try:
                return ImageFont.truetype(caminho, tamanho)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size=tamanho)
    except TypeError:
        return ImageFont.load_default()


def desenhar_texto(texto: str, tamanho: int = 30, fundo=(27, 24, 38), cor=(61, 220, 151),
                   margem: int = 8) -> np.ndarray:
    """Uma imagem BGR com uma linha de texto — o mesmo cenário do saldo no ecrã."""
    f = fonte(tamanho)
    caixa = f.getbbox(texto)
    largura = caixa[2] - caixa[0]
    altura = caixa[3] - caixa[1]
    img = Image.new("RGB", (largura + 2 * margem, altura + 2 * margem), fundo)
    ImageDraw.Draw(img).text((margem - caixa[0], margem - caixa[1]), texto, font=f, fill=cor)
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def desenhar_tabuleiro(abertas: list[int], minas: list[int], lado: int = 300,
                       tamanho_celula: int = 56, espaco: int = 5) -> np.ndarray:
    """Uma grelha 5×5 com células tapadas, abertas e minas.

    As cores são as do mock do projecto, em BGR: tapada #232032, aberta #1f3b31, mina #3b1f27 com
    o ícone vermelho #ff5773 por cima. A da mina é escura com um símbolo claro — de propósito: é
    assim que ela aparece mesmo no ecrã, e um teste que desenhasse um vermelho garrido estaria a
    testar uma facilidade que não existe.
    """
    img = np.full((lado, lado, 3), (20, 18, 28), dtype=np.uint8)
    n = 5
    for i in range(25):
        linha, coluna = divmod(i, n)
        y0 = linha * (tamanho_celula + espaco)
        x0 = coluna * (tamanho_celula + espaco)
        if i in minas:
            img[y0:y0 + tamanho_celula, x0:x0 + tamanho_celula] = (39, 31, 59)      # BGR #3b1f27
            meio = tamanho_celula // 2
            img[y0 + meio - 8:y0 + meio + 8, x0 + meio - 8:x0 + meio + 8] = (115, 87, 255)
        elif i in abertas:
            img[y0:y0 + tamanho_celula, x0:x0 + tamanho_celula] = (49, 59, 31)      # BGR #1f3b31
        else:
            img[y0:y0 + tamanho_celula, x0:x0 + tamanho_celula] = (50, 32, 35)      # BGR #232032
    return img


# ============================== 1. PARIDADE COM O JAVASCRIPT ==============================
seccao("[1] Paridade com o motor do userscript (o JavaScript é a referência)")
ponte = None
try:
    r = subprocess.run(["node", "ponte-motor.js"], cwd=AQUI, capture_output=True, text=True,
                       encoding="utf-8", timeout=60)
    ponte = json.loads(r.stdout)
except Exception as e:
    ok("consegui correr node ponte-motor.js", False, f"{type(e).__name__}: {e}")

if ponte:
    ok("a ponte correu o userscript e devolveu dados", bool(ponte.get("versao")),
       ponte.get("versao"))
    for cru, esperado in ponte["parse"]:
        igual(f"parse({cru!r}) igual ao JavaScript", parse_moeda(cru), esperado)
    for item in ponte["rotacao"]:
        minhas = rotacao([" ".join(str(x) for x in ([item["game"].lower(), item["mult"]]
                                                    if item["game"] == "Dice"
                                                    else ["mines", item["mines"], item["tiles"]]))],
                         0.01)
        perto(f"rotação {item['label']}: multiplicador", minhas[0].mult, item["mult"], 1e-9)
        perto(f"rotação {item['label']}: probabilidade", minhas[0].chance, item["winChance"], 1e-9)
    for minas, mult, k in ponte["reversos"]:
        igual(f"reverso_casas({minas} minas, {mult}x) igual ao JavaScript", reverso_casas(minas, mult), k)
    for chave, meta in ((j["chave"], j) for j in ponte["jogos"]):
        igual(f"edge de {chave} igual ao HUD", JOGOS[chave]["edge"], meta["edge"])
    for v, esperado in ponte["textoDaAposta"]:
        igual(f"texto_da_aposta({v}) = {esperado!r}", texto_da_aposta(v), esperado)

# ============================== 2. LEITURA DE GLIFOS ==============================
seccao("[2] Leitura de números por glifos aprendidos (imagens sintéticas, fonte fixa)")
dic = Dicionario()

amostra = "0123456789,."
entrada = {}
for c in amostra:
    img = desenhar_texto(c)
    glifos = segmentar(img)
    if glifos:
        entrada[c] = glifos[0]
ok("cada carácter isolado é segmentado num glifo só",
   all(len(segmentar(desenhar_texto(c))) == 1 for c in "0123456789"), )
iguais = [c for c in "0123456789"]
assinaturas = {c: segmentar(desenhar_texto(c))[0]["assinatura"] for c in iguais}
ok("dígitos diferentes têm assinaturas diferentes", len(set(assinaturas.values())) == len(iguais),
   assinaturas)

ig = desenhar_texto("5,00")
g5a = segmentar(ig)[0]["assinatura"]
ig2 = desenhar_texto("5,00")
g5b = segmentar(ig2)[0]["assinatura"]
igual("o MESMO dígito em duas imagens dá a MESMA assinatura (é esta a base do dicionário)", g5a, g5b)

# aprende: os glifos são nomeados uma vez, e ficam sabidos para sempre.
# O que não estiver no texto (as letras de «USD», o logótipo da moeda) é respondido com '' —
# «ignora este glifo» — que é exactamente o que a pessoa fará no terminal.
def aprendiz_de(texto: str, tamanho: int = 30):
    conhecidos = {}
    for c in texto:
        glifos = segmentar(desenhar_texto(c, tamanho=tamanho))
        if len(glifos) == 1:
            conhecidos[glifos[0]["assinatura"]] = c

    def perguntar(g):
        return conhecidos.get(g["assinatura"], "")
    return perguntar


def aprendiz_estrito_de(texto: str, tamanho: int = 30):
    """Como o `aprendiz_de`, mas cala-se (None) sobre o que não sabe.

    A diferença não é cosmética e é a razão de existirem duas funções: responder "" é uma
    AFIRMAÇÃO («isto não é número, ignora») — o que a pessoa faz à letra do «USD» —, enquanto
    None é uma ignorância («não sei o que é isto»). Só a segunda deixa o glifo em falta.
    """
    conhecidos = {}
    for c in texto:
        glifos = segmentar(desenhar_texto(c, tamanho=tamanho))
        if len(glifos) == 1:
            conhecidos[glifos[0]["assinatura"]] = c
    return lambda g: conhecidos.get(g["assinatura"])

leitura = ler_linha(desenhar_texto("5,00"), dic, aprendiz_de("5,00"))
igual("leio «5,00» de uma imagem", leitura["texto"], "5,00")
igual("e o valor é 5.00", leitura["valor"], 5.0)

leitura_big = ler_linha(desenhar_texto("199 999,91 USD"), dic, aprendiz_de("199 999,91"))
igual("leio «199999,91» (o espaço dos milhares não é um glifo)", leitura_big["texto"], "199999,91")
igual("e o valor é 199999.91", leitura_big["valor"], 199999.91)

# um glifo que ninguém sabe: tem de ficar em falta, e o valor tem de ser None — nunca um número
# plausível inventado a partir de metade dos dígitos.
leitura_nova = ler_linha(desenhar_texto("7"), Dicionario(), None)
igual("glifo desconhecido sai como «?»", leitura_nova["texto"], "?")
igual("e o valor é None (não inventa)", leitura_nova["valor"], None)
ok("e o glifo desconhecido fica listado para se poder perguntar",
   len(leitura_nova["desconhecidos"]) == 1)

# «0.30» e «0,30»: o separador é um glifo como os outros, e o parser lida com os dois
for texto, esperado in (("0.30", 0.30), ("0,30", 0.30), ("1.29", 1.29)):
    d2 = Dicionario()
    r2 = ler_linha(desenhar_texto(texto, tamanho=26), d2, aprendiz_de(texto, 26))
    igual(f"leio «{texto}» no formato do site", r2["valor"], esperado)

# Consequência honesta do desenho, dita aqui para não surpreender ninguém: a assinatura é do
# DESENHO do glifo, portanto depende do tamanho. Se o site mudar o zoom, o programa volta a
# perguntar — em vez de ler o dígito errado em silêncio.
ok("o mesmo dígito noutro tamanho dá outra assinatura (mudar de zoom volta a perguntar)",
   segmentar(desenhar_texto("8", 30))[0]["assinatura"]
   != segmentar(desenhar_texto("8", 20))[0]["assinatura"])

# O BUG QUE FEZ ESTES TESTES NASCEREM. A segmentação já teve uma MORPH_CLOSE horizontal para
# religar hastes partidas; o que ela fazia era colar dígitos vizinhos num glifo só. O «0.30» saía
# como «0.» mais um bloco de 25 px de largura, e o parse devolvia 0.0 — um número PLAUSÍVEL e
# ERRADO. Um leitor que erra em silêncio é pior do que um que não lê: estes testes fixam a cura.
campo_largo = segmentar(desenhar_texto("0.30", tamanho=26))
igual("«0.30» são quatro glifos (o «3» e o «0» não se colam)", len(campo_largo), 4)
ok("e nenhum glifo tem largura de duas letras",
   max(g["largura"] for g in campo_largo) <= 14, [g["largura"] for g in campo_largo])

igual("uma linha de dez dígitos dá dez glifos",
      len(segmentar(desenhar_texto("1234567890", tamanho=26))), 10)
igual("e «199 999,91 USD» dá doze glifos (o espaço não é um glifo, as letras do USD são)",
      len(segmentar(desenhar_texto("199 999,91 USD", tamanho=30))), 12)

# MEIO NÚMERO NÃO É UM NÚMERO. Com o «9» por aprender, o texto lido é «1.2?» — e antes desta
# regra o valor saía 1.2, que é o número errado lido com confiança. Agora sai None.
parcial = ler_linha(desenhar_texto("1.29", tamanho=26), Dicionario(), aprendiz_estrito_de("1.2", 26))
igual("com um glifo por aprender, o valor é None (e não 1.2)", parcial["valor"], None)
ok("e o texto mostra o buraco em vez de o esconder", parcial["texto"].endswith("?"),
   parcial["texto"])
ok("e o programa diz que não leu o número todo", bool(parcial["nota"]), parcial.get("nota"))

# a mesma linha, agora com o «9» ensinado: o valor volta a existir
inteiro = ler_linha(desenhar_texto("1.29", tamanho=26), Dicionario(), aprendiz_de("1.29", 26))
igual("com todos os glifos ensinados, o valor volta a ser 1.29", inteiro["valor"], 1.29)
ok("e o resultado diz que está completo", inteiro["completo"] is True)

# ============================== 3. TABULEIRO E COR ==============================
seccao("[3] O tabuleiro lido por cor (sem OCR nenhum)")
tab_cheio = desenhar_tabuleiro([], [])
referencia = aprender_tabuleiro(tab_cheio)
estados = ler_tabuleiro(tab_cheio, referencia)
igual("com tudo tapado, nenhuma casa está aberta", estados["abertas"], 0)

tab_misto = desenhar_tabuleiro(abertas=[0, 6, 12], minas=[18])
misto = ler_tabuleiro(tab_misto, referencia)
igual("três casas abertas são contadas como três", misto["abertas"], 3)
igual("e a casa vermelha é lida como mina", misto["minas"], 1)
igual("a contagem total fecha com as 25 casas",
      misto["abertas"] + misto["minas"] + misto["estados"].count("fechada"), 25)

ruido = _resumo_celula(np.full((10, 10, 3), (51, 33, 36), dtype=np.uint8))
limpa = _resumo_celula(np.full((10, 10, 3), (50, 32, 35), dtype=np.uint8))
ok("uma cor com 1 nível de diferença ainda é «fechada» (o ruído não inventa casas abertas)",
   classificar_celula(ruido, limpa) == "fechada", classificar_celula(ruido, limpa))

# ============================== 4. O CRUZAMENTO E A RECOMENDAÇÃO ==============================
seccao("[4] Duas medições do mesmo número, e o que fazer quando discordam")
passos = rotacao(["mines 3 2"], 0.01)

leitura = Leitura(jogo="mines", saldo=5.0, minas=3, multiplicador=1.2857, casas_abertas=2,
                  casas_por_mult=2)
conselho = recomendar(leitura, 0.30, 5.0, 0.01, passos, 0)
igual("2 casas com o plano a pedir 2: RETIRAR", conselho.titulo, "RETIRAR")
ok("e a razão repete que a margem de 1% foi paga na entrada",
   any("ENTRADA" in l for l in conselho.linhas), conselho.linhas)

leitura_mais = Leitura(jogo="mines", saldo=5.0, minas=3, multiplicador=1.5, casas_abertas=4,
                       casas_por_mult=4)
igual("4 casas com o plano a pedir 2: FORA DO PLANO · RETIRAR",
      recomendar(leitura_mais, 0.30, 5.0, 0.01, passos, 0).titulo, "FORA DO PLANO · RETIRAR")

leitura_desacordo = Leitura(jogo="mines", saldo=5.0, minas=3, multiplicador=1.2857,
                            casas_abertas=5)
desacordo = recomendar(leitura_desacordo, 0.30, 5.0, 0.01, passos, 0)
igual("células e multiplicador a discordar: não há recomendação", desacordo.titulo,
      "LEITURA EM DESACORDO")
igual("e fica em «não sei» em vez de «abre» ou «retira»", desacordo.ok, None)
ok("e diz os dois números, para se poder corrigir o que está mal",
   any("5" in l and "2" in l for l in desacordo.linhas), desacordo.linhas)

sem_mult = recomendar(Leitura(jogo="mines", saldo=5.0, minas=3), 0.30, 5.0, 0.01, passos, 0)
igual("sem ler o multiplicador, o programa não inventa casas abertas", sem_mult.titulo,
      "SEM LEITURA DO MULTIPLICADOR")

igual("o Dice é tratado pelo que é (alvo do plano)",
      recomendar(Leitura(jogo="dice", saldo=5.0), 0.30, 5.0, 0.01, rotacao(["dice 1.10"]), 0).titulo,
      "APOSTAR 1.10x  ·  $0.30")
igual("e um jogo fora da estratégia é recusado, com o EV à frente",
      recomendar(Leitura(jogo="plinko", saldo=5.0), 0.30, 5.0, 0.01, passos, 0).ok, False)

# ============================== 5. TRAVÕES E PARSER ==============================
seccao("[5] Travões e parser de moeda")
t = Travoes(orcamento=5.0, edge=0.01, aposta=0.30)
igual("o orçamento é de dinheiro e o volume máximo é orçamento/edge", round(t.volume_maximo, 2), 500.0)
for _ in range(4):
    t.registar("lose")
ordens = t.registar("lose")["ordens"]
ok("cinco derrotas seguidas disparam o cooldown",
   any(o["tipo"] == "cooldown-derrotas" for o in ordens), ordens)

t2 = Travoes(orcamento=3.0, edge=0.01, aposta=1.0)
ok("o volume máximo é orçamento/edge, e é dito em dinheiro", round(t2.volume_maximo, 2), 300.0)
t2.volume = 255.0                     # 85% de 300: o aviso começa aqui
t2.registar("win")
aviso = t2.registar("win")["ordens"]
ok("passar 85% do orçamento de volume avisa", any(o["tipo"] == "aviso" for o in aviso), aviso)
t2.volume = 299.9                     # e chegar lá é o fim
final = t2.registar("win")["ordens"]
ok("e chegar ao fim do orçamento termina a sessão", any(o["tipo"] == "fim" for o in final), final)
ok("com o edge já pago somado", t2.registar("win")["edge_pago"] > 0)

t3 = Travoes(micro_cada=3, orcamento=100, edge=0.01, aposta=0.30)
t3.registar("win")
t3.registar("win")
micro = t3.registar("win")["ordens"]
ok("a micro-pausa aparece às 3 rondas configuradas",
   any(o["tipo"] == "micro-pausa" for o in micro), micro)

for entrada, esperado in (("5 805,80 USD", 5805.8), ("−3,50 USD", -3.5), ("1.234", 1234),
                          ("0,72 USD", 0.72), ("", None), ("abc", None)):
    igual(f"parse_moeda({entrada!r})", parse_moeda(entrada), esperado)

# ============================== 6. A IA COMO PROFESSORA ==============================
def carregar_vigia():
    """Carrega o `vigia-500.py` como módulo (o nome tem um hífen, logo não se importa pelo nome)."""
    spec = importlib.util.spec_from_file_location("vigia_500", os.path.join(AQUI, "vigia-500.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


seccao("[6] A IA como professora de glifos (o modelo aqui é de mentira, o contrato é a sério)")
vigia = carregar_vigia()

for cru, esperado in (("IGNORE", ""), (" 3 ", "3"), ("`3`", "3"), (",", ","), ("U", ""),
                      ("The character is 3.", None), ("", None), ("42", None), (None, None)):
    igual(f"resposta {cru!r} -> rótulo", vigia.rotulo_da_resposta(cru), esperado)

# O «modelo»: um dicionário de respostas indexado pelo PNG em base64 que lhe é enviado. Não é
# batota — é a única forma de testar o contrato sem rede, e prova o caminho todo (recorte -> PNG
# ampliado -> resposta -> rótulo -> dicionário).
respostas_ia = {}
for c in "0123456789,.":
    glifos_c = segmentar(desenhar_texto(c, tamanho=30))
    if len(glifos_c) == 1:
        respostas_ia[vigia._png_do_glifo(glifos_c[0])] = c

vistas: list[int] = []


def modelo(b64: str, resposta=""):
    vistas.append(1)
    return respostas_ia.get(b64, resposta)


d_ia = Dicionario()
r_ia = ler_linha(desenhar_texto("5,00"), d_ia, vigia.perguntador_ia(pedir=modelo))
igual("a IA nomeia os glifos e o número lê-se", r_ia["valor"], 5.0)
igual("e o que ela respondeu fica no dicionário (3 glifos, o «0» não conta duas vezes)",
      len(d_ia), 3)

vistas.clear()
r_ia2 = ler_linha(desenhar_texto("5,00"), d_ia, vigia.perguntador_ia(pedir=modelo))
igual("a segunda leitura não pergunta nada à IA (é este o ponto: ela é professora, não leitora)",
      len(vistas), 0)
igual("e lê o mesmo número", r_ia2["valor"], 5.0)

# Uma resposta que não serve não pode virar «ignora este glifo»: ficaria gravado para sempre que
# aquele desenho não é nada, e o dígito desapareceria do saldo em silêncio.
d_trapalhao = Dicionario()
r_trapalhao = ler_linha(desenhar_texto("7"), d_trapalhao,
                        vigia.perguntador_ia(pedir=lambda b64: "I think it is a 7"))
igual("resposta conversadora: o glifo fica em falta", r_trapalhao["valor"], None)
igual("e nada é aprendido de errado", len(d_trapalhao), 0)

# «IGNORE» é uma AFIRMAÇÃO («não é número») e é isso que a letra do «USD» merece.
d_letras = Dicionario()
r_letras = ler_linha(desenhar_texto("3x", tamanho=30), d_letras,
                     vigia.perguntador_ia(pedir=lambda b64: modelo(b64, resposta="IGNORE")))
igual("o que a IA não reconhece é ignorado, não perguntado", r_letras["valor"], 3.0)
igual("e o ignorado também fica aprendido (uma pergunta, para sempre)", len(d_letras), 2)


def modelo_em_baixo(_b64):
    raise ConnectionError("a rede caiu")


r_sem_ia = ler_linha(desenhar_texto("1"), Dicionario(),
                     vigia.perguntador_ia(pedir=modelo_em_baixo))
igual("IA em baixo: o programa fica sem leitura em vez de rebentar", r_sem_ia["valor"], None)

# A revisão de tamanhos: a letra «U» do «USD» já foi registada como «0» uma vez, e a leitura passou
# a ser «5,000». Isto é o que a apanharia.
ok("um carácter com duas larguras na mesma região é um aviso (o caso real: «0» 13 px e «U» 17 px)",
   len(vigia.revisao_de_tamanhos(["0", "0", "0"],
                                 [{"largura": 13, "altura": 17}, {"largura": 13, "altura": 17},
                                  {"largura": 17, "altura": 16}])) >= 1)
ok("mas 1 px de diferença entre duas capturas não é um aviso",
   vigia.revisao_de_tamanhos(["0", "0"],
                             [{"largura": 13, "altura": 17}, {"largura": 14, "altura": 16}]) == [])
ok("e o mesmo carácter com o mesmo tamanho não levanta nada",
   vigia.revisao_de_tamanhos(["0", "0"],
                             [{"largura": 13, "altura": 17}, {"largura": 13, "altura": 17}]) == [])
ok("caracteres diferentes não se comparam entre si",
   vigia.revisao_de_tamanhos(["0", "5"],
                             [{"largura": 13, "altura": 17}, {"largura": 14, "altura": 17}]) == [])

# ============================== 6.5 A MIRA E O ENSINO POR CAMPO ==============================
seccao("[6.5] A mira (apontar em vez de desenhar) e o ensino por campo")

# As funções puras primeiro: a conta tem de estar certa antes de haver botões.
igual("dois cantos viram a grelha inteira", caixa_da_grelha((67, 519), (282, 734), 5),
      [40, 492, 269, 269])
ok("e a grelha sai simétrica em qualquer tamanho",
   caixa_da_grelha((100, 100), (500, 400), 5) == [50, 62, 500, 375],
   caixa_da_grelha((100, 100), (500, 400), 5))

sintetico = desenhar_texto("5,00 USD", tamanho=30)
glifos_sint = segmentar(sintetico)
ok("a mira encontra o texto a partir de um ponto no meio dele",
   caixa_do_texto(sintetico, sintetico.shape[1] // 2, sintetico.shape[0] // 2) is not None)
ok("e devolve None onde não há tinta nenhuma",
   caixa_do_texto(np.full((80, 200, 3), (27, 24, 38), dtype=np.uint8), 100, 40) is None)
caixa_sint = caixa_do_texto(sintetico, sintetico.shape[1] // 2, sintetico.shape[0] // 2)
ok("e a caixa que devolve não é a imagem toda (é o texto, não a moldura)",
   caixa_sint and caixa_sint[2] < sintetico.shape[1], caixa_sint)

# ENSINAR RESPONDENDO POR CAMPO: uma resposta, todos os glifos da linha.
res = aprender_por_texto(glifos_sint, "5,00 USD")
igual("«5,00 USD» dá um rótulo por desenho", res["rotulos"], ["5", ",", "0", "0", "", "", ""])
igual("e conta o que aprendeu e o que ignorou", (res["aprendidos"], res["ignorados"]), (4, 3))

# A contagem é a única coisa que tem de bater, e quando não bate não se aprende nada: uma contagem
# diferente pode querer dizer que dois caracteres estão colados no ecrã, e aprender com isso
# gravava um desenho errado para sempre.
desalinhado = aprender_por_texto(glifos_sint, "5,0")
ok("escrever menos do que ele vê não ensina nada", desalinhado["rotulos"] == [], desalinhado)
ok("e a recusa diz o que fazer", "_" in (desalinhado["erro"] or ""), desalinhado["erro"])

igual("o `_` marca um desenho que não é número (a setinha das minas)",
      aprender_por_texto(segmentar(desenhar_texto("3", tamanho=30)) + [
          {"assinatura": "seta", "largura": 5, "altura": 4, "bmp": np.ones((4, 5), np.uint8)}],
          "3_")["rotulos"], ["3", ""])
igual("um «?» deixa aquele desenho por aprender",
      aprender_por_texto(segmentar(desenhar_texto("7")), "?")["rotulos"], [None])
igual("e o sinal de menos do saldo aprende-se como número, não como enfeite",
      aprender_por_texto(segmentar(desenhar_texto("-")) + segmentar(desenhar_texto("3")),
                         "−3")["rotulos"], ["\u2212", "3"])

# MODO TUDO: a única decisão que interessa pôr num teste é «o que ainda falta?».
# Um orquestrador que só é testado ligando o ecrã é um orquestrador que nunca é testado.
sint_map = vigia.Mapa(regioes={}, glifos={}, tabuleiro_ref=None, ecra=None, origem=None)
igual("mapa sem regiões: falta o essencial", vigia.o_que_falta(sint_map, Dicionario()), ["regioes"])
igual("mapa com regiões mas com desenhos por aprender: falta os glifos",
      vigia.o_que_falta(vigia.Mapa(regioes={"saldo": [0, 0, 80, 24]}, glifos={}, ecra=None),
                        Dicionario(),
                        {"saldo": desenhar_texto("5,00")}),
      ["glifos"])
# Com todos os desenhos já sabidos, nada falta a esse campo — e o `tudo` não haveria de perguntar
# outra vez.
d_completo = Dicionario()
sint_img = desenhar_texto("5,00", tamanho=30)
for i, g in enumerate(segmentar(sint_img)):
    d_completo.aprender(g, ["5", ",", "0", "0"][i])
igual("tudo sabido: o passo dos glifos salta", vigia.o_que_falta(
    vigia.Mapa(regioes={"saldo": [0, 0, 80, 24]}, glifos=dict(d_completo.rotulos), ecra=None),
    d_completo, {"saldo": sint_img}), [])

igual("a grelha calibrada sem referência: falta-a", vigia.o_que_falta(
    vigia.Mapa(regioes={"tabuleiro": [0, 0, 268, 268]}, glifos={}, tabuleiro_ref=None, ecra=None),
    Dicionario(), {"saldo": desenhar_texto("0,00")}),
      ["referencia"])

from vigia_visao import uniao_de_regioes
igual("a união de duas caixas: [0,0,10,10] ∪ [30,30,20,20] = [0,0,50,50]",
      uniao_de_regioes({"a": [0, 0, 10, 10], "b": [30, 30, 20, 20]}), [0, 0, 50, 50])
igual("caixas que se tocam dão a caixa que as contém",
      uniao_de_regioes({"saldo": [38, 129, 143, 40], "mult": [407, 1024, 66, 29]}),
      [38, 129, 435, 924])
igual("vazio: união é None", uniao_de_regioes({}), None)

# E a decisão de captura, com os números medidos (nesta máquina: 6 ms por captura, ~220 MB/s):
# a caixa única ganha quando o desperdício é pequeno, e perde quando as regiões estão espalhadas.
modo, caixa = vigia.escolha_de_captura({"saldo": [38, 129, 143, 40], "mult": [407, 1024, 66, 29],
                                        "minas": [94, 1238, 75, 22], "grelha": [41, 493, 268, 268]})
igual("regiões na mesma faixa: uma captura só", modo, "caixa")
modo_espalhado, _ = vigia.escolha_de_captura({"a": [0, 0, 10, 10], "b": [3800, 2100, 20, 20]})
igual("regiões em cantos opostos de um ecrã grande: uma captura por região", modo_espalhado,
      "separado")
igual("sem regiões não há o que capturar", vigia.escolha_de_captura({}), ("nada", None))
ok("e o `o_que_falta` da referência não mente quando ela existe",
   "referencia" not in vigia.o_que_falta(
       vigia.Mapa(regioes={"tabuleiro": [0, 0, 268, 268]},
                  tabuleiro_ref=[[0, 0, 0]] * 25, ecra=None),
       Dicionario()))

# ============================== 7. AS FIXTURES REAIS ==============================
seccao("[7] As fixtures reais: do pixel ao veredicto (capturas/*.png)")
mapa_fixture = os.path.join(AQUI, "capturas", "demo-vigia.json")
fixtures = {nome: os.path.join(AQUI, "capturas", nome)
            for nome in ("demo.png", "demo-aberto.png", "demo-3abertas.png")}
if not os.path.exists(mapa_fixture) or not all(os.path.exists(p) for p in fixtures.values()):
    print("  (salta: faltam as fixtures — vê o README, secção «as fixtures do vigia»)")
else:
    mapa_real = vigia.Mapa.carregar(mapa_fixture)
    imagem_cheia = cv2.imread(fixtures["demo.png"])

    for regiao in ("saldo", "multiplicador", "minas"):
        recorte_r = mapa_real.recortar_regiao(imagem_cheia, regiao)
        glifos_r = segmentar(recorte_r)
        ok(f"a região {regiao} corta em glifos (nenhum bloco do tamanho de dois caracteres)",
           glifos_r and max(g["largura"] for g in glifos_r) < recorte_r.shape[1] / 2,
           [(g["largura"], g["altura"]) for g in glifos_r])
        ok(f"e a segmentação de {regiao} é estável entre duas passagens",
           [g["assinatura"] for g in glifos_r]
           == [g["assinatura"] for g in segmentar(mapa_real.recortar_regiao(imagem_cheia, regiao))])

    # A REFERÊNCIA DAS CASAS FOI APRENDIDA NA PRIMEIRA IMAGEM E APLICADA ÀS OUTRAS. É esta a
    # propriedade que interessa: uma grelha toda tapada ensina-se uma vez, e a partir daí o número
    # de casas abertas sai de comparar pixels.
    esperado_abertas = {"demo.png": 0, "demo-aberto.png": 2, "demo-3abertas.png": 3}
    for nome, caminho in fixtures.items():
        img_n = cv2.imread(caminho)
        t = ler_tabuleiro(mapa_real.recortar_regiao(img_n, "tabuleiro"), mapa_real.tabuleiro_ref)
        igual(f"{nome}: casas abertas contadas por cor", t["abertas"], esperado_abertas[nome])
        igual(f"{nome}: as 25 casas fecham a conta",
              t["abertas"] + t["minas"] + t["estados"].count("fechada"), 25)

    # FIM-A-FIM: a mesma função que o `vigiar` usa a cada ronda, sobre um PNG, com o dicionário
    # que foi ensinado uma vez na vida.
    dic_real = mapa_real.dicionario
    leitura_real = vigia.ler_tudo(mapa_real, dic_real, None,
                                  fixtures["demo-3abertas.png"], jogo="mines")
    igual("saldo lido do PNG", leitura_real.saldo, 5.0)
    igual("multiplicador lido do PNG", leitura_real.multiplicador, 1.47)
    igual("nº de minas lido do PNG", leitura_real.minas, 3)
    igual("casas abertas pelas células", leitura_real.casas_abertas, 3)
    igual("e as mesmas casas pelo multiplicador (duas medições independentes)",
          leitura_real.casas_por_mult, 3)
    ok("sem avisos abertos nesta fixture", not leitura_real.avisos, leitura_real.avisos)

    # E o aviso de IMPOSSÍVEL: 25 casas abertas com 3 minas não acontece em jogo nenhum. Quem
    # aparece assim não é o jogador — é a referência das casas aprendida noutro ecrã.
    mapa_sint = vigia.Mapa(regioes={"minas": [0, 0, 40, 24], "multiplicador": [0, 0, 70, 24],
                                    "tabuleiro": [0, 0, 300, 300]},
                           tabuleiro_ref=aprender_tabuleiro(desenhar_tabuleiro([], [])),
                           ecra=None)
    d_sint = Dicionario()
    for c in "3.0":
        g = segmentar(desenhar_texto(c, tamanho=30))
        if g:
            d_sint.aprender(g[0], c)
    leitura_sint = vigia.ler_tudo(mapa_sint, d_sint, None, recortes={
        "minas": desenhar_texto("3", tamanho=30),
        "multiplicador": desenhar_texto("3.00", tamanho=30),
        "tabuleiro": desenhar_tabuleiro(list(range(25)), [])})
    igual("as células dizem 25 abertas", leitura_sint.casas_abertas, 25)
    ok("e o programa grita que isso é impossível, em vez de o dar como leitura",
       any("não é possível" in a for a in leitura_sint.avisos), leitura_sint.avisos)
    ok("dizendo qual é a referência errada e o que fazer",
       any("referência" in a and "TAPADA" in a for a in leitura_sint.avisos), leitura_sint.avisos)

    passos_reais = rotacao(mapa_real.motor["rotacao"], mapa_real.motor["edge"])
    conselho_real = recomendar(leitura_real, mapa_real.motor["aposta"], mapa_real.motor["orcamento"],
                               mapa_real.motor["edge"], passos_reais, 0)
    igual("e o veredicto é RETIRAR (o alvo do plano: 3 casas)", conselho_real.titulo, "RETIRAR")

# ============================== RESUMO ==============================
shutil.rmtree(PASTA_GLIFOS_TESTE, ignore_errors=True)
print(f"(os glifos aprendidos pelos testes foram para {PASTA_GLIFOS_TESTE}, já apagada)")
print("\n" + "=" * 60)
print(f"TODOS OS {passou} TESTES PASSARAM" if falhou == 0 else f"{passou} passaram, {falhou} FALHARAM")
print("=" * 60)
sys.exit(0 if falhou == 0 else 1)
