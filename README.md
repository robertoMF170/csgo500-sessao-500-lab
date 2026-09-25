# Sessão 500 — Laboratório de Disciplina

Ferramentas para jogar com orçamento pequeno **sem apostar na emoção**, e a matemática que as
sustenta. Zero dependências, zero frameworks, zero bundlers.

| Ficheiro | O que é | Stack |
|---|---|---|
| `painel-sessao.html` | **O laboratório.** Plano, rotação, Monte Carlo, gráfico, meta. Offline, num só ficheiro | HTML + CSS + JS |
| `painel-500.user.js` | **O HUD.** Corre dentro do csgo500.com: lê o saldo, detecta rondas, detecta o jogo pelo URL, diz o edge e recomenda a jogada — e preenche a configuração, mas não aposta | Userscript + Shadow DOM |
| `teste-hud.js` | **414 testes** do userscript (20 secções, incluindo um fuzz de 1.680 estados), com stub de DOM próprio | Node.js, zero deps |
| `mock-casino.html` | Casino falso (saldo, formatos de moeda, campos de aposta) para exercitar o HUD sem tocar num casino real | HTML |
| `build-demo.js` | Gera `demo-hud.html` (mock + userscript inlinado) para ver tudo a correr num ficheiro só | Node.js |
| `build-instalar.js` | Gera `instalar.html`: o userscript pronto a copiar, com verificação de integridade por hash | Node.js |
| `servidor.sh` · `parar-servidor.sh` | Servem a pasta por HTTP (para instalar o userscript por URL) e param o servidor, confirmando que a porta ficou livre | Bash |
| `simulador_desafio.py` | Monte Carlo: probabilidade real de transformar $5 em $1000 | Python 3 stdlib |
| `simulador_diversao.py` | Monte Carlo: duração da sessão com apostas de $0.30–$0.80 | Python 3 stdlib |
| `vigia-500.py` | **O vigia.** Lê o ecrã (saldo, multiplicador, nº de minas, tabuleiro) por imagem/OpenCV, **sem API nenhuma**, e cobra disciplina. Não clica em nada | Python + OpenCV |
| `vigia_motor.py` · `vigia_visao.py` | O motor (porte do HUD, com paridade testada) e os olhos (binarização, glifos, tabuleiro por cor) | Python |
| `teste-vigia.py` | **209 testes** do vigia: paridade com o JS, glifos, mira, antes-e-depois por campo, tabuleiro por cor, a IA como professora, fixtures reais | Python |
| `ferramenta-captura.py` | Renderiza a página e guarda PNG + caixas dos elementos — só para gerar fixtures de teste | PyQt6 WebEngine |

```bash
node teste-hud.js        # 414 testes: corre isto depois de tocar no userscript
node build-instalar.js   # regenera a página de instalação
node build-demo.js       # regenera a demo visual a partir da mesma fonte
bash servidor.sh         # serve a pasta (instalar por URL + ver a demo)
bash parar-servidor.sh   # pára o servidor, de qualquer terminal
python3 teste-vigia.py   # 209 testes do leitor de ecrã (sem ecrã, sem rede)
python3 vigia-500.py ver # o que o vigia vê neste momento, glifo a glifo
python3 simulador_diversao.py
```

### Instalar o userscript (e a razão de tantas falhas)

Abrir um `.user.js` do disco com duplo clique **não** abre a página de instalação: o browser
limita-se a mostrar o código como texto, e o Tampermonkey só oferece instalar quando o URL termina
em `.user.js` e vem por `http://`/`https://`. Duas vias que funcionam:

1. **`instalar.html`** (gerado por `node build-instalar.js`) — um botão que copia o ficheiro
   exacto para o clipboard, para colar no editor do Tampermonkey. A página calcula um **hash djb2**
   do texto que tem dentro e compara-o com o do ficheiro: se alguém editar o HTML à mão, ela avisa
   em vez de te deixar colar 1000 linhas truncadas.
2. **Por URL** — `bash servidor.sh` e abre `http://127.0.0.1:8123/painel-500.user.js`. Como o URL
   termina em `.user.js`, o Tampermonkey mostra a página de instalação dele. Para parar:
   `bash parar-servidor.sh` (funciona de outro terminal; confirma que a porta ficou livre), ou
   <kbd>Ctrl</kbd>+<kbd>C</kbd> se o arrancaste tu.
3. **Sem Tampermonkey nenhum** — F12 → Console no site, e cola o script (o botão do
   `instalar.html` copia-o). O script não usa nenhuma API do Tampermonkey (`@grant none`), por isso
   corre igual. O que perdes é a persistência: **a cada recarregamento da página tens de colar outra
   vez**. A configuração fica em `localStorage` nos dois casos, por isso mudar de método não perde
   nada.

Nunca uses **Utilitários → Importar**: isso é para backups `.zip`/`.json`, e dá erro com um `.js`.
E o mais comum de tudo: colar o script e perder a **primeira linha** (`// ==UserScript==`) — o
Tampermonkey recusa qualquer userscript cuja metadata não comece na linha 1.

---

## 1. Painel de sessão (`painel-sessao.html`)

Abre o ficheiro directamente no browser. Não precisa de servidor, de conta, nem de internet.

**O que faz**

- **P/L ao vivo** em $ e em % da banca inicial, com o saldo actual em destaque.
- **Meta opcional**: quanto falta para o objectivo e o multiplicador que seria necessário.
- **Orçamento de volume**: a métrica central. A tua banca compra `banca / edge` de volume
  apostado. Com $5 e 1% de edge são **$500 de volume**, ou ~1.667 rondas de $0.30. O painel
  mostra quanto já consumiste — é o teu stop-loss exacto, em vez de "quando estiver azarado".
- **Guardrails**: barra de tempo de sessão, limite configurável, rondas restantes estimadas,
  tempo restante estimado, e alertas que aparecem sozinhos quando estás a passar dos limites.
- **Coach de próxima ronda**: lê a tua rotação e diz o stake e o multiplicador/config de minas
  da ronda seguinte. Um clique por ronda — ou uma tecla: `1` ganhei · `2` perdi · `3` push ·
  `espaço` pausa · `z` desfazer. Nada é automatizado.
- **Freno de mão (TiltGuard)** — ver secção 2.
- **Monte Carlo ao vivo**: 10.000 simulações do teu estado actual, em ~250 ms, no browser.
  Devolve P(chegar à meta), P(cruzar saldo positivo), P(duplicar em algum momento),
  P(subir 20%) e a mediana de rondas restantes. As probabilidades são de **pico** — não
  dependem do teto de simulação, por isso são honestas.
- **Gráfico canvas** do saldo real contra a recta `E[saldo] = banca − edge × volume apostado`.
  Ver o teu saldo a colar-se à linha tracejada é a forma mais directa de perceber que o custo
  da sessão é determinístico e a sorte não entra na conta.
- **Export JSON/CSV** do registo completo (bom para análise em Excel/pandas).
- **Persistência** em `localStorage`: sobrevive a um refresh.

**Motor de estratégia**

A rotação é texto editável, uma linha por ronda:

```
dice 2.0          → Dice a 2.00x  (chance de acerto = 99% / 2.00)
mines 3 2         → 3 minas, 2 casas seguras  (multiplicador calculado por combinatória)
mines 5 5         → 5 minas, 5 casas seguras
```

O multiplicador das minas é derivado da distribuição hipergeométrica:

```
p(sobreviver k casas com m minas em 25) = C(25−m, k) / C(25, k)
multiplicador                            = (1 − edge) / p
```

**Princípio de design: o stake é fixo por decisão de disciplina.** O que roda é o multiplicador e
o número de minas — e isso é *matematicamente gratuito*: o custo por ronda é `stake × edge`,
independente do multiplicador. Subir o stake é a única variável que encurta a sessão (de $0.30
para $0.80, a duração mediana cai 82%).

---

## 2. Freno de mão (TiltGuard)

Um travão de mão que dispara sozinho, em três situações diferentes, com um overlay de ecrã
inteiro que **bloqueia as apostas** até o contador chegar a zero.

| Gatilho | Padrão | Porquê este gatilho |
|---|---|---|
| Cadência de rondas | a cada 25 rondas → 45 s | Cansaço de julgamento. Não é sobre dinheiro, é sobre atenção |
| Sequência de derrotas | 5 seguidas → 3 min | O momento exacto em que se aposta na emoção |
| Ganho grande | ≥ $1 numa ronda → 2 min | O momento exacto em que se sobe o stake para "aproveitar a maré" |
| Pausa voluntária | botão / `espaço` → 2 min | Treinar a decisão de parar |

Cada disparo mostra: o motivo, uma contagem decrescente, quatro instruções concretas
(levantar, água, olhar ao longe, não abrir o chat), e os números honestos da sessão — saldo,
P/L, volume consumido, **edge já pago**.

O rodapé de cada pausa diz sempre a mesma frase, que é o ponto todo:

> *Esta pausa custou-te $0.00 de edge. Foi a única coisa gratuita da sessão.*

Também há um **medidor de ritmo** em rondas/minuto, com barra que passa a amarelo e vermelho
quando aceleras — a velocidade é o que come o orçamento, não a má sorte.

**Cada pausa é registada** (tipo, duração real, ronda em que ocorreu) e entra no export JSON/CSV.
Se reabrires o separador a meio de uma pausa, ela continua — o estado está em `localStorage`.

### 2.1 Botão de disciplina

Três controlos desenhados para uma premissa específica: *o utilizador sabe que vai ceder ao impulso.*
Nenhum deles aposta. Nenhum deles proíbe. Todos tornam a decisão emocional **visível e cara**.

**🛡 «Vou apostar com disciplina»** — o botão que canaliza a urgência de agir para o lado certo.
Abre um overlay com o stake e o multiplicador exactos da ronda do plano, e quatro passos que
reduzem a ronda a uma execução mecânica no site. Tu executas; o painel não.

**⚡ «Estou com impulso de fugir ao plano»** — registado, nunca seguido. Cada carregamento:

