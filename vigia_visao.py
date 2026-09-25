"""vigia_visao.py — os olhos do vigia-500: capturar o ecrã e LER o que lá está.

Porquê ler pixels em vez de ler o DOM: a página do casino é uma aplicação React que reescreve os
seus próprios elementos, esconde campos dentro de caixas desenhadas e muda de estrutura quando lhe
apetece. Um programa que dependa de selectores depende do humor do site. Uma imagem não tem essa
dependência: o número está no ecrã, e é isso que se lê.

Como se lê um número sem OCR nenhum (e porquê):
  - o número é texto RENDERIZADO NUMA FONTE FIXA. Um OCR genérico é uma máquina cara para um
    problema pequeno: basta cortar a imagem em glifos (projecção de colunas) e, para cada glifo,
    guardar uma ASSINATURA. A primeira vez que um glifo aparece, pergunta-se o que é e fica
    aprendido para sempre naquela fonte e naquele tamanho;
  - é por isso que isto funciona melhor do que OCR: não há erro de 3% a adivinhar dígitos
    parecidos, porque o «3» deste site é *exactamente* o mesmo desenho sempre. E quando não é,
    a assinatura muda, o programa não reconhece, e PERGUNTA em vez de inventar;
  - e o que é aprendido fica auditável: cada glifo aprendido é guardado como PNG pequenino em
    `glifos/`, para se poder olhar para ele e ver o que a máquina aprendeu.

O tabuleiro das Minas é lido por COR/DIFERENÇA, não por OCR: as 25 células são comparadas com a
referência do estado «tudo tapado» (aprendida uma vez) e classificadas em fechada / aberta / mina.

Tudo aqui é LEITURA. Este módulo não envia cliques, teclas nem pedidos de rede.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np

from vigia_motor import parse_moeda

try:
    import vigia_debug
except ImportError:
    vigia_debug = None  # debug opcional: sem o módulo tudo funciona igual

def _dbg(tag: str, msg: str, *a, **kw):
    if vigia_debug is not None and getattr(vigia_debug, "activo", lambda: False)():
        vigia_debug.log(tag, msg, *a, **kw)

# Um glifo é normalizado para este tamanho antes de ser resumido numa assinatura. Pequeno o
# suficiente para duas capturas do mesmo dígito darem o mesmo resultado, grande o suficiente para
# não confundir um «3» com um «8».
LARGURA_GLIFO, ALTURA_GLIFO = 12, 18

FICHEIRO = "vigia-500.json"
PASTA_GLIFOS = "glifos"


# ============================== 1. CAPTURA ==============================
_MSS = None          # uma instância por processo: abrir um handle do ecrã a cada leitura, 1×/s,
                     # é trabalho de sistema operativo para nada


def capturar_regiao(regiao: list[int] | tuple[int, int, int, int] | None = None) -> np.ndarray:
    """Uma imagem BGR do ecrã (ou de uma região dele), com `mss`.

    `regiao` = (x, y, largura, altura) em coordenadas de ECRÃ. Sem região, captura o ecrã todo —
    e por isso quem vigia o ecrã **deve** dar região: o ecrã inteiro são vários MB por leitura,
    quatro recortes são algumas dezenas de KB. É a diferença entre uma ferramenta que se pode
    deixar a correr ao lado do jogo e uma que se nota.
    """
    t0 = time.perf_counter()
    _dbg("visao.capturar_regiao", "IN  regiao=%r", regiao)
    global _MSS
    import mss  # importado aqui para o resto do módulo funcionar sem ecrã (testes, PNGs)
    if _MSS is None:
        _dbg("visao.capturar_regiao", "a abrir mss.mss() (primeira vez neste processo)")
        _MSS = mss.mss()
        _dbg("visao.capturar_regiao", "mss.mss() aberto  monitors=%r", getattr(_MSS, "monitors", None))
    sct = _MSS
    if regiao is None:
        alvo = sct.monitors[0]
        _dbg("visao.capturar_regiao", "sem região -> ecrã todo  alvo=%r", alvo)
    else:
        x, y, w, h = (int(v) for v in regiao)
        alvo = {"left": x, "top": y, "width": max(1, w), "height": max(1, h)}
        _dbg("visao.capturar_regiao", "alvo=%r", alvo)
    try:
        bruto = np.array(sct.grab(alvo))
    except Exception as e:
        _dbg("visao.capturar_regiao", "ERRO no sct.grab", exc=e, extra={"alvo": str(alvo)})
        raise
    img = cv2.cvtColor(bruto, cv2.COLOR_BGRA2BGR)
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.capturar_regiao", "OUT shape=%r dtype=%s  %.2f ms  %d bytes", img.shape, str(img.dtype), dt, int(img.nbytes))
    return img


def uniao_de_regioes(regioes) -> list[int] | None:
    """A caixa que contém todas as regiões — uma só captura em vez de uma por região.

    É por aqui que se poupa o ecrã inteiro: o vigia faz uma captura por leitura, do tamanho da
    caixa que contém as quatro regiões, e depois recorta-as de lá. Uma captura de 900×1421 são
    ~5 MB de memória a cada 0,9 s; estas quatro caixas juntas são ~300 KB.
    """
    _dbg("visao.uniao_de_regioes", "IN  regioes=%r", regioes)
    caixas = [r for r in (regioes or {}).values() if r and len(r) == 4]
    if not caixas:
        _dbg("visao.uniao_de_regioes", "OUT None (sem caixas válidas)")
        return None
    x0 = min(int(r[0]) for r in caixas)
    y0 = min(int(r[1]) for r in caixas)
    x1 = max(int(r[0]) + int(r[2]) for r in caixas)
    y1 = max(int(r[1]) + int(r[3]) for r in caixas)
    out = [x0, y0, max(1, x1 - x0), max(1, y1 - y0)]
    _dbg("visao.uniao_de_regioes", "OUT %r  de %d caixas  area=%d", out, len(caixas), int(out[2]*out[3]))
    return out


def abrir_imagem(caminho: str) -> np.ndarray:
    """Abre um PNG/JPG como BGR. É o caminho dos testes e do modo `--png`."""
    _dbg("visao.abrir_imagem", "IN  caminho=%r cwd=%r", caminho, os.getcwd())
    t0 = time.perf_counter()
    img = cv2.imread(caminho, cv2.IMREAD_COLOR)
    dt = (time.perf_counter() - t0) * 1000.0
    if img is None:
        _dbg("visao.abrir_imagem", "FALHA imread devolveu None  %.2f ms", dt)
        raise FileNotFoundError(f"não consegui abrir a imagem {caminho!r} — procurei em {os.getcwd()}")
    _dbg("visao.abrir_imagem", "OUT shape=%r dtype=%s  %.2f ms", img.shape, str(img.dtype), dt)
    return img


def recortar(img: np.ndarray, regiao: list[int] | tuple[int, int, int, int]) -> np.ndarray:
    """Recorta (x, y, w, h) de uma imagem — a mesma convenção das regiões de ECRÃ."""
    _dbg("visao.recortar", "IN  regiao=%r  img.shape=%r", regiao, getattr(img, "shape", None))
    x, y, w, h = (int(v) for v in regiao)
    x, y = max(0, x), max(0, y)
    out = img[y:y + max(1, h), x:x + max(1, w)].copy()
    _dbg("visao.recortar", "OUT shape=%r  pedido %r -> [%d:%d, %d:%d]", out.shape, regiao, y, y+max(1,h), x, x+max(1,w))
    return out


# ============================== 2. GLIFOS ==============================
FRACAO_DE_TEXTO = 0.30        # limiar = fundo + 30% do contraste da imagem
CONTRASTE_MINIMO = 18.0       # abaixo disto não há texto: só ruído de compressão do ecrã


def binarizar(img: np.ndarray, fracao: float = FRACAO_DE_TEXTO) -> np.ndarray:
    """Tinta a branco (255) sobre fundo a preto (0), seja o texto claro ou escuro.

    Limiar RELATIVO ao contraste, e não Otsu. O Otsu procura o melhor corte entre duas populações
    bem separadas — e texto fino com antialiasing não são duas populações: as hastes têm pixels a
    meio caminho, e o Otsu corta-os fora. Foi exactamente isso que fez o «3» da caixa das minas
    ser lido como três fragmentos («%@@@.» / «*@.» / «*@@@@*») em vez de um dígito: as colunas do
    meio ficavam a zeros, e a projecção partia o glifo ao meio.
    """
    t0 = time.perf_counter()
    cinza = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    baixo, alto = float(cinza.min()), float(cinza.max())
    limiar = baixo + max(CONTRASTE_MINIMO, (alto - baixo) * fracao)
    _, b = cv2.threshold(cinza, limiar, 255, cv2.THRESH_BINARY)
    branco_ratio = float((b > 0).mean())
    invertido = branco_ratio > 0.5
    if invertido:
        b = 255 - b          # o fundo é a maior parte: a tinta é o que sobra
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.binarizar", "shape=%r cinza %d..%d limiar=%.1f fracao=%.2f branco=%.2f%% invertido=%s  %.2f ms",
         img.shape, int(baixo), int(alto), limiar, fracao, branco_ratio*100, invertido, dt)
    return b


def assinatura(bmp: np.ndarray) -> str:
    """Uma assinatura estável para um glifo: normaliza, engrossa 1px e resume em sha1.

    O engrossamento existe para absorver o jitter de antialiasing entre duas capturas do MESMO
    dígito. Sem ele, o mesmo «3» dava duas assinaturas diferentes a cada frame — e o dicionário
    enchia-se de duplicados que ninguém pediu.
    """
    if bmp.size == 0:
        _dbg("visao.assinatura", "bmp vazio -> 'vazio'")
        return "vazio"
    n = cv2.resize(bmp, (LARGURA_GLIFO, ALTURA_GLIFO), interpolation=cv2.INTER_AREA)
    n = cv2.dilate(n, np.ones((2, 2), np.uint8))
    n = (n > 127).astype(np.uint8)
    sig = hashlib.sha1(n.tobytes()).hexdigest()[:16]
    _dbg("visao.assinatura", "bmp %r -> %r  (%dx%d -> %dx%d)", bmp.shape, sig, bmp.shape[1] if bmp.ndim==2 else 0, bmp.shape[0] if bmp.ndim==2 else 0, LARGURA_GLIFO, ALTURA_GLIFO)
    return sig


def segmentar(img: np.ndarray) -> list[dict]:
    """Corta uma linha de texto em glifos, pela projecção das colunas com tinta.

    Devolve [{x0, x1, y0, y1, bmp, assinatura}]. Espaços não são glifos: são a ausência deles.

    AQUI JÁ HOUVE UMA MORPH_CLOSE, E FOI RETIRADA COM MEDIDA. A ideia era religar hastes partidas
    pela antialiasing; o que ela fazia era juntar dígitos vizinhos. Nesta fonte os dígitos ficam a
    1 a 4 pixels uns dos outros, e uma fecho horizontal de 3 colunas engole qualquer intervalo
    menor que isso: o «0.30» saía como «0.» mais um glifo de 25 pixels de largura («3» e «0»
    colados), que ninguém sabia ler — e o resto do número, já lido, dava 0.0, um valor PLAUSÍVEL e
    ERRADO. Um leitor que devolve um número errado com confiança é o pior modo de falha possível.

    A fragmentação que a fecho vinha curar era culpa do Otsu, e essa já está resolvida na
    `binarizar` (limiar relativo). Com a binarização certa, as fixtures reais dão um glifo por
    carácter SEM morfologia nenhuma — e o que continua partido fica desconhecido, o que faz o
    programa PERGUNTAR em vez de inventar.
    """
    t0 = time.perf_counter()
    b = binarizar(img)
    colunas = (b > 0).sum(axis=0)
    _dbg("visao.segmentar", "IN  img.shape=%r b.shape=%r colunas sum=%d max=%d", img.shape, b.shape, int(colunas.sum()), int(colunas.max()) if len(colunas) else 0)
    grupos: list[list[int]] = []
    inicio = None
    for x, n in enumerate(colunas):
        if n > 0 and inicio is None:
            inicio = x
        elif n == 0 and inicio is not None:
            grupos.append([inicio, x])
            inicio = None
    if inicio is not None:
        grupos.append([inicio, len(colunas)])
    glifos = []
    for x0, x1 in grupos:
        faixa = b[:, x0:x1]
        linhas = np.where((faixa > 0).sum(axis=1) > 0)[0]
        if len(linhas) == 0:
            _dbg("visao.segmentar", "  grupo x=[%d,%d) vazio (sem linhas com tinta) -> ignora", x0, x1)
            continue
        y0, y1 = int(linhas[0]), int(linhas[-1]) + 1
        bmp = faixa[y0:y1, :]
        sig = assinatura(bmp)
        glifos.append({"x0": int(x0), "x1": int(x1), "y0": y0, "y1": y1,
                       "bmp": bmp, "assinatura": sig,
                       "largura": int(x1 - x0), "altura": int(y1 - y0)})
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.segmentar", "OUT %d grupo(s) -> %d glifo(s)  %.2f ms  %r", len(grupos), len(glifos), dt,
         [(g["assinatura"], g["largura"], g["altura"]) for g in glifos])
    return glifos


@dataclass
class Dicionario:
    """A memória de glifos: assinatura -> carácter. `''` significa «isto não é número, ignora».

    Guardar também o PNG de cada glifo é o que torna isto auditável: quem quiser pode abrir
    `glifos/<assinatura>.png` e ver exactamente o desenho que o programa aprendeu.
    """

    rotulos: dict[str, str] = field(default_factory=dict)
    ficheiro: str = FICHEIRO

    def __len__(self) -> int:
        return len(self.rotulos)

    def get(self, sig: str) -> str | None:
        return self.rotulos.get(sig)

    def aprender(self, glifo: dict, rotulo: str, pasta: str | None = None) -> None:
        # A pasta é resolvida AQUI e não no valor por omissão: assim os testes podem apontá-la para
        # um sítio temporário, e a pasta de auditoria do projecto fica só com o que está mesmo no
        # dicionário. Uma auditoria com desenhos que já ninguém usa é uma auditoria que mente.
        sig = glifo.get("assinatura", "?")
        _dbg("visao.Dicionario.aprender", "sig=%r rotulo=%r pasta=%r -> %d rotulos", sig, rotulo, pasta or PASTA_GLIFOS, len(self.rotulos)+1)
        pasta = pasta or PASTA_GLIFOS
        self.rotulos[glifo["assinatura"]] = rotulo
        try:
            os.makedirs(pasta, exist_ok=True)
            nome = rotulo if rotulo else "_ignorado"
            caminho = os.path.join(pasta, f"{glifo['assinatura']}_{nome}.png")
            cv2.imwrite(caminho, glifo["bmp"])
            _dbg("visao.Dicionario.aprender", "gravado %r", caminho)
        except Exception as e:
            _dbg("visao.Dicionario.aprender", "falha ao gravar PNG", exc=e)

# ============================== 3. LEITURA DE UMA LINHA ==============================
def ler_linha(img: np.ndarray, dic: Dicionario,
              perguntar: Callable[[dict], str | None] | None = None) -> dict:
    """Lê uma linha de texto com o dicionário. Glifo desconhecido -> pergunta (ou fica em falta).

    Nunca adivinha, em dois sentidos:
      - um glifo que não conhece sai em `desconhecidos` e o texto sai com `?`;
      - e se houver um só que seja desconhecido, o VALOR é None. «0.» é um número que se lê bem e
        que está errado; metade de um número não é um número, e devolvê-lo era transformar uma
        leitura incompleta numa decisão.
    """
    t0 = time.perf_counter()
    _dbg("visao.ler_linha", "IN  img.shape=%r dic=%d perguntar=%s", getattr(img, "shape", None), len(dic), bool(perguntar))
    glifos = segmentar(img)
    rotulos: list[str | None] = []
    desconhecidos: list[dict] = []
    perguntados = 0
    for g in glifos:
        r = dic.get(g["assinatura"])
        _dbg("visao.ler_linha", "  glifo sig=%r %dx%d  dic.get -> %r", g["assinatura"], g["largura"], g["altura"], r)
        if r is None and perguntar is not None:
            _dbg("visao.ler_linha", "  -> a perguntar (desconhecido)")
            r = perguntar(g)
            _dbg("visao.ler_linha", "  <- perguntar devolveu %r", r)
            if r is not None:
                dic.aprender(g, r)
                perguntados += 1
        if r is None:
            desconhecidos.append(g)
            rotulos.append("?")
        else:
            rotulos.append(r)
    texto = "".join(r for r in rotulos if r)
    completo = not desconhecidos
    valor = parse_moeda(texto) if completo else None
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.ler_linha", "OUT texto=%r valor=%r completo=%s desconhecidos=%d aprendidos=%d  %.2f ms",
         texto, valor, completo, len(desconhecidos), perguntados, dt)
    return {"texto": texto, "valor": valor, "glifos": glifos,
            "rotulos": rotulos, "desconhecidos": desconhecidos, "aprendidos": perguntados,
            "completo": completo,
            "nota": None if completo else
                    f"{len(desconhecidos)} glifo(s) por aprender — não leio um número a metade"}


def ler_numero_estavel(tirar_imagem: Callable[[], np.ndarray], dic: Dicionario,
                       tentativas: int = 3, espera: float = 0.12,
                       perguntar: Callable[[dict], str | None] | None = None) -> dict:
    """Lê o mesmo campo várias vezes e exige ACORDO entre as leituras.

    Um número de saldo é lido enquanto a página respira (animações, valores a contar, o rato por
    cima). Uma leitura isolada é um palpite; três leituras que concordam são uma medição. Quando
    não concordam, o resultado diz isso — e quem decide é o motor, que nunca inventa.
    """
    _dbg("visao.ler_numero_estavel", "IN  tentativas=%d espera=%.3f", tentativas, espera)
    t0 = time.perf_counter()
    leituras = []
    for i in range(max(1, tentativas)):
        _dbg("visao.ler_numero_estavel", "  tentativa %d/%d", i+1, tentativas)
        r = ler_linha(tirar_imagem(), dic, perguntar)
        _dbg("visao.ler_numero_estavel", "  -> texto=%r valor=%r completo=%s", r["texto"], r["valor"], r["completo"])
        leituras.append(r)
        if i < tentativas - 1:
            time.sleep(espera)
    valores = [x["valor"] for x in leituras]
    _dbg("visao.ler_numero_estavel", "valores=%r", valores)
    if len(set(v for v in valores if v is not None)) == 1 and valores[0] is not None:
        _dbg("visao.ler_numero_estavel", "OUT acordo total -> %r", valores[0])
        return {"ok": True, "valor": valores[0], "texto": leituras[0]["texto"],
                "leituras": leituras, "concordancia": True}
    contagem: dict[float, int] = {}
    for v in valores:
        if v is not None:
            contagem[v] = contagem.get(v, 0) + 1
    if contagem:
        melhor, n = max(contagem.items(), key=lambda kv: kv[1])
        if n >= 2 and n > len(valores) / 2:
            _dbg("visao.ler_numero_estavel", "OUT maioria %r x%d/%d", melhor, n, len(valores))
            return {"ok": True, "valor": melhor, "texto": leituras[0]["texto"],
                    "leituras": leituras, "concordancia": True, "nota": "maioria de 3 leituras"}
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.ler_numero_estavel", "OUT SEM acordo -> None  %.2f ms  contagem=%r", dt, contagem)
    return {"ok": False, "valor": None, "leituras": leituras, "concordancia": False,
            "nota": "as leituras do campo não concordam entre si — não uso nenhuma delas"}


# ============================== 4. O TABULEIRO DAS MINAS ==============================
# Cada célula é resumida em DOIS números que dizem coisas diferentes:
#   - uma grelha 8×8 de CINZENTOS: onde está a tinta (um símbolo, um ícone). Apanha a diferença
#     estrutural mesmo quando a cor quase não muda.
#   - a COR média: distingue o verde do aberto do vermelho da mina.
# Guardar as duas coisas (64 + 3 números por célula) é o que permite uma decisão que aguente a
# variação de um ecrã real sem começar a inventar casas abertas que não existem.
LADO_CINZA = 8
LIMIAR_CINZA_PADRAO = 6.0     # diferença média de cinzentos: ecrã parado anda por 0-2
PARTE_DIFERENTE = 0.15        # até 15% dos 64 blocos podem mudar sem ser «mudou a casa»
VERMELHO_DA_MINA = 26.0       # o vermelho típico de uma mina destaca-se assim do resto


def _resumo_celula(patch: np.ndarray) -> dict:
    _dbg("visao._resumo_celula", "IN  patch.shape=%r", getattr(patch, "shape", None))
    cinza = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)
    pequeno = cv2.resize(cinza, (LADO_CINZA, LADO_CINZA), interpolation=cv2.INTER_AREA)
    out = {"cinza": [int(v) for v in pequeno.reshape(-1)],
           "media": [round(float(v), 2) for v in patch.reshape(-1, 3).mean(axis=0)]}
    _dbg("visao._resumo_celula", "OUT media=%r cinza[:4]=%r", out["media"], out["cinza"][:4])
    return out


def patches_tabuleiro(img: np.ndarray, n: int = 5) -> list[dict]:
    """O resumo de cada célula da grelha n×n (25 para as Minas), no interior de cada casa.

    Só o INTERIOR de cada casa: as bordas mudam de aspecto com o foco e com o rato por cima, e
    meter isso na comparação era alimentar o ruído com as próprias mãos.
    """
    _dbg("visao.patches_tabuleiro", "IN  img.shape=%r n=%d", getattr(img, "shape", None), n)
    t0 = time.perf_counter()
    alt, larg = img.shape[:2]
    patches = []
    for linha in range(n):
        for coluna in range(n):
            y0 = int(linha * alt / n)
            y1 = int((linha + 1) * alt / n)
            x0 = int(coluna * larg / n)
            x1 = int((coluna + 1) * larg / n)
            cy0, cy1 = y0 + (y1 - y0) // 5, y1 - (y1 - y0) // 5
            cx0, cx1 = x0 + (x1 - x0) // 5, x1 - (x1 - x0) // 5
            centro = img[cy0:max(cy0 + 1, cy1), cx0:max(cx0 + 1, cx1)]
            patches.append(_resumo_celula(centro))
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.patches_tabuleiro", "OUT %d patches  %.2f ms  %dx%d -> %d células", len(patches), dt, larg, alt, n*n)
    return patches


def aprender_tabuleiro(img: np.ndarray, n: int = 5) -> list[dict]:
    """Guarda o aspecto das 25 células TAPADAS. É a referência contra a qual tudo se compara.

    Aprender «tapada» e não «aberta» é deliberado: no início de uma ronda das Minas está tudo
    tapado, portanto é esse o estado que existe sempre para aprender — e é o único que o
    utilizador consegue produzir de propósito.
    """
    _dbg("visao.aprender_tabuleiro", "IN  img.shape=%r n=%d", getattr(img, "shape", None), n)
    out = patches_tabuleiro(img, n)
    _dbg("visao.aprender_tabuleiro", "OUT %d refs  ex=%r", len(out), out[0] if out else None)
    return out


def classificar_celula(atual: dict, referencia: dict,
                       limiar_cinza: float = LIMIAR_CINZA_PADRAO,
                       limiar_cor: float = LIMIAR_CINZA_PADRAO,
                       parte_diferente: float = PARTE_DIFERENTE,
                       vermelho: float = VERMELHO_DA_MINA) -> str:
    """fechada (igual à referência) / mina (vermelha) / aberta (o resto).

    A ordem das perguntas importa: «fechada» é a hipótese conservadora, e só se sai dela com
    evidência em DUAS medidas independentes (a estrutura e a cor). A alternativa — decidir por
    uma só — é o caminho mais curto para alarmes falsos, e um alarme falso num painel de
    disciplina ensina a pessoa a ignorar o painel.
    """
    a_cinza = np.array(atual["cinza"], dtype=float)
    r_cinza = np.array(referencia["cinza"], dtype=float)
    d_cinza = float(np.mean(np.abs(a_cinza - r_cinza)))
    partes = float(np.mean(np.abs(a_cinza - r_cinza) > 18))
    d_cor = float(np.mean(np.abs(np.array(atual["media"], dtype=float)
                                 - np.array(referencia["media"], dtype=float))))
    b, g, r = (max(0.0, float(v)) for v in atual["media"])
    decisao = None
    if partes < parte_diferente and d_cor < limiar_cor and d_cinza < limiar_cinza:
        decisao = "fechada"
    elif r - max(g, b) > vermelho:
        decisao = "mina"
    else:
        decisao = "aberta"
    _dbg("visao.classificar_celula", "d_cinza=%.2f partes=%.3f d_cor=%.2f  media BGR=%.1f,%.1f,%.1f verm=%.1f  -> %s",
         d_cinza, partes, d_cor, b, g, r, r-max(g,b), decisao)
    return decisao


def ler_tabuleiro(img: np.ndarray, referencias, n: int = 5,
                  limiar_cinza: float = LIMIAR_CINZA_PADRAO) -> dict:
    """O estado das 25 células, mais a CONTAGEM de abertas — que é o número que o motor usa."""
    _dbg("visao.ler_tabuleiro", "IN  img.shape=%r n=%d limiar=%.2f refs=%d", getattr(img, "shape", None), n, limiar_cinza, len(referencias) if referencias else 0)
    t0 = time.perf_counter()
    patches = patches_tabuleiro(img, n)
    estados = [classificar_celula(p, ref, limiar_cinza=limiar_cinza)
               for p, ref in zip(patches, referencias)]
    out = {"estados": estados, "abertas": sum(1 for e in estados if e == "aberta"),
           "minas": sum(1 for e in estados if e == "mina"), "patches": patches}
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.ler_tabuleiro", "OUT abertas=%d minas=%d fechadas=%d  %.2f ms  estados=%r", out["abertas"], out["minas"], estados.count("fechada"), dt, estados)
    return out


# ============================== 5. DIAGNÓSTICO VISUAL ==============================
def desenhar_leitura(img: np.ndarray, leitura: dict, caminho: str | None = None) -> np.ndarray:
    """Desenha as caixas e os rótulos por cima do recorte — para se poder VER o que ele leu.

    Um leitor que não se deixa inspeccionar não é uma ferramenta: é uma caixa preta com opiniões.
    """
    saida = img.copy()
    for g, r in zip(leitura.get("glifos", []), leitura.get("rotulos", [])):
        cv2.rectangle(saida, (g["x0"], g["y0"]), (g["x1"], g["y1"]), (0, 255, 0), 1)
        cv2.putText(saida, "" if r is None else str(r), (g["x0"], max(9, g["y0"] - 2)),
                    cv2.FONT_HERSHEY_PLAIN, 0.9, (0, 255, 255), 1)
    if caminho:
        os.makedirs(os.path.dirname(caminho) or ".", exist_ok=True)
        cv2.imwrite(caminho, saida)
    return saida


# ============================== 5.5 A MIRA: apontar em vez de desenhar ==============================
RAIO_DA_MIRA = 40         # meia-janela onde se procura o caracter mais próximo do clique
PARAGEM_DO_VAZIO = 0.5     # um vazio com metade da altura de um glifo termina a linha
VAZIO_MINIMO = 4           # …mas nunca menos que isto: 1-3 px é espaço entre caracteres
MARGEM = 3                 # respiro à volta da caixa, para a antialiasing entrar
LARGURA_MAXIMA = 400       # travão de segurança do crescimento (nenhum número tem 400 px)


def caixa_do_texto(img: np.ndarray, x: int, y: int, raio: int = RAIO_DA_MIRA,
                   paragem: float = PARAGEM_DO_VAZIO,
                   maximo: int = LARGURA_MAXIMA) -> list[int] | None:
    """A caixa do TEXTO que está debaixo deste ponto — é isto que a mira devolve.

    IA PRIMEIRA VERSÃO DESTA FUNÇÃO CRESCEU ATÉ ENGOLIR A PÁGINA INTEIRA, e vale a pena guardar o
    porquê. Crescer a linha a partir do clique é a ideia certa; o erro foi escolher o «ponto de
    partida» como a caixa da tinta de uma JANELA em volta do clique. Se a janela apanha duas coisas
    diferentes (o saldo em cima, um botão em baixo), a caixa de partida atravessa as duas, a banda
    vertical deixa de ser uma linha de texto, e como há sempre tinta algures nessa banda o
    crescimento nunca pára.

    Agora parte-se do CARACTER isolado: o componente de tinta mais próximo do clique (janela de
    ±40 px), e é a ALTURA DESSE CARACTER que define a banda — a linha é onde ele está, com folga
    para cima e para baixo, e não «tudo o que a janela apanhou». A partir daí a linha cresce para a
    esquerda e para a direita enquanto o vazio não passar de metade da altura de um glifo (entre
    caracteres desta fonte há 1 a 7 px; um espaço a sério tem o dobro).

    Devolve [x, y, largura, altura] na convenção das regiões, ou None se não houver tinta ali.
    """
    _dbg("visao.caixa_do_texto", "IN  x=%d y=%d raio=%d paragem=%.2f maximo=%d  img.shape=%r", x, y, raio, paragem, maximo, getattr(img, "shape", None))
    t0 = time.perf_counter()
    b = binarizar(img)
    h, w = b.shape[:2]
    x, y = int(x), int(y)
    x0j, x1j = max(0, x - raio), min(w, x + raio + 1)
    y0j, y1j = max(0, y - raio), min(h, y + raio + 1)
    janela = b[y0j:y1j, x0j:x1j]
    _dbg("visao.caixa_do_texto", "janela [%d:%d, %d:%d] size=%d any=%s", y0j, y1j, x0j, x1j, int(janela.size), bool(janela.any()) if janela.size else "N/A")
    if janela.size == 0 or not janela.any():
        _dbg("visao.caixa_do_texto", "OUT None (sem tinta na janela)")
        return None

    n_comp, _rot, stats, _cent = cv2.connectedComponentsWithStats(janela, connectivity=8)
    _dbg("visao.caixa_do_texto", "n_comp=%d (inclui fundo)", n_comp)
    semear, melhor = None, None
    for i in range(1, n_comp):
        bx, by, bw, bh, _area = (int(v) for v in stats[i])
        dx = max(bx - (x - x0j), (x - x0j) - (bx + bw - 1), 0)
        dy = max(by - (y - y0j), (y - y0j) - (by + bh - 1), 0)
        distancia = dx * dx + dy * dy
        if melhor is None or distancia < melhor:
            melhor, semear = distancia, (bx, by, bw, bh)
    if semear is None:
        _dbg("visao.caixa_do_texto", "OUT None (sem componente semeado)")
        return None
    bx, by, bw, bh = semear
    sx0, sy0 = x0j + bx, y0j + by
    altura = max(1, bh)
    _dbg("visao.caixa_do_texto", "semeado [%d,%d %dx%d] at (%d,%d)  altura=%d  dist=%.1f", bx, by, bw, bh, sx0, sy0, altura, float(melhor) if melhor is not None else -1)
    # A BANDA DA LINHA é o caracter semeado com folga assimétrica, e a assimetria é medida: acima
    # do topo há OUTRA linha (o rótulo «Saldo» fica a 0,76 alturas de distância), e abaixo da base
    # há vírgulas e descidas (a vírgula do «5,00» desce 0,24 alturas). 0,3 para cima e 0,6 para
    # baixo é o que separa as duas coisas nas medições reais.
    banda0 = max(0, sy0 - int(round(0.3 * altura)))
    banda1 = min(h, sy0 + altura + int(round(0.6 * altura)))
    limite = max(VAZIO_MINIMO, paragem * altura)

    def tem_tinta(coluna: int) -> bool:
        return bool(b[banda0:banda1, coluna].any())

    esq, dir_ = sx0, sx0 + bw - 1
    pos, vazio = esq, 0
    while pos - 1 >= 0 and esq - (pos - 1) <= maximo:
        if tem_tinta(pos - 1):
            esq, vazio = pos - 1, 0
        else:
            vazio += 1
            if vazio > limite:
                break
        pos -= 1
    pos, vazio = dir_, 0
    while pos + 1 < w and (pos + 1) - dir_ <= maximo:
        if tem_tinta(pos + 1):
            dir_, vazio = pos + 1, 0
        else:
            vazio += 1
            if vazio > limite:
                break
        pos += 1

    _dbg("visao.caixa_do_texto", "banda y=[%d,%d) altura=%d limite_vazio=%.1f  esq=%d dir=%d", banda0, banda1, altura, limite, esq, dir_)
    faixa = b[banda0:banda1, esq:dir_ + 1]
    linhas = np.where((faixa > 0).sum(axis=1) > 0)[0]
    if len(linhas) == 0:
        _dbg("visao.caixa_do_texto", "OUT None (faixa sem tinta) esq=%d dir=%d banda=[%d,%d)", esq, dir_, banda0, banda1)
        return None
    topo, fundo = banda0 + int(linhas[0]), banda0 + int(linhas[-1]) + 1
    cx = max(0, esq - MARGEM)
    cy = max(0, topo - MARGEM)
    cw = min(w, dir_ + 1 + MARGEM) - cx
    ch = min(h, fundo + MARGEM) - cy
    out = [int(cx), int(cy), int(cw), int(ch)]
    dt = (time.perf_counter() - t0) * 1000.0
    _dbg("visao.caixa_do_texto", "OUT %r  %.2f ms  (esq=%d dir=%d topo=%d fundo=%d +margem)", out, dt, esq, dir_, topo, fundo)
    return out


def caixa_da_grelha(p1: tuple[int, int], p2: tuple[int, int], n: int = 5,
                    margem: int = 0) -> list[int]:
    """A grelha inteira a partir de DUAS casas: o centro da primeira e o da última.

    E é aritmética, não adivinhação: entre o centro da primeira casa e o da última há exactamente
    `n-1` passos, portanto o tamanho de uma casa sai daí (uma subtracção e uma divisão). O que se
    aponta são dois pontos que o utilizador vê; a conta a partir deles é do programa. Se os cantos
    não forem exactamente os centros, o erro é de meia casa — e é por isso que a mira mostra sempre
    o que vai cortar e deixa corrigir antes de aceitar.
    """
    _dbg("visao.caixa_da_grelha", "IN  p1=%r p2=%r n=%d margem=%d", p1, p2, n, margem)
    (x1, y1), (x2, y2) = p1, p2
    passo_x = abs(x2 - x1) / (n - 1)
    passo_y = abs(y2 - y1) / (n - 1)
    esquerda = min(x1, x2) - passo_x / 2 - margem
    topo = min(y1, y2) - passo_y / 2 - margem
    largura = abs(x2 - x1) + passo_x + 2 * margem
    altura = abs(y2 - y1) + passo_y + 2 * margem
    out = [int(round(esquerda)), int(round(topo)), int(round(largura)), int(round(altura))]
    _dbg("visao.caixa_da_grelha", "OUT %r  passo=%.1f,%.1f", out, passo_x, passo_y)
    return out


# ============================== 5.6 ENSINAR RESPONDENDO POR CAMPO ==============================
def aprender_por_texto(glifos: list[dict], texto: str) -> dict:
    """Mapeia os desenhos de uma linha aos caracteres de UMA resposta escrita.

    A pergunta certa não é «que carácter é este desenho?» (catorze vezes), é «o que está escrito
    aqui?» (uma vez). É mais rápido, mais fácil de acertar, e é o que uma pessoa faz naturalmente:
    lê o número que está no ecrã.

    A única coisa que tem de bater é a CONTAGEM: se o utilizador escreveu 7 caracteres visíveis e o
    programa viu 7 desenhos, a correspondência é uma só — a ordem. Se não bate, não se aprende NADA:
    uma contagem diferente pode querer dizer que dois caracteres estão colados no ecrã (e aí o que
    está mal é a segmentação), e aprender com isso gravava um desenho errado para sempre.

    Os espaços que o utilizador escreve não contam (são separadores visuais), e tudo o que não seja
    número é marcado como «ignorar» — é o que acontece à letra do «USD» e ao «_» que se escreve
    para um desenho que não se consegue datilografar (a setinha da caixa das minas, um logótipo de
    moeda). O sinal de menos CONTA como carácter do número, e não como enfeite: um saldo negativo
    lido como positivo é o tipo de erro que este projecto não se pode permitir. Um «?» deixa aquele
    glifo por aprender.
    """
    _dbg("visao.aprender_por_texto", "IN  texto=%r glifos=%d", texto, len(glifos))
    limpo = "".join(str(texto).split())
    _dbg("visao.aprender_por_texto", "limpo=%r (%d chars)", limpo, len(limpo))
    rotulos: list[str | None] = []
    if not limpo:
        _dbg("visao.aprender_por_texto", "OUT erro: vazio")
        return {"erro": "não escreveste nada", "rotulos": [], "aprendidos": 0, "ignorados": 0}
    if len(limpo) != len(glifos):
        _dbg("visao.aprender_por_texto", "OUT erro: %d chars vs %d glifos", len(limpo), len(glifos))
        return {"erro": f"escreveste {len(limpo)} caracteres ({limpo!r}) e eu vejo "
                        f"{len(glifos)} desenhos — não aprendo nada com isso. Usa `_` no lugar de um "
                        f"desenho que não é número (uma seta, um logótipo); e se os números estiverem "
                        f"certos, há desenhos colados: corre `ver` e vê o que ele cortou.",
                "rotulos": [], "aprendidos": 0, "ignorados": 0}
    aprender = ignorar = 0
    for g, c in zip(glifos, limpo):
        if c == "?":
            rotulos.append(None)            # «não sei»: fica por aprender, não se inventa nada
        elif c.isdigit() or c in ",.-\u2212":
            rotulos.append(c)
            aprender += 1
        else:
            rotulos.append("")
            ignorar += 1
    _dbg("visao.aprender_por_texto", "OUT ok rotulos=%r aprendidos=%d ignorados=%d", rotulos, aprender, ignorar)
    return {"erro": None, "rotulos": rotulos, "aprendidos": aprender, "ignorados": ignorar,
            "texto": limpo}


# ============================== 6. O MAPA (ficheiro de configuração) ==============================
MOTOR_PADRAO = {
    "jogo": "mines",
    "aposta": 0.30,
    "orcamento": 5.0,
    "edge": 0.01,
    "rotacao": ["dice 1.10", "mines 1 3", "dice 1.50", "mines 3 2", "dice 2.00", "mines 5 2"],
}


@dataclass
class Mapa:
    """Tudo o que o programa sabe sobre a TUA página: onde estão as coisas e o que já aprendeu.

    A regra que separa este projecto de um script frágil: o que é MAPA (regiões, glifos, cor de
    referência) vive num ficheiro de configuração que TU podes inspeccionar e corrigir; o que é
    ESTRATÉGIA (edge, rotação, travões) está no código e é igual para todos.
    """

    regioes: dict[str, list[int]] = field(default_factory=dict)
    glifos: dict[str, str] = field(default_factory=dict)
    tabuleiro_ref: list[list[int]] | None = None
    motor: dict = field(default_factory=lambda: dict(MOTOR_PADRAO))
    ficheiro: str = FICHEIRO
    # O tamanho e o canto do ecrã em que as regiões foram desenhadas. Guardados por um motivo
    # sóbrio: as regiões são coordenadas ABSOLUTAS. Outro monitor, outra escala de Windows ou a
    # janela noutro sítio, e o programa estaria a ler o sítio errado — em silêncio. Assim,
    # ele começa por avisar que o ecrã mudou.
    ecra: list[int] | None = None
    origem: list[int] | None = None

    @classmethod
    def carregar(cls, caminho: str = FICHEIRO) -> "Mapa":
        _dbg("visao.Mapa.carregar", "IN  caminho=%r exists=%s", caminho, os.path.exists(caminho))
        m = cls(ficheiro=caminho)
        if os.path.exists(caminho):
            with open(caminho, encoding="utf-8") as f:
                dados = json.load(f)
            m.regioes = dados.get("regioes", {}) or {}
            m.glifos = dados.get("glifos", {}) or {}
            m.tabuleiro_ref = dados.get("tabuleiro_ref")
            m.motor = {**MOTOR_PADRAO, **(dados.get("motor") or {})}
            m.ecra = dados.get("ecra")
            m.origem = dados.get("origem")
            _dbg("visao.Mapa.carregar", "OUT regioes=%r glifos=%d motor=%r ecra=%r origem=%r refs=%s",
                 m.regioes, len(m.glifos), m.motor, m.ecra, m.origem, bool(m.tabuleiro_ref))
        else:
            _dbg("visao.Mapa.carregar", "OUT sem ficheiro -> Mapa vazio")
        return m

    def guardar(self, caminho: str | None = None) -> str:
        alvo = caminho or self.ficheiro
        _dbg("visao.Mapa.guardar", "IN  alvo=%r regioes=%r glifos=%d", alvo, self.regioes, len(self.glifos))
        with open(alvo, "w", encoding="utf-8") as f:
            json.dump({"versao": 1, "regioes": self.regioes, "glifos": self.glifos,
                       "tabuleiro_ref": self.tabuleiro_ref, "motor": self.motor,
                       "ecra": self.ecra, "origem": self.origem},
                      f, ensure_ascii=False, indent=1)
        _dbg("visao.Mapa.guardar", "OUT gravado %r", alvo)
        return alvo

    @property
    def dicionario(self) -> Dicionario:
        d = Dicionario(rotulos=dict(self.glifos), ficheiro=self.ficheiro)
        return d

    def guardar_dicionario(self, d: Dicionario) -> None:
        self.glifos = dict(d.rotulos)
        self.guardar()

    def recortar_regiao(self, img: np.ndarray, nome: str) -> np.ndarray | None:
        regiao = self.regioes.get(nome)
        if not regiao:
            return None
        return recortar(img, regiao)