1. Grava o impulso com o estado completo (saldo, volume, sequência de derrotas).
2. Corre um Monte Carlo A/B medindo o custo da cedência. Exemplo real de output:
   *"Se tivesses subido o stake de $0.30 para $0.80, a tua sessão mediana passaria de **483**
   para **77** rondas. Ficaste com as 483."*
3. Inicia uma pausa de 2 minutos, transformando a urgência numa pausa.

O contador mostra sempre a mesma frase: *"Zero deles virou aposta."*

**Gate de alteração de plano** — se quiseres mesmo mudar o stake, o painel não te proíbe. Cobra-te:

- Uma **simulação A/B ao vivo** (1.500 trajectórias para cada lado) do tempo de sessão mediano
  antes e depois da alteração, com o efeito em percentagem.
- **60 segundos** de espera obrigatória antes do botão de aplicar sequer ativar.
- Três confirmações explícitas, incluindo *"não é reacção a uma sequência de perdas"*.
- Registo permanente em `deviations[]` no export.

**Modo Guerra** — quando o orçamento de volume ou o limite de tempo são ultrapassados, ou o saldo
cai abaixo do stake, o painel inteiro bloqueia. Não há botão de continuar: só confirmar o fim, ou
abrir uma sessão nova (com `confirm()` e registo de desvio). O ecrã diz explicitamente:

> Este painel não te consegue impedir de abrir o site. Só te consegue obrigar a ler isto antes de
> o fazeres. O travão que trava de verdade é o limite de depósito na tua conta.

---

## 3. HUD dentro do site (`painel-500.user.js`)

Instala com Tampermonkey / Violentmonkey. Aparece como painel lateral no csgo500.com — **uma só
janela**, e tudo com dados reais.

### Como obtém os dados reais sem automatizar nada

Este é o ponto central do módulo. O HUD **não registra rondas por ti: ele infere-as.** Observa a
variação do saldo e deduz o que aconteceu:

```
delta == −stake                   →  derrota
delta == +stake × (mult − 1)      →  vitória
delta == 0                        →  nada
delta grande positivo             →  depósito / ganho fora do plano
delta grande negativo             →  saque / aposta fora do plano
qualquer outra coisa              →  indeterminado (fica no log para corrigires)
```

Ganhas o que querias — "funcionar tudo em real, sem registo manual" — sem um único clique
sintético. É observação, não execução. Uma vez que o plano sabe o stake fixo e o próximo
multiplicador da rotação, o delta do saldo identifica a ronda exacta.

### Deteção do jogo e edge embutido

O HUD sabe em que jogo estás **pelo URL** (`location.pathname`), sem tocar na página: `/pt/mines`
→ Mines, `/pt/dice` → Dice, e assim por diante, ignorando o prefixo de idioma.

E traz a **tabela de house edge embutida**, com os valores publicados pela própria página de ajuda
do 500 — Dice 1%, Mines 1%, Keno/Limbo 2%, Plinko 4%, Towers 5%, Roulette 6,66%, Crash ~6%,
Cases 10%, Blackjack 0,52%. Recomendar uma aposta sem conhecer a margem é recomendar às cegas;
por isso a margem está no código, e não na tua cabeça.

### Motor de recomendação

O painel diz, para o jogo onde estás e para a ronda do plano, **o que se pode ganhar e perder** —
com o edge sempre à vista:

| Jogo | O que recomenda |
|---|---|
| **Dice** | «APOSTAR 1.10x · $0.30», com chance de acerto, ganho, perda e o EV (−edge × stake). Se o site estiver num valor diferente do plano: **«AJUSTAR para 1.10x»** |
| **Mines** | Lê o multiplicador no ecrã, **inverte-o** para descobrir quantas casas abriste, e diz **«ABRIR MAIS 1»** ou **«RETIRAR»** conforme o alvo do plano; fora do alvo: **«FORA DO PLANO · RETIRAR»** |
| **Plinko, Towers, Roulette, Cases…** | **«SEM RECOMENDAÇÃO DE APOSTA»** + o edge do jogo e o EV de apostar ali |
| Sem saber ler o ecrã | **«ENSINAR O HUD A LER»** — nunca inventa uma jogada |

O achado mais útil está na linha do EV das Mines, e é contraintuitivo:

> «EV de abrir $0.34 vs EV de retirar $0.34 → diferença $0.00»
> «A margem de 1% foi paga na ENTRADA. A partir daí o jogo é justo: abrir ou retirar é escolha
> de VARIÂNCIA, não de valor.»

Ou seja: nas Mines, **abrir mais uma casa ou retirar vale exactamente o mesmo**, em média. A
margem já foi paga quando a ronda começou. O que decide é quanta variância queres. Isto é contado
no ecrã em vez de ficar escondido, porque é o que impede alguém de acreditar que «mais uma casa»
é uma jogada esperta.

### Preencher a configuração — sem apostar

O botão **«Preencher a configuração no site»** escreve o stake, o multiplicador (Dice) e o número
de minas (Mines) nos campos da página e despacha `Event('input')` / `Event('change')` para o
framework do casino registar — e depois **lê o valor de volta para verificar**. Se o site não
aceitar a escrita (React/Vue controlam o input), o HUD diz-to em vez de te deixar pensar que está
certo.

O limite do que isto faz é exactamente este:

```
PERMITIDO: escrever .value num campo + Event('input'|'change') + ler de volta
PROIBIDO:  .click(), MouseEvent/KeyboardEvent/PointerEvent, Enter, submit(), requestSubmit()
```

Abrir uma casa e retirar são **acções de jogo**, não campos de formulário: o HUD nunca tem sequer
um selector guardado para elas. Quem carrega em Apostar és tu, e a mensagem de confirmação diz
isso mesmo: *«CONFERE NO ECRÃ e carrega tu em Aposta — o clique é teu.»*

Dois detalhes de usabilidade que valem a diferença entre uma ferramenta usada e uma abandonada:

- O campo do **valor da aposta é o mesmo elemento** no Dice e nas Minas, por isso ensina-se uma
  vez e vale para os dois. (Antes disto pedias o mesmo campo duas vezes e concluías, com razão,
  que estava avariado.)
- Como o caminho CSS é visível no painel, há um botão para o **copiar** — o que estiveres a ver
  num campo serve imediatamente para outro.

### A estratégia e o mapa são coisas diferentes

Esta é a distinção que mais confusão causa, e vale a pena ser explícita:

| | Onde está | Precisas de fazer alguma coisa? |
|---|---|---|
| **A estratégia** | No código. Edge de cada jogo, multiplicadores, rotação, EV de cada jogada, travões, orçamento de volume | **Não.** Já está lá |
| **O mapa do site** | No ecrã do csgo500. Em que elemento vive o saldo, e onde estão os campos do valor, do multiplicador e do nº de minas | **Sim,** uma vez por browser |

A mensagem «nenhum campo ensinado» refere-se só à segunda linha. Nada falta à estratégia — o que falta é
que o HUD saiba onde o site *põe* os números, e isso nenhum código adivinha: é específico da página, muda
quando o site redesenha, e um caminho CSS inventado é pior do que nenhum, porque falha em silêncio.

### Descoberta automática (`🔎 Procurar o saldo e os campos por mim`)

Para reduzir isso a **4 cliques em vez de uma caçada**, o HUD pontua candidatos em vez de adivinhar.
Nunca adopta nada sozinho: mostra os melhores com o **texto cru que leu** e tu confirmas com um clique.
Um saldo mal adivinhado estragaria as contas em silêncio; um clique é barato.

O que faz o saldo ganhar pontos: **mudar** entre duas observações (o sinal mais forte de todos — um
rótulo estático não muda), ter uma moeda explícita, estar visível e no topo, estar numa folha curta, e
ter um nome que fale de dinheiro. O que o faz perder: estar dentro de um controlo, ser uma frase que
contém um número («RTP verificado em 2024 pela equipa» não é um saldo), ou ser longo demais.

Uma segunda passagem procura **folhas de texto** (elementos sem filhos) cujo conteúdo pareça dinheiro.
Isto é o que salva a descoberta num site com classes geradas: `css-1x2y3z` não diz nada, mas «5,00 USD»
diz tudo. A varredura é limitada de propósito (20.000 nós, 400 candidatos) e só corre quando carregas no
botão.

Para os campos, a distinção que decide tudo é entre **ler** e **escrever**:

- o **valor da aposta** e o **nº de minas** têm de ser *escrevíveis* (é isso que o botão de preencher faz);
- o **multiplicador das Minas** é *texto* («1.29x»), não um input — basta lê-lo. Sem esta distinção, o
  número sem o qual não há recomendação nenhuma ficaria invisível à busca.

E cada campo é obrigado a escolher **um** papel por **nome**, não por posição: um campo chamado
`mines-count` nunca é atribuído ao valor da aposta, mesmo que esteja mais perto do botão de apostar.

### Aviso sobre o tabuleiro

Um aviso aparece **por cima das minas** e diz o que o plano pede — *ABRIR MAIS 1*, *RETIRAR*,
*FORA DO PLANO* — com a linha do EV e dois botões: **«Vou parar a ronda»** / **«Vou abrir mais 1»**.

Duas propriedades são deliberadas e verificadas por teste:

- **Não bloqueia o jogo.** O contentor tem `pointer-events:none`: consegues clicar nas casas por baixo
do aviso. Está testado no browser — clicar numa casa tapada pelo aviso abre a casa.
- **Não clica em nada.** Os botões registam a *tua* decisão em `decisions[]` e encolhem o aviso para
um selo discreto. É o oposto de automatizar: o HUD pergunta, tu respondes.

E há uma coisa que este aviso **não faz, e não pode fazer**: dizer em que casa está a mina, ou qual é a
«melhor». Nas Mines, todas as casas tapadas têm **exactamente a mesma probabilidade**. Não existe casa
melhor — existe só abrir ou parar. Marcar uma casa com um X seria inventar informação que o jogo não
tem, e seria a pior espécie de mentira: uma seta «recomendada» num tabuleiro faz as pessoas acreditarem
nela. Por isso o aviso diz o contrário, em letras grandes: *todas as casas tapadas têm a MESMA
probabilidade — abre a que quiseres*.

Se ensinares o **tabuleiro** ao HUD (opcional), o aviso pousa por cima dele; se não, fica no topo do
ecrã — funciona na mesma.

### Configurar a ronda sozinho (opcional, desligado por padrão)

Ligando esta opção, o HUD escreve o valor e a configuração de minas/multiplicador do passo actual **sem
ninguém carregar em nada**. A linha está dita com precisão: isto escreve **campos**. Não carrega em
Apostar, não abre casa, não retira. O clique que põe dinheiro em jogo continua a ser humano — e é esse
clique que separa um assistente de um bot.

Guardas, e cada uma tem um motivo:

| Guarda | Porquê |
|---|---|
| Não escreve em pausa | Configurar durante um travão seria contrariar o travão que tu próprio pediste |
| Só na página do jogo do passo | Evita escrever o multiplicador do Dice num ecrã de Mines |
| Uma vez por passo e por ronda | Nunca existe um ciclo de escrita contínuo |
| Registo em `autoLog[]` | Uma falha de escrita aparece, em vez de ser silenciosa |

### Diagnóstico — porque é que (não) está a dar

Um HUD que não funciona **em silêncio** é pior do que nenhum: a pessoa conclui que a ferramenta está
avariada e desiste. Como o saldo alimenta tudo (rondas, orçamento, travões), o painel tem um bloco
que responde à única pergunta que importa quando nada acontece: **porquê**.

São cinco estados, e a distinção entre eles é o que evita o pior diagnóstico possível — dizer "não
dá" quando o problema é "não tens saldo":

| Estado | O que significa | É erro? |
|---|---|---|
| `sem-selector` | Nunca foi ensinado onde está o saldo | Sim |
| `nao-encontrado` | O selector existe, mas já não corresponde a nada (layout mudou? sessão por iniciar?) | Sim |
| `nao-numerico` | Achou o elemento, mas não há número lá dentro | Sim |
| `saldo-zero` | Leu um número, e é zero: **o HUD está bem, a conta é que está vazia** | Não — aviso |
| `sem-movimento` | Lê bem, tem saldo, mas o valor nunca mudou em 8+ leituras: ou não apostaste, ou **estás em modo demo/fun** (aí o saldo real não se move, e não há rondas para detectar), ou o elemento está congelado | Aviso |
| `ligado` | Leu um saldo positivo | — |

O aviso aparece no **topo** do painel, e só quando há problema (um aviso permanente deixa de ser um
aviso).

Mais duas coisas que fazem a diferença entre "não sei o que se passa" e "sei":

- **Contagem de leituras**: quantas foram feitas e quantas trouxeram um valor *diferente*. Distingue
  «não leio nada» de «leio sempre o mesmo» — que são avarias completamente distintas, com remédios
  distintos.
- **Modo debug**: cada mudança de saldo é registada na consola no formato que interessa ver —
  string crua → valor interpretado → classificação da ronda:
  ```
  [Sessão 500] saldo 4.7  ← «4,70 USD»  →  lose (Dice 1.10x)
  ```
  Só as **mudanças**, de propósito: registar 900 ms de leituras iguais enchia a consola e escondia o
  que interessa.

E o botão **Copiar diagnóstico** produz um bloco em texto puro com tudo — estado, URL, jogo, saldos,
contagem de leituras, campos ensinados com o selector e o que lê, e as últimas leituras. É o que
permite diagnosticar um problema sem ter de adivinhar o que está no ecrã de outra pessoa.

### Parser de moeda

Escrito contra os formatos **reais** que observei no site (`199 999,91 USD`, `5 805,80`,
`398,02`), não contra um formato inventado: espaço/nbsp para milhares, vírgula decimal, com
suporte também para `5,805.80` e `1,234.56`.

A ambiguidade `1.234` (1234 em pt, 1.234 em en) está **documentada e resolvida por regra
conservadora**, e o HUD mostra sempre a string crua lida ao lado do valor interpretado — um
erro de leitura fica visível no ecrã em vez de corromper as contas em silêncio.

### Isolamento de estilo

Shadow DOM fechado dentro de um elemento `<p500-hud>` (nome com hífen). Duas camadas: o CSS do
casino não entra no painel e o painel não vaza nada para o site. Nenhuma colisão de nomes é
possível.

### Captura guiada (`🎯 Captura guiada`) — o caminho principal

Não sei qual é o elemento do saldo no DOM do csgo500 — não tenho acesso a uma conta. Em vez de
inventar um selector que rebentaria, entras em modo captura e **clicas**: saldo → valor da aposta →
nº de minas → multiplicador → tabuleiro. O HUD guarda o caminho CSS de cada um.

O que faz isto diferente de um apanhador de um clique só:

- **valida antes de guardar.** Cada elemento clicado é comparado com o papel que estava a ser
  pedido. Clicar no seletor das minas quando o papel é «valor da aposta» é **recusado**, com o
  motivo («isto é uma lista de escolha, não o campo do valor»); uma captura que aceita tudo treina-te
  a confiar numa configuração que pode estar errada;
- **não avança com um clique errado.** O passo fica à espera, com a recusa à vista;
- **o clique é engolido.** É apanhado em fase de captura e a propagação é interrompida: nada no
  casino é accionado por engano. Isto é verificado no browser com um clique real numa casa das
  minas — a casa não abre;
- **o painel é arrastável e minimizável.** Um painel fixo tapa sempre o sítio onde está a coisa que
  te pedi para clicar; arrastá-lo é a resposta honesta a isso;
- **diz o que fez.** O tabuleiro é a *área* que contém as casas: se clicares numa casa, o HUD sobe ao
  pai dela e **diz que subiu**, em vez de o fazer sem avisar.

Durante a aprendizagem, a instrução é literal e sequencial: **«AGORA: clica em <o teu saldo>»** e,
por baixo, **«depois: o campo do valor → o seletor do nº de minas → o multiplicador → o tabuleiro»**.
O que já foi aprendido sai dessa lista e passa para a lista dos ✓. Termina-se com Esc.

Três coisas que a fila faz e que é preciso saber antes de a usar:

- **avança sozinha quando o clique é aceite**, e há **`↩ Voltar`** para o passo anterior — sem ele, um
  campo aprendido por engano só se corrigia repetindo a captura inteira;
- **a fila depende do endereço da página.** Se o HUD não reconhecer o endereço como Dice ou Minas,
  pede só o saldo e o valor da aposta — e **di-lo**, com o endereço à frente e dois botões
  (`＋ campos do Dice` / `＋ campos das Minas`) que juntam os campos que faltam e voltam ao modo de
  captura já apontados ao primeiro deles. Sem isto, o painel anunciava «Mapa aprendido — 2 de 2»
  sobre um mapa a que faltavam três campos, sem que nada o dissesse;
- **ao entrar em captura, o painel grande do HUD encolhe** para a aba — e volta ao que estava quando
  a captura termina (se já estava encolhido, fica encolhido). Um painel aberto tapa metade do que se
  vai clicar, e um clique que caia nele morre ali.

### O fim da aprendizagem não é um silêncio

Quando o último passo fica aprendido, o painel **não se fecha**. Isso deixaria a pessoa a olhar para
um ecrã limpo sem saber se aquilo serviu para alguma coisa. Em vez disso, passa a uma fase de teste:

- diz o que ficou aprendido, com o caminho CSS de cada campo;
- diz o que ficou por aprender, se saltaste algum;
- e oferece o passo seguinte, com nome: **«Agora testa»**. O HUD **escreve a configuração da ronda**
  nos campos que acabaste de ensinar e confirma campo a campo o que o site reteve — e, 400 ms mais
  tarde, se o site **manteve** o valor (um campo controlado por React/Vue reverte depois de aceitar;
  é essa a diferença entre um mapa que funciona e um mapa que parece funcionar);
- e diz o que fazer a seguir, conforme o resultado: se falhou, «escreve à mão este campo»; se passou,
  «**CONFERE NO ECRÃ**, carrega em «Vou apostar com disciplina» e faz tu a aposta — o clique em Apostar é teu».

O teste escreve o valor **do plano** quando existe um para aquele campo, e quando não existe escreve
de volta **o mesmo valor que lá está** — e di-lo. Inventar um valor de teste mudaria a configuração de
quem está a jogar. O que não se escreve (um multiplicador só de leitura, o tabuleiro, que é uma área)
é dito à parte, em vez de contado como falha. O mesmo teste está disponível fora da captura, no botão
`✅ Testar o mapa agora`.

O resultado fica em `#capOut`, uma zona que o render não reescreve, com a lista do que foi capturado
e do que ficou por capturar.

O apanhador de um clique (`btnPick`/`btnTeach`) continua a existir para quando só falta uma coisa —
e passa pela **mesma** validação, porque duas validações para o mesmo gesto divergem sempre.

### Quando o site não deixa escrever: o nº de minas fica «à mão»

No csgo500 o número de minas (1 a 24) **não é um `<select>` nativo** — é uma caixa desenhada, com uma
lista que abre. Isso mudou o que a captura tem de fazer, e vale a pena ser explícito sobre o que
**não** se faz aqui, porque é a pergunta certa:

> «Não dá para alterar o elemento no site? E não dá para alterar os elementos todos, de forma que o
> programa funcione da forma que queremos?»

Tecnicamente dá — um userscript pode injectar e reescrever DOM. **Este não o faz, de propósito**, por
três razões medidas e não estéticas:

- **o site é a única fonte de verdade sobre o dinheiro.** Se eu substituir o controlo, a «confirmação»
  passa a ser eu a ler a minha própria invenção. O ciclo que faz este HUD ser honesto é *escrever → ler
  de volta → comparar numericamente*; um controlo meu quebra-o, e o pior modo de falha possível é um
  programa que mente sobre o estado da ronda;
- **o React é dono do DOM.** Qualquer coisa injectada dentro de um componente React é apagada no
  render seguinte, a horas aleatórias. É exactamente por isso que o HUD vive num `<p500-hud>` com
  Shadow DOM: fora do alcance do React. Reescrever os controlos do casino seria entrar lá dentro de
  propósito;
- **um controlo que eu construo é um controlo que eu passo a ter de manter**, e que falha em silêncio
  quando o site muda. Um mapa que aponta para o sítio errado dá uma ronda com a configuração errada.

O que ele faz, em vez disso, são duas coisas, por esta ordem:

1. **procura o campo de verdade atrás do que clicaste.** Muitos casinos escondem um `<input>`/`<select>`
   nativo dentro do componente desenhado (é o que serve o teclado e o telemóvel). A procura é
   **limitada**: sobe no máximo 4 níveis e olha os irmãos imediatos, com um orçamento de 80 nós —
   nunca a página inteira, porque um selector apanhado numa travessia global muda de significado
   quando o site muda. Se o campo existir, guarda-se **esse** e a escrita volta a funcionar pelo
   caminho normal, sem um único clique. Se o que clicaste tem campos lá dentro, a nota di-lo:
   `o que clicaste é DIV#caixa[role=combobox] · 1 campo(s) lá dentro — mas o campo que se ESCREVE
   está dentro do que clicaste (SELECT[seletor]): guardei esse`;
2. **se não existir nenhum, o HUD admite-o e passa a DIZER o número.** O controlo é aceite como
   **«à mão»**: fica guardado onde está (para te poder apontar o sítio), a lista do painel mostra
   `mines ✓ (à mão)`, o aviso do painel escreve **«ESCOLHE 3 MINAS no seletor do site»**, e o
   preenchimento automático devolve uma **instrução** em vez de uma escrita que falha. Recusar um
   controlo que usas em todas as rondas era responder «não» a uma pergunta que ninguém fez.

Se clicares numa **opção** da lista que abriu (o «3» que aparece lá dentro), o HUD guarda a **caixa que
abre a lista** e diz que foi isso que fez. A razão é concreta: quando a lista fecha, a opção deixa de
existir no DOM — guardá-la era dar-te um mapa que funciona uma vez e depois aponta para o vazio.

A fronteira continua onde estava: **nenhum clique no site, nenhum evento de rato ou teclado**. O HUD
não escolhe a opção por ti — diz-te qual é. Um «△ à mão» no mapa é a diferença entre um mapa completo
e um mapa que *parece* completo.

O que continua a ser recusado: um `<div>` que não seja nada disto (sem papel de controlo, sem campos
lá dentro, sem número nenhum) — e o motivo passou a dizer **o que ele viu**, em vez de só «não deu»:
`isto é DIV.div · sem campos lá dentro e não dá para escolher o número de minas…`. Uma captura que
aceita tudo treina-te a confiar numa configuração errada.

### Garantia de desenho, verificada por teste

A secção 6 da suite percorre o **código executável** (com comentários e literais removidos) e
falha se aparecer `.click()`, `MouseEvent`/`KeyboardEvent`/`PointerEvent`, `.submit()`,
`requestSubmit()`, `fetch()`, `XMLHttpRequest`, `sendBeacon` ou qualquer função de aposta. Além
disso verifica, em duas frentes, que a escrita nos campos é inofensiva:

- no **código**: todos os `new Event(...)` criados são, sem excepção, `input` ou `change`;
- no **comportamento**: o stub de DOM regista os eventos que *chegam* ao campo, e o teste exige
  que a lista seja exactamente `input,change` — nada de cliques.

O limite deixa de ser uma promessa e passa a ser um teste que falha o build.

**414 testes, 20 secções:** parser de moeda · rotação (combinatória das Mines) · leitura do saldo ·
deteção de rondas · travões · não-automação · deteção do jogo · tabela de edge · motor de
recomendação · preenchimento · ensino dos campos · descoberta automática · selects · captura guiada ·
diagnóstico · o **nº de minas desenhado pelo site** (o controlo que não se deixa escrever) ·
a **fila da captura** (fila curta, juntar campos, voltar atrás, cliques tapados pelo HUD) ·
e um **fuzz
de 1.680 estados** (16 URLs × 14 rotações × 7 estados de campos) que exige que o motor **nunca lance
excepção** — porque `recommend()` corre a cada 900 ms no site, e uma excepção ali não é um teste
vermelho: é o painel inteiro a desaparecer enquanto tu apostas.

As funções de pontuação da descoberta são **puras** (recebem texto e metadados, devolvem pontos), e é
por isso que são testáveis sem browser: o DOM é a parte fina, a decisão é a parte testada.

```bash
node teste-hud.js          # 414 testes, zero dependências
```

### Ver a coisa a correr (sem tocar em casino nenhum)

`mock-casino.html` é um casino **falso** (saldo, formatos de moeda e campos de aposta) que carrega
o userscript real. Como muitos ambientes servem um ficheiro de cada vez — e o `<script src>` de
um ficheiro irmão daria 404 — há um passo de construção que gera uma demo self-contained *a partir
da mesma fonte*, sem duplicar código:

```bash
node build-demo.js         # mock + userscript → demo-hud.html
```

A demo tem botões para entrar em `/pt/dice`, `/pt/mines` ou `/pt/plinko` (mudando o caminho do
browser), ensinar os três campos com um clique, preencher a configuração e ver a recomendação a
mudar de «ABRIR MAIS 1» para «RETIRAR» ao atingires o alvo do plano. O botão de apostar da demo
não aposta nada — e diz porquê.

A demo tem também um **nº de minas DESENHADO**, como o do site real: uma caixa `role=combobox` que
abre uma lista de `<div>`, **sem** `<input>` nem `<select>` por baixo. É o caso que faz o HUD responder
«à mão» em vez de recusar — e o mesmo botão da consola que o testa está escrito no próprio cartão da
demo.

---

## 3.5 Vigia-500 (`vigia-500.py`) — ler o ecrã pelos olhos, sem API nenhuma

O HUD lê o **DOM** do site. Isto lê os **pixels**. É a resposta à pergunta «e se o site mudar de
estrutura, ou se o campo estiver dentro de uma caixa desenhada que não se deixa escrever?»: uma
imagem não tem selectores, e um número no ecrã é um número.

```bash
python3 vigia-500.py               # UM COMANDO: faz o que falta e começa a vigiar
```

E é isto. O `tudo` (que é o que corre sem argumentos) vê o que ainda não sabe e trata disso antes de
começar a olhar para o ecrã: aponta as regiões se não houver nenhumas, ensina os desenhos que faltam,
pede a referência da grelha se ela não existir, e só depois entra no modo de sessão. Cada passo só
aparece se faltar — num mapa já feito, o comando começa a vigiar e não pergunta nada. Com `--png`
(e em vez do ecrã) faz o mesmo e sai com **uma** leitura, que é o modo de ensaio.

Os passos separados continuam a existir, para quando se quer mandar só uma coisa:

```bash
python3 vigia-500.py calibrar      # aponta para o saldo, o multiplicador, as minas e a grelha
python3 vigia-500.py aprender      # responde UMA vez por campo ao que está escrito nele
python3 vigia-500.py ver           # mostra o que VÊ: cada glifo, o tamanho e o rótulo que tem
python3 vigia-500.py ler           # uma leitura, com o veredicto do motor
python3 vigia-500.py vigiar        # modo sessão: lê de 900 em 900 ms, com painel e travões
```

### Um processo, uma captura, e nenhum pixel a mais

Uma sessão fica a correr ao lado do jogo durante horas, portanto o que ela gasta importa. As
decisões, todas medidas nesta máquina (2560×1440):

| Antes | Agora | Ganho medido |
|---|---|---|
| capturar o ecrã inteiro a cada leitura | capturar a caixa que contém as quatro regiões | 11,1 MB e 50 ms → **1,5 MB e 12,5 ms** |
| abrir um handle do ecrã a cada captura | um `mss` por processo | uma chamada ao sistema por leitura a menos |
| quatro comandos, quatro procesos com os seus imports | um comando, um processo | o OpenCV sozinho custa ~1 s a importar, quatro vezes |
| painel a acordar a cada 120 ms | 250 ms | metade dos despertares, para uma etiqueta de texto |

Quatro capturas pequenas copiam menos que uma grande, e é tentador concluir que são mais baratas —
não são, porque cada chamada ao sistema tem um custo fixo (~6 ms aqui). A escolha é assim feita por
medição: uma só captura enquanto o desperdício (a caixa menos a soma das regiões) for menor que
~4 MB; acima disso, uma por região. A primeira versão desta regra comparava só áreas e escolhia a
opção **mais lenta** — está nos bugs, abaixo.

Não fala com o casino (não há API, e usá-la seria abuso), não tem selectores, **não clica em nada**
— o clique em Apostar continua a ser o último acto humano da ronda, exactamente como no HUD.

### Calibrar é APONTAR, não desenhar caixas

A pergunta que o programa faz é «aponta para o NÚMERO do saldo», e não «desenha uma caixa à volta do
saldo». A diferença não é de gosto: descobrir onde um texto começa e acaba é trabalho dele, e é
trabalho que ele sabe fazer — aponta-se o ponteiro, ele acha o caracter debaixo dele, mede a linha
pelo TAMANHO DOS VAZIOS (entre dois caracteres desta fonte há 1 a 7 px; um espaço a sério tem o
dobro) e devolve a caixa. **Antes de aceitar, vê-se o recorte ampliado do que vai ser lido** — é esse
passo que transforma uma aposta às cegas numa decisão.

| Gesto | O que faz |
|---|---|
| clicar no texto | propõe a caixa (e mostra o recorte ampliado) |
| <kbd>Enter</kbd> | aceita e passa à região seguinte |
| arrastar | corrige à mão, se a proposta saiu torta |
| <kbd>Esc</kbd> | salta a região (o `tabuleiro` é opcional) |

A grelha das Minas são **dois** cliques — o centro da primeira casa e o da última —, e a caixa sai
por aritmética (entre os dois centros há exactamente 4 passos numa grelha de 5). Apontam-se dois
pontos que se vêem; a conta é do programa.

### Ensinar é responder UMA vez por campo

```
  o que está escrito aí? (tal e qual; `_` = desenho que não é número; Enter = não sei; g = desenho a desenho)
```

Em vez de catorze perguntas do género «que carácter é este desenho?», escreve-se o que está no ecrã
(«5,00 USD») e o programa alinha os caracteres com os desenhos. É mais rápido, é o que uma pessoa faz
naturalmente, e **erra-se menos** — um rótulo errado é pior do que um glifo em falta, porque fica
gravado.

- `_` marca um desenho que não se consegue datilografar (a setinha da caixa das minas, um logótipo):
  é aprendido como «não é número»;
- `?` deixa aquele desenho **por aprender**, em vez de o adivinhar;
- o **sinal de menos** conta como número (um saldo negativo lido como positivo é o erro que não se
  pode permitir);
- se a contagem não bater — escreveste 7 caracteres, ele viu 6 desenhos — **não se aprende nada**:
  uma contagem diferente pode querer dizer que dois caracteres estão colados no ecrã, e a partir
  desse aviso as perguntas passam a ser uma a uma (`g`, ou `--glifo-a-glifo`).

Com `--ia`, é o modelo de visão que transcreve o campo inteiro (uma chamada por campo, não catorze),
e responde-se só ao que ele não conseguir ler.

### Porque é que não há OCR nenhum

O número do saldo é **texto renderizado numa fonte fixa**. Um OCR genérico é uma máquina cara para
um problema pequeno, e a *única* coisa que ele acrescenta é a taxa de erro: corta-se a linha em
glifos pela projecção das colunas e, para cada glifo, guarda-se uma **assinatura** (12×18, engrossada
1 px, sha1). A primeira vez que um glifo aparece, o programa **pergunta o que é** e fica aprendido
para sempre naquela fonte e naquele tamanho. O «3» deste site é *exactamente* o mesmo desenho sempre:
não há 3% de erro a adivinhar dígitos parecidos. E quando muda (outro zoom, outra fonte), a assinatura
muda, o programa **não reconhece** e pergunta — em vez de inventar.

Cada glifo aprendido fica gravado como PNG minúsculo em `glifos/<assinatura>_<rótulo>.png`. A pasta é
a auditoria: abre-la e vês exactamente o desenho que o programa associou a cada carácter. (Os testes
aprendem para uma pasta temporária, para esta auditoria não mentir.)

E se **um só** glifo da linha estiver por aprender, o valor é `None` — não é o número com um `?` no
meio. «0.» é um número que se lê bem e está errado; metade de um número não é um número.

### O tabuleiro das Minas lê-se por COR, não por OCR

As 25 casas são comparadas com a referência do estado «tudo tapado» (aprendida **uma vez**, no início
de uma ronda, quando é esse o estado que existe) e classificadas em *fechada* / *aberta* / *mina*.
Sair de «fechada» exige evidência em **duas medidas independentes** (diferença estrutural e cor):
decidir por uma só é o caminho mais curto para um alarme falso, e um alarme falso num painel de
disciplina ensina a ignorar o painel.

### Duas medições do mesmo número

A contagem das casas abertas sai de **duas** vias independentes: as células (cor) e o multiplicador
(`reverso_casas`). Quando discordam, o motor não escolhe a mais bonita — **cala-se**: «LEITURA EM
DESACORDO». Isto aconteceu a sério durante a construção (eu inventei um `1.69x` para 3 minas, que na
verdade corresponde a 4 casas) e foi o programa a apanhar-me.

### A IA entra como PROFESSORA, não como leitora

`--ia` liga um modelo de visão para **transcrever o campo** (ou, quando a contagem não bate, cada
desenho de uma vez). Não é para ler todas as rondas: um modelo é bom a ler «5,00» num recorte
pequeno, e é mau a ler o mesmo número de forma reprodutível mil vezes. O que ele responde é convertido
em rótulos e gravado no dicionário local; a partir daí a leitura é determinística, offline e auditável
— a IA pode estar em baixo, a chave pode expirar, que o programa continua a ler o mesmo número. Se a
resposta não servir (não é um carácter só, ou é uma frase), o glifo **não** fica aprendido e a pergunta
passa para ti: é a diferença entre um professor e um oráculo.

A chave vem do ambiente (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, com `ANTHROPIC_MODEL` e
`--ia-endpoint`), nunca do código. A ordem é: endpoint explícito → Anthropic → qualquer serviço
compatível com OpenAI. O caminho está coberto por teste com um modelo de mentira, porque o contrato
(pergunta uma vez, nunca duas; resposta má não ensina nada; rede caída não rebenta a sessão) é o que
interessa garantir — não a disponibilidade de um serviço em particular.

### As fixtures do vigia (e como se reproduzem)

Os testes correm sobre **PNGs de verdade** da página de demonstração, não sobre desenhos que eu fiz
para passar:

```bash
bash servidor.sh                                       # serve o mock na 8123
python3 ferramenta-captura.py --url http://127.0.0.1:8123/demo-hud.html \
    --saida capturas/demo.png --elementos "#wallet,#grid,#mines-mult,#mines-desenhado" --texto
python3 ferramenta-captura.py --url http://127.0.0.1:8123/demo-hud.html \
    --saida capturas/demo-3abertas.png --altura 1421 --texto \
    --antes "document.querySelectorAll('#grid div').forEach(function(c,i){if(i===0||i===6||i===12)c.click();});document.getElementById('mines-mult').textContent='1.47x';"
cp vigia-500.json capturas/demo-vigia.json              # o mapa das fixtures (separado do teu)
```

O `ferramenta-captura.py` usa o DOM — e só ele — para eu saber onde as coisas estão **na imagem**. O
programa que lê o ecrã nunca fala com DOM nenhum de casino: é essa separação que o torna imune às
mudanças do site.

A prova que interessa está na secção [7] dos testes: a referência das casas tapadas é aprendida numa
captura e aplicada a **outras**, e o resultado tem de ser 0, 2 e 3 casas abertas — respectivamente —
com o mesmo dicionário de glifos. Do pixel ao veredicto, com `RETIRAR` no fim.

### Testes

```bash
python3 teste-vigia.py     # 209 testes: paridade com o JS, glifos, mira, tabuleiro por cor, IA, fixtures
```

A secção [1] corre o **userscript verdadeiro** em Node (`ponte-motor.js`) e compara o motor Python
número a número com ele: o motor foi portado do JavaScript, e um porte é uma segunda verdade — duas
verdades divergem sempre. O resto vai de imagens sintéticas com fonte fixa às fixtures reais.

### Limites honestos

- **Isto não ganha dinheiro.** O edge continua a favor da casa, e nenhuma leitura muda isso: a
  margem das Minas (1%) é paga na entrada, e a partir daí abrir ou retirar é uma escolha de variância,
  não de valor.
- **Isto não substitui a disciplina.** Lê melhor do que o HUD em relação ao site (não depende do DOM),
  mas um leitor não decide nada — o clique continua a ser teu.
- **Precisa de calibração por ecrã.** As regiões são coordenadas absolutas: outro monitor, outra
  escala do Windows (125%, 150%) ou a janela noutro sítio deslocam tudo. O programa avisa quando o
  tamanho do ecrã mudou, mas quem re-calibra és tu.
- **A assinatura depende do tamanho da fonte.** Mudar o zoom do browser faz o programa voltar a
  perguntar. É o modo de falha certo (perguntar em vez de ler mal), e está testado.

---

## 4. Limites deliberados deste projeto

Isto **não** é um bot, e a fronteira é intencional:

| Não faz | Porquê |
|---|---|
| Não coloca apostas, nem preenche e confirma | O clique em Apostar é o último acto humano da ronda, e é de propósito |
| Não faz login por ti | Nunca manuseia nem guarda credenciais |
| Não fala com nenhuma API do casino | Não há API pública, e usar uma privada seria abuso |
| Não faz pedidos de rede, de nenhum tipo | O HUD corre dentro da página, mas nunca chama `fetch`/`XMLHttpRequest`/`sendBeacon` — é verificado por teste |
| Não abre casa nem retira nas Mines | São acções de jogo, não campos de formulário: não existe sequer um selector guardado para elas |
| Não reescreve, injecta nem substitui controlos do casino | Um controlo meu a fingir de controlo do site quebra o ciclo *escrever → ler de volta → confirmar*, e a confirmação passaria a ser a leitura da minha própria invenção |
| Não clica para escolher nada, nem em listas desenhadas | Se não há campo escrevível, o HUD **diz** o número e escolhes tu — ver «o nº de minas fica «à mão»» |

Há uma distinção que vale a pena ser explícita, porque é fácil confundi-la:

- **O painel de sessão** (`painel-sessao.html`) não lê o csgo500.com, e não pode: é servido de
  `127.0.0.1` e o browser bloqueia leitura cross-origin. É um registo manual, e o registo manual
  obriga-te a olhar para o número.
- **O userscript** corre *dentro* da página do casino, por isso pode ler o saldo e **escrever a
  configuração** nos campos. Lê, preenche, e pára aí. A diferença entre «preencher o formulário» e
  «submeter o formulário» é toda a diferença que resta entre uma ferramenta de disciplina e um
  bot — e é por isso que a verificação é feita por comportamento, no stub de DOM, e não só por
  lint.

No **painel de sessão** o registo é manual — um clique ou uma tecla por ronda — e isso é uma
vantagem, não um defeito: obriga-te a olhar para o número antes de avançar. No **HUD** esse registo
desaparece, porque a ronda é inferida do saldo; o intervalo entre rondas passa a ser preenchido
por uma decisão tua sobre o formulário, não por uma métrica de disciplina. A velocidade é
precisamente o que come o orçamento (a 1,5 s por ronda os $5 duram 42 minutos de edge; a 6 s
duram 2h48).

**Porque não existe um botão "apostar por mim".** Três razões, por ordem de importância:

1. É a única coisa neste projecto que pode custar dinheiro real. Automatizar apostas viola os
   termos dos casinos; o desfecho típico é bloqueio de conta e **confisco do saldo**, incluindo
   ganhos legítimos. Arriscar o saldo todo por conveniência é uma troca má.
2. Contornar detecção é pior, não melhor. A detecção moderna não olha para o intervalo entre
   apostas — olha para entropia de input, regularidade de timing e scoring de risco no servidor.
   Um script com pausas perde essa corrida por construção.
3. **E o argumento decisivo: automatizar não muda nada.** O valor esperado de uma aposta é
   `stake × edge`, seja dada por um humano ou por um script. Não há ganho nenhum. O único efeito
   de acelerar é chegar ao fim do orçamento mais depressa — e eliminar o intervalo entre rondas,
   que é precisamente onde a decisão acontece.

**A objecção "não tenho disciplina, por isso dá-me um botão que me obrigue" tem uma falha formal.**
Esse botão não retira o acesso ao site. Continuas a poder apostar directamente, com ou sem ele.
Logo o botão não obriga nada: acrescenta apenas uma **segunda via de aposta, mais rápida que a
primeira**. Quem não tem disciplina para seguir o plano também não tem disciplina para usar só o
botão — o problema fica exactamente igual, mas mais rápido.

Há aqui uma inversão que vale a pena nomear. O que funciona para quem se conhece é um
**dispositivo de compromisso**: torna a acção má difícil e a boa automática (Ulisses amarrado ao
mastro não pediu um barco mais rápido). O botão de apostar faz o contrário — reduz a fricção na
acção de que se quer menos. É um acelerador colado ao travão.

Se a premissa é *"sei que vou ceder"*, a resposta correcta não é automatizar: é
**tornar impossível perder mais do que o orçamento, independentemente do que se faça** — limite
de depósito e auto-exclusão na conta. Um plano quebra-se às 3 da manhã; um limite de depósito não.

O projecto faz o oposto do botão: torna a deliberação mais fácil de cumprir do que de evitar.

---

## 5. Simuladores de investigação (Python)

### `simulador_desafio.py`

Responde à pergunta "dá para ir de $5 a $1000?". Resposta curta: **não, no máximo 0,4950%**.

Mede: bold play óptimo, bold play só com apostas de 2x (Dubins–Savage), escala de multiplicador
fixo, Mines com configuração óptima, martingale, stake variável, anti-martingale e grind.
Confirma empiricamente a identidade contabilística:

```
E[saldo final] = banca − edge × (volume total apostado)
```

### `simulador_diversao.py`

Responde à pergunta certa para quem quer jogar com $5: **quanto tempo dura a sessão?**

Mede mediana de rondas, percentis p10/p90, probabilidade de tocar em $10, e o pico de cada
estratégia. Resultado central: **o número de decisões é a única alavanca real** —
e, para diversão, mais decisões é melhor.

```bash
python3 simulador_desafio.py
python3 simulador_diversao.py
```

Sem dependências externas. Python 3.8+.

---

## 6. Bugs encontrados durante a construção

Ficam documentados porque a depuração é metade do trabalho:

**1. Uma métrica que media a ferramenta, não a realidade.** A primeira versão reportava
"P(terminar em verde)" = 6,1%. Esse número dependia do *tecto de rondas* da simulação, não do
comportamento do jogador — era artefacto, não sinal. Substituído por **probabilidades de pico**
(P(cruzar saldo positivo), P(duplicar em algum momento)), que não dependem do corte.

**2. Detecção de transição em vez de condição de estado.** O tick do TiltGuard usava um flag
`wasLocked` que só disparava se o intervalo *observasse* o estado bloqueado. Se o separador
estivesse em segundo plano, ou se a pausa expirasse sem o tick a ver, a pausa **nunca era
registada** e o contador de derrotas nunca reiniciava. Corrigido para uma condição de estado:
`if (S.lockKind && Date.now() >= S.lockUntil) releaseLock()`. Testado com expiração forçada.

**3. `else if` onde era preciso `else`.** O overlay do Modo Guerra não fechava ao confirmar: a
condição de limpeza era `else if (!gatilho)`, mas o gatilho do volume **nunca desaparece** — o
volume já foi gasto. O overlay ficava preso para sempre. Corrigido para um `else` simples, com o
porquê comentado no código.

**4. `beforeunload → save()` que eu próprio adicionei** ressurrectava o estado em `localStorage`
depois de um reset/limpeza. Removido — `save()` já corre em cada mutação.

**5. Listeners em elementos que ainda não existem.** As checkboxes do gate são criadas por
`innerHTML` dentro de `openGate()`, portanto estavam `null` no arranque e os listeners nunca se
ligavam. Substituído por **delegação de eventos** no contentor `#gateChecks`, que funciona com
filhos criados dinamicamente.

O padrão dos cinco é o mesmo: **assumi que algo era verdade em vez de o testar.** Foi por isso que
todos foram apanhados por um teste que exercita o fluxo real, e não por leitura de código.

**6. Informação calculada e deitada fora.** A classificação de ronda calculava o motivo
(`"depósito ou ganho fora do plano"`) e depois **não o guardava** — o utilizador via `external`
e não sabia se tinha sido um depósito, um saque ou uma aposta maior que o plano. Apanhado pelo
teste `nota do external menciona deposito`. O adversário mais perigoso de uma heurística é a
heurística silenciosa.

**7. `f` fora de escopo, duas vezes.** Ao acrescentar os botões de copiar o caminho usei, dentro de
`renderRec()` e de `recommend()`, uma variável `f` que só existia em `preencherNoSite()`. Não é um
erro subtil de lógica: é um `ReferenceError` que derruba a função inteira. Apanhado porque o
harness de Node **executa o ficheiro real** em vez de testar uma reimplementação — e ambos os casos
rebentaram no primeiro teste que passou pela função.

**8. `alvo.toFixed(2)` sobre `null` — o pior dos bugs desta série.** No Dice, se a rotação não
tivesse passo de Dice *e* o campo do multiplicador não estivesse ensinado, `alvo` era `null` e o
`toFixed` lançava. Como `recommend()` corre a cada tick de 900 ms, bastava estar na página do Dice
para o painel inteiro morrer — e a correr «a correr bem», porque o `try/catch` do arranque não
apanha excepções lançadas dentro do loop. **Nenhum teste unitário o apanhou**: todos os meus
estados de teste no Dice tinham ou um passo na rotação ou o campo ensinado. Apareceu na primeira
vez que abri a demo construída num browser real e perguntei pelo caminho mais estúpido possível.
A correção não é um `if` defensivo: é a mesma honestidade da branch das Mines — sem saber o que
está no ecrã, o HUD **recusa recomendar uma jogada** e mostra só o edge. E entrou um fuzz de 1.680
estados para garantir que a classe inteira de bugs desapareceu, não apenas a instância.

**9. Um campo com o nome do jogo.** O selector do número de minas chama-se `mines` dentro do jogo
`mines` — nome do campo igual ao nome do jogo. A minha validação filtrava o campo quando os dois
coincidiam, e o resultado era que **o campo mais usado das Mines não podia ser ensinado**. Só
apareceu quando exercitei o fluxo de ensino a sério, não quando escrevi o teste (o teste que eu
tinha era *escrito segundo a mesma suposição errada*).

**10. O layout a decidir em vez do nome.** Na primeira versão da descoberta, o `#bet-input` do mock
perdeu o papel de «valor da aposta» para o campo do **nº de minas** — apenas porque este ficava 30px
mais perto do botão de apostar, e o meu bónus geométrico valia mais do que o bónus do nome. O nome é
evidência de **intenção** (o campo chama-se `bet-input`); a posição é só evidência de **layout**.
Corrigido com discriminação cruzada entre papéis: um campo cujo nome fala de minas ou multiplicador
perde pontos para o papel do valor da aposta, e vice-versa. **Apanhado pela demo, não pelos testes** —
os testes que eu tinha verificavam a pontuação de cada papel isoladamente, nunca a *competição* entre
os dois candidatos. Passou a haver teste para a competição.

**11. Somar penalizações onde eram precisos vetos.** Ao escrever os primeiros testes da pontuação,
cinco falharam por um motivo comum: eu compensava requisitos binários ("não se escreve neste campo",
"não tem número nenhum", "é uma frase") com penalizações, e um candidato claramente inválido ficava
com pontuação positiva — ou seja, **aparecia na lista de propostas**. Uma lista que inclui lixo treina
o utilizador a aceitar lixo, e a partir daí a lista não vale nada. Substituído por vetos explícitos
(`legivel`, `editavel`, valor plausível para o papel) que terminam a pontuação em vez de a ajustar.

**12. Uma lista que desaparecia ao primeiro proveito.** Ao usar uma proposta, o painel reescrevia a
lista inteira — e as três propostas seguintes desapareciam, obrigando a procurar outra vez para cada
campo: quatro procuras para configurar quatro coisas. A lista fica agora viva, com o estado numa linha
própria e a proposta usada a marcar-se como «✓ usado». Só apareceu ao fazer o percurso como um
utilizador o faz (clicar em todas, por ordem), e não ao ler o código.

**13. O painel a dizer «Tudo dentro dos limites» com $0.00 no ecrã.** Com o saldo a zero — conta vazia,
que é o estado inicial de qualquer conta nova — o painel escrevia «Dentro dos limites», porque o
saldo não é nulo (é zero) e nada na lógica dos alertas o considerava um problema. Não havia erro
nenhum visível: a barra de volume a 0%, o P/L a 0, e uma mensagem animadora. Duas correções, e não
uma: o estado **`saldo-zero`** passou a ser explícito («o HUD está a funcionar; não há é nada para
jogar») e o alerta passou a aparecer quando o saldo é menor que o stake. E o cálculo do P/L em
percentagem fazia `0/0` com saldo inicial zero, imprimindo literalmente **«NaN%»**.

**14. O falso erro do 0.30, e a escrita que não pegava.** Dois defeitos no mesmo sítio, os dois a
produzir a mesma queixa («o site mete os 0.30 mas dá erro»):

  a) **Comparação de strings onde era preciso comparação de valores.** Eu escrevia «0.3» e o site
  normalizava para «0,30» ou «0.30»; a confirmação comparava texto, portanto falhava — e o painel
  dizia que o site **não aceitou** um valor que estava lá. Uma verificação que dá falsos negativos é
  pior do que não verificar: ensina a ignorar o aviso. Agora compara por valor numérico.

  b) **Escrever `.value` não chega em campos controlados por frameworks.** React/Vue mantêm um tracker
  interno do valor e repõem-no no render seguinte, pelo que a escrita é revertida — e o campo volta
  atrás depois de a confirmação ter passado. O caminho correcto é o **setter nativo do protótipo**
  (`HTMLInputElement.prototype`), que passa por fora do tracker; é o mecanismo que o próprio React
  usa. Continua a ser escrita num campo, não interacção com um botão.

**15. Prometer uma detecção que eu não consigo fazer.** Cheguei a desenhar uma opção para «ensinar o
botão automático do casino» e avisar quando ele estivesse a apostar fora do plano. Não há forma fiável
de saber se o auto-bet de um casino está ligado — os botões mentem, o estado vive no servidor deles — e
uma opção que promete isso no texto da interface e não o faz é pior do que não existir. Removida antes
de sair do editor. No lugar dela ficou o estado **`sem-movimento`**, que diz o que consigo saber: o
valor não muda, e entre as explicações possíveis está o modo demo.

**16. `String.replace` e o `$'`.** No gerador da demo, inlinar o userscript com
`mock.replace(tag, texto)` corrompeu o ficheiro: o userscript contém `+ '$' + Math.abs(...)`, e no
texto de substituição de `replace` a sequência `$'` significa **«tudo o que vem depois do match»**.
O resultado foi o ficheiro cortado a meio, com o resto do userscript colado no fim, e a demo em
branco. Duas correções, porque uma não chegava: substituição por **função** (que devolve o texto
literal, sem interpretar `$`), e uma verificação do próprio artefacto no fim do build — o bloco
inlinado tem de aparecer inteiro, o ficheiro tem de ter exactamente 3 tags `<script>` e zero
`</script` sem escape. Uma página em branco não diz nada; um build que falha diz tudo.

**17. Eu a escrever «0.3» num site que mostra «0.30».** Mesmo depois de a confirmação passar a ser
numérica (bug 14a), continuava a mandar para o campo o número cru: o plano dizia «$0.30», o ecrã do
site passava a dizer «0.3», e a instrução «CONFERE NO ECRÃ» obrigava-te a comparar duas coisas
escritas de forma diferente — num sítio onde tu estás a apostar dinheiro. Passou a escrever-se a
mesma forma que o plano mostra, mas **sem arredondar**: se o valor não couber em duas casas (por
exemplo $0.005), escreve-se exactamente como está, porque uma aposta arredondada é uma aposta que tu
não autorizaste.

**18. O nº de minas era um `<select>`, e eu só sabia escrever em `<input>`.** O bug que tu
reportaste («as minas não escolhe»). No csgo500 o número de minas (1 a 24) não é um campo de texto:
é um **seletor** cujo conteúdo — as opções — é desenhado pelo site. Eu procurava `input, textarea`,
nunca `select`; e mesmo que o tivesse encontrado, escrever `.value = '3'` num seletor vazio não
escolhe nada. A correção não foi «tentar mais forte»: foi **ler o DOM** e tratar cada tipo de
controlo pelo que ele é — escolher a opção (por value exacto, depois texto exacto, depois texto
numérico, depois índice), **ler** o valor pelo TEXTO da opção escolhida, e mostrar na inspeção
`SELECT · 24 opções · escolhida «7» · do plano: 7 existe nas opções? SIM`. Um valor que não existe
nas opções passa a sair com a **lista do que existe**, em vez de «não aceitou».

**19. A máscara do apanhador fora do Shadow DOM, e a tapar-se a si própria.** Dois defeitos no
mesmo sítio, nenhum deles visível a ler o código. O `startPicker` criava a máscara e o aviso com
`document.body.appendChild`, mas as classes `.pick`/`.pickHint` estão definidas no `<style>` **dentro
do Shadow DOM** — fora dele não há estilo nenhum: a máscara era um `<div>` invisível de tamanho zero
e o realce do hover nunca aparecia. E como a máscara cobria o ecrã inteiro **com** cliques, o
`elementFromPoint` devolvia a própria máscara: o apanhador aprendia o caminho CSS da máscara, não o do
teu saldo. As duas coisas juntas produziram o pior tipo de ferramenta — uma que parecia funcionar
porque não tinha feedback nenhum para contradizer. Corrigido montando dentro do Shadow DOM e com
`pointer-events:none` (a máscara existe para se *ver*). Foi preciso **clicar a sério num browser**, em
cada passo, para isto aparecer: nenhum teste unitário o apanhava, e nenhum dos dois defeitos dá erro.

**20. O painel da captura a tapar a coisa que te mandou clicar.** Depois de a captura guiada estar
feita e testada com 38 testes a passar, o primeiro clique **real** no saldo não fez nada: o painel,
fixed no topo do ecrã, cobria o saldo, e o clique morria no HUD. O desenho estava a ser avaliado
contra a minha própria cabeça («um painel no topo é discreto») em vez de contra o ecrã de quem clica.
A correção não foi mudar o painel de sítio — isso só mudaria *qual* elemento fica tapado: o painel
passou a ser **arrastável** (com travão nas margens, para não se perder) e **minimizável** até uma
linha. Erros de desenho não aparecem nos testes; aparecem quando alguém tenta usar a coisa.

**21. A mensagem escrita na zona que o render reescreve.** *Outra vez.* O resumo da captura era
escrito no `#teachStatus` — que o `renderFields()` reescreve a cada 900 ms com a lista de campos.
Resultado: o resumo aparecia e desaparecia antes de ser lido, exactamente como o `fillStatus` tinha
feito antes (bug 14). A regra que faltava, escrita agora de forma explícita: **uma mensagem calculada
tem de viver fora de qualquer zona redesenhada em ciclo**. Foi para o `#capOut`, e há teste que corre
o tick de 900 ms e exige que a mensagem lá continue.

**22. O teste que testava o passo errado.** O teste do mapa começou por reutilizar o preenchimento
da ronda — e isso fazia-o testar os campos **do jogo do passo do plano**, não os da **página onde
estás**. Quem acabasse de aprender o mapa das Mines com o plano no Dice via «multiplicador: campo não
ensinado ao HUD». Não era falso: era inútil. A pergunta certa é «este mapa funciona *aqui*?», e a
resposta tem de vir dos campos desta página. Reescrito para sondar a página actual — usando o valor
do plano quando existe e, quando não existe, reescrevendo o valor que lá está, com a nota a dizê-lo.

**23. O painel a crescer para fora do ecrã.** O travão de margens era aplicado quando arrastavas o
painel — mas a fase de teste é **mais alta** que a da aprendizagem, e ao mudar de fase o painel
crescia para baixo, levando os botões para fora do fundo do ecrã. O clique no botão do teste caía no
vazio: o `preview_click` dizia «ok» porque o botão **existe**, e nada acontecia porque o ponto do
clique já não estava em nada. Apanhado a clicar com o rato a sério — e por uma medição que devia
estar em qualquer investigação de interface: `elementsFromPoint` nos botões devolvia **uma lista
vazia**. O travão passou a ser uma função pura (`limitarPosicao`), reaplicada a cada redesenho do
painel e testada com números (um painel de 300px a 600px numa janela de 860px tem de ir para 554).

**24. O meu próprio lint com falsos positivos.** O teste anti-automação acusava `.click()` e
`dispatchEvent` na **linha 20** — que era texto de continuação dentro do bloco de comentário que
documenta a proibição. Filtrava linhas começadas por `*` ou `//`, e não linhas de continuação.
Corrigido com um pequeno scanner que remove comentários **e literais de string** respeitando o
estado (código / bloco / linha / string). Uma verificação de segurança que dá falsos positivos é
uma verificação que alguém vai desligar.

**25. A captura a dizer «não» ao controlo que se usa em todas as rondas.** A validação do
`mines.mines` aceitava um `<select>` e um campo de escrita, e **recusava tudo o resto** — com um
motivo correcto («escrever `.value` numa `<div>` não muda nada») e um desfecho errado: no csgo500 o
1 a 24 é uma caixa desenhada, portanto quem tentasse capturá-la ficava sem mapa e sem saber o que
fazer. Um «não» tecnicamente verdadeiro que transforma a ferramenta em inútil é um bug, mesmo quando
o código está certo. A correcção tem duas metades: (a) **procurar o campo de verdade** dentro/à volta
do que foi clicado — se existir, guarda-se esse e nada muda para quem usa; (b) se não existir,
**aceitar como «à mão»** e mudar o que o HUD faz com esse campo: em vez de escrever, diz. Foi
preciso mexer em quatro sítios que assumiam «campo = sítio onde se escreve» — o preenchimento, o
teste do mapa, a lista de campos e os alertas do painel — porque um campo que não se escreve tem de
ser dito em **todos** eles; em qualquer um que se esquecesse, o painel prometia uma coisa que não
fazia. Verificado no browser, nas duas metades: com um `<select>` escondido lá dentro, o HUD guarda o
`<select>`; sem campo nenhum, o painel escreve «ESCOLHE 3 MINAS no seletor do site» e o controlo
fica intacto (lista fechada, valor inalterado).

**26. O clique que morria em silêncio.** Durante a captura, um clique que caísse no **painel do HUD**
(que tapa o site) era tratado como «clique na ferramenta» e ignorado **sem dizer nada**: a pessoa
clicava no controlo que estava a ver, não acontecia nada, e a conclusão era «o HUD recusa isto».
Não recusava — não dizia nada, que é pior. E era constante: numa janela estreita o painel grande do
HUD cobre mais de metade do ecrã. Duas correcções, uma para a causa e uma para o sintoma:
(a) **ao entrar em captura o painel grande encolhe para a aba** — e volta ao tamanho que tinha quando
a captura termina, porque a escolha de quem está a jogar não é para ser alterada às escondidas;
(b) um clique que caia numa zona **não interactiva** do HUD passa a ser **denunciado no painel**, e
nomeia o que está **por baixo** dele («por baixo dele está `DIV#mines-desenhado[role=combobox]`»),
porque o site nunca recebeu aquele clique. Aprendi-o com a demo: o clique no saldo não fazia nada, e
o `elementsFromPoint` mostrou `P500-HUD` no topo da pilha — o painel estava literalmente por cima.
A distinção que faltava é a que separa «um botão do HUD» de «o pano do HUD»: a primeira é uma
ferramenta, a segunda é o HUD a tapar o site.

**27. O mapa que parecia completo.** A fila da captura depende do endereço da página. Numa página que
o HUD não reconhece como Dice ou Minas, ela tem **dois** passos (saldo e valor) — e ao acabar anunciava,
satisfeita, **«Mapa aprendido — 2 de 2»**, com três campos que nunca foram pedidos. Nada dizia porquê;
o utilizador via a captura «saltar para o teste» e concluir que tinha saltado passos sozinha. Junta-se
o mesmo problema noutra forma: a fila avança sozinha e **não havia caminho de volta**, e a única
maneira de corrigir um campo mal aprendido era repetir tudo. Correcções: o painel **diz porque é que
a fila é curta** (com o endereço à frente, para se poder corrigir) e oferece botões
**`＋ campos do Dice` / `＋ campos das Minas`** que juntam os campos que faltam, devolvem o painel ao
modo de captura e apontam-no já ao primeiro deles — incluindo voltar a engolir os cliques da página,
que a fase de teste tinha devolvido ao site; **`↩ Voltar`** recua um passo; e a versão do userscript
passou a estar no cabeçalho do painel, que é a única forma de se saber se a correcção que se lê aqui
é a que está a correr no browser.

**28. O «0.30» que saía «0.» e dizia 0.0.** A `segmentar` tinha uma `MORPH_CLOSE (1,3)` para religar
hastes partidas pela antialiasing. Na fonte desta página os dígitos ficam a 1 a 4 pixels uns dos
outros, e um fecho de 3 colunas engole qualquer intervalo menor que isso: o `0.30` passou a ser `0.`
mais um bloco de 25 pixels («3» e «0» colados), e o parser devolvia **0.0 — um número plausível e
errado**. A fragmentação que a fecho vinha curar era culpa do Otsu (já trocado por um limiar
relativo), e a fecho tinha deixado de curar para passar a estragar. Retirada, com a evidência à
frente: nos recortes de verdade, os dígitos ficam a 1 a 4 pixels uns dos outros, e uma coluna vazia
tem 1,4%–6,5% do contraste (restos de antialiasing) — indistinguível, portanto, de um intervalo
entre caracteres.

**29. Metade de um número não é um número — e um rótulo errado é mais grave do que um em falta.**
Um glifo por aprender deixava o texto em «1.2?» e o `parse_moeda` limpava o `?`: «1.2?» → «1.2» →
**1.2**, um número errado lido com confiança. A regra passou a ser: **se houver um glifo
desconhecido, o VALOR é `None`**. Duas ferramentas ajudam a rever isto, e nasceram do erro mais
instrutivo desta série: ao responder às perguntas do `aprender` com a lista deslocada por um lugar
(uma pergunta a menos, porque dois «0» iguais partilham uma assinatura), a letra «U» do «USD» ficou
registada como «0», o saldo passou a ler `5,000`, e o `1` do multiplicador ficou «ignorado». Nenhum
teste apanha isso, porque nada ali é ilegal — o que faltava era revisão. Agora o `ver` mostra **cada
glifo com o rótulo que tem** (o «0» de 17×16 salta à vista ao lado dos de 13×17) e o `aprender`
avisa quando o **mesmo carácter aparece com dois tamanhos** na mesma região: um carácter não muda de
largura. O aviso não corrige nada — diz para ires ver, que é a única coisa honesta a fazer quando os
dados se contradizem.

**30. A pasta de auditoria que mentia.** Cada glifo aprendido é gravado em
`glifos/<assinatura>_<rótulo>.png`: é a auditoria, o sítio onde se vê o desenho que o programa
associou a cada carácter. Mas os testes aprendem glifos de uma fonte sintética (é assim que se testa
sem ecrã), e escreviam na **mesma pasta do projecto** — a auditoria enchia-se de desenhos que já
ninguém sabia ler. O `Dicionario.aprender` passou a resolver a pasta a cada chamada (e não na
definição, onde o valor fica preso), e os testes apontam-na para uma pasta temporária apagada no fim.
Uma auditoria com lixo é pior do que não ter auditoria nenhuma.

**31. A mira que engoliu o ecrã inteiro.** A primeira versão do «aponta para o saldo» partia da caixa
de tinta de uma **janela** em volta do clique. Se a janela apanhava duas coisas diferentes (o número
e o rótulo «Saldo» por cima), a caixa de partida atravessava as duas, a banda vertical deixava de ser
uma linha de texto, e como há sempre tinta alguma vez nessa banda o crescimento nunca parava: a mira
devolvia `[22, 0, 878, 1421]` — a página toda — para um clique no saldo. Corrigido partindo do
**caracter isolado** (o componente de tinta mais próximo do clique) e usando a altura *dele* como
régua da linha, com folga assimétrica: 0,3 acima do topo (acima está OUTRA linha — o rótulo fica a
0,76 alturas) e 0,6 abaixo da base (abaixo estão as vírgulas, que descem 0,24 alturas). Medido nos
recortes de verdade; passou a devolver 69×27 px em vez de 878×1421.

**32. Ensinar com as respostas deslocadas.** O `aprender` aceitava o que se escrevia e alinhava os
caracteres pelos desenhos **sem verificar a contagem** — e uma lista de respostas deslocada por um
lugar (eu fiz isso, com uma pergunta a menos porque dois «0» iguais partilham assinatura) gravou a
letra «U» do «USD» como «0» e o saldo passou a ler `5,000`. Agora, se a contagem não bater, **não se
aprende nada** e o aviso diz o que fazer (usar `_` para o que não é número, ou `ver` para descobrir
desenhos colados). Uma resposta de um modelo de IA passa pelo mesmo crivo — e essa é a parte que
importa: o professor pode ser uma IA, mas quem assina os rótulos é a contagem.

**33. A regra de captura a escolher a opção mais lenta.** Para decidir entre «uma captura da caixa
que contém tudo» e «uma captura por região», comparei ÁREAS — copiar menos parece sempre melhor — e
escolhi quatro capturas pequenas. Medido: 4 recortes (0,24 MB) levam **25 ms** e a caixa única
(1,48 MB) leva **12,5 ms**, porque cada chamada ao sistema custa ~6 ms fixos. Corrigido com a conta
certa (overhead + bytes, com os números medidos) e com um teste que fixa as duas decisões: regiões
na mesma faixa → uma captura; regiões em cantos opostos de um ecrã grande → uma por região.

**34. O `or` sobre um array do NumPy.** No caminho da leitura repetida estava
`recortes.get(nome) or recorte` — e `or` sobre um array levanta `ValueError: The truth value of an
array with more than one element is ambiguous`. Não apareceu em nenhum teste porque a leitura
repetida só corre no **ecrã** (`--png` faz sempre uma leitura só, e os testes usam PNGs): apareceu na
primeira vez que corri `ler` contra o ecrã a sério. É o mesmo tipo de falha do bug 8 (o `toFixed`
sobre `null`): o caminho que não é exercitado pelos testes é o caminho que rebenta — e a lição
prática é correr o modo real de vez em quando, não só a suite.

**35. As casas abertas a mais do que é possível.** Ao ler o ecrã com uma referência de casas
aprendida noutra página, a contagem por cor deu **25 casas abertas com 3 minas** — impossível, e o
programa apresentava-o como leitura. O desacordo com o multiplicador apanhava-o *quando* o
multiplicador fosse legível; sem ele, ficava um número sem sentido à espera de ser lido por um olho
distraído. Passou a haver um veredicto explícito para o impossível («contei N casas com M minas —
isso não é possível: a referência das casas deve estar velha»), que diz o que fazer em vez de só
recusar.

---

## 7. Resultados de referência

### Desafio $5 → $1000 (200x)

| Estratégia | P(chegar a $1000) | E[saldo final] |
|---|---|---|
| **1 aposta all-in Dice 200x** | **0,4950%** | **$4,95** |
| Mines 15 minas / 5 casas (208,7x) | 0,4743% | $4,95 |
| Bold play só com 2x | 0,4655% | $4,61 |
| All-in fixo 1,05x | 0,1639% | $1,64 |
| Martingale clássico | 0,0000% | $3,51 |
| Grind 10% da banca a 1,2x | 0,0000% | $0,69 |

Teto matemático absoluto: `banca / meta` = **0,50%**. Nenhuma estratégia o ultrapassa.

### Diversão $5 a $0,30/ronda

| Estratégia | Mediana de rondas | Tempo @3s | P(tocar $10) |
|---|---|---|---|
| Flat 1,1x | 1.229 | ~1h00 | 3,7% |
| Flat 1,5x | 640 | ~32 min | 32,7% |
| **Minas rotativas + Flat 2,0x** | **392–424** | **~21 min** | **38–39%** |
| Rotativo com stake até $0,80 | 111 | ~5,5 min | 44,5% |
| Flat 100x | **16** | **~48 seg** | 14,6% |

---

## 8. Notas

- Todos os valores de *house edge* usados vêm da documentação oficial de suporte do 500 Casino
  (Dice 1%, Mines 1%, Towers 5%, Plinko 4%/8%, Wheel 5,01%, Crash ~6%, Roulette 6,66%,
  Cases 10%, Blackjack RTP 99,48%).
- Isto é entretenimento. Se em algum momento estiveres a pensar no casino fora das sessões, a
  recarregar, ou a subir o stake "só desta vez" — os limites que definiste eram bons, e o valor
  deles está em não os renegociar contigo mesmo.
- 18+/21+. Jogo responsável.
