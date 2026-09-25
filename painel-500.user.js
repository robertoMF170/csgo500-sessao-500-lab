// ==UserScript==
// @name         Sessão 500 — HUD de Disciplina
// @namespace    sessao500.local
// @version      1.4.5
// @description  HUD de disciplina no csgo500.com: le o saldo (so leitura), detecta rondas e o jogo pelo URL, mostra o edge e recomenda a jogada, e aplica travoes (pausas, gate, modo guerra). Preenche a configuracao, mas NUNCA aposta.
// @match        https://csgo500.com/*
// @match        https://*.csgo500.com/*
// @match        https://500.casino/*
// @match        https://*.500.casino/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ---------------------------------------------------------------------------------------------
   LIMITE DE DESENHO DESTE SCRIPT  (ler antes de alterar)

   Este HUD LÊ. Nao escreve. Nao clica. Nao submete. Nao fala com API nenhuma.

   Proibido introduzir aqui:
     - element.click() / dispatchEvent de eventos de rato ou teclado
     - fetch/XHR para endpoints do casino
     - qualquer coisa que coloque, cancele ou altere uma aposta
     - qualquer coisa desenhada para escapar a deteccao anti-automacao

   O que ele faz: le a DOM (um numero), observa variacoes de saldo, desenha um painel isolado
   em Shadow DOM, e cobra espera. Se algum dia alguem acrescentar um clique aqui, deixa de ser
   este projecto.
------------------------------------------------------------------------------------------------ */

(function () {
  'use strict';

  if (window.__PAINEL500_HUD__) return;
  window.__PAINEL500_HUD__ = true;

  const KEY = 'painel500.hud.v1';
  const VERSAO = '1.4.5';   // tem de acompanhar o @version do cabecalho

  /* ============================ 1. PARSER DE MOEDA ============================
     Formato observado no proprio site: "199 999,91 USD", "5 805,80", "398,02".
     Ou seja: espaco (ou nbsp estreito) para milhares, virgula para decimais.

     Ambiguidade documentada: "1.234" e 1234 em formato europeu e 1.234 em formato US.
     Por isso o HUD mostra SEMPRE a string crua ao lado do valor interpretado — um erro de
     leitura fica visivel no ecra em vez de corromper as contas em silencio.
     ===========================================================================*/
  function parseMoney(input) {
    if (input == null) return null;
    let s = String(input).replace(/[\s\u00a0\u202f\u2009]/g, '');
    /* O sinal de menos do site é U+2212 («−»), não o hífen ASCII. Sem isto, um saldo negativo
       (uma conta em dívida, um ganho/perda mostrado a vermelho) era lido como POSITIVO — um erro
       de sinal que passava por tudo o resto sem levantar a voz. Encontrado ao portar o parser
       para Python e comparar os dois lado a lado (ponte-motor.js). */
    s = s.replace(/[^\d.,\-\u2212]/g, '').replace(/\u2212/g, '-');
    if (!s || !/\d/.test(s)) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.')
                              : s.replace(/,/g, '');
    } else if (lastComma > -1) {
      const after = s.length - lastComma - 1;
      s = (after === 1 || after === 2) ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if (lastDot > -1) {
      const after = s.length - lastDot - 1;
      // ponto sozinho com exactamente 3 digitos -> quase sempre milhares no formato do site
      if (after === 3 && /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace('.', '');
    }
    const v = parseFloat(s);
    return isFinite(v) ? v : null;
  }

  /* ============================== 2. CONFIG ============================== */
  const DEFAULTS = {
    sel: null,                 // selector CSS do saldo (definido pelo apanhador)
    rawLast: '',               // ultima string crua lida
    stake: 0.30,
    budget: 5,
    edge: 0.01,
    rotation: ['dice 1.10', 'mines 1 3', 'dice 1.50', 'mines 3 2', 'dice 2.00', 'mines 5 2'],
    guard: { microEvery: 25, microSecs: 45, lossStreak: 5, lossCool: 180, winCoolAmount: 1, winCoolSecs: 120 },
    collapsed: false,
    autoDetect: true,
    debug: false,              // regista cada mudança de saldo na consola
    overlay: true,             // aviso sobre o tabuleiro (so conselho, nunca clica)
    autoFill: false,           // escreve valor e configuração da ronda sozinho (desligado por padrão)
    /* Selectores ensinados pelo utilizador. So configuracao PRE-RONDA.
       Nao ha aqui campo para "abrir casa" nem para "retirar": isso sao accoes de jogo.
       `board` e o tabuleiro, e serve UNICAMENTE para posicionar o aviso em cima dele. */
    fields: { dice: { stake: '', mult: '', board: '' }, mines: { stake: '', mines: '', mult: '', board: '' } },
    /* Campos que o SITE não deixa escrever por código (a caixa desenhada do nº de minas).
       Não se guarda aqui nada para escrever: guarda-se a DECISÃO de não escrever, para o HUD
       passar a DIZER o número em vez de fingir que o escreveu. Chave = papel da captura. */
    manual: {}
  };

  const S = {
    cfg: null,
    startBalance: null,
    balance: null,
    cursor: 0,
    history: [],       // {i, game, stake, mult, delta, result, balance, at, auto}
    breaks: [],
    impulses: [],
    deviations: [],
    lossStreak: 0,
    lockKind: null, lockUntil: 0, lockStart: 0, lockWhy: '', lockFoot: '',
    ended: false,
    syncErr: null,
    /* Diagnóstico: quantas vezes o HUD conseguiu ler o saldo, e quantas dessas leituras
       trouxeram um valor diferente. É a diferença entre "não leio nada" e "leio sempre
       a mesma coisa" — que são avarias completamente diferentes. */
    nLeituras: 0,
    nMudancas: 0,
    leituras: [],
    /* Av. o sobre o tabuleiro: `avisoAck` guarda a DECISÃO que tomaste para aquele aviso,
       para ele encolher em vez de insistir. `decisions` é o registo dessas decisões — é o
       oposto de automação: o HUD pergunta e tu respondes. */
    avisoAck: null,
    decisions: [],
    autoFeito: null,
    autoLog: []
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const c = JSON.parse(raw);
        return Object.assign({}, DEFAULTS, c, {
          guard: Object.assign({}, DEFAULTS.guard, c.guard || {}),
          fields: Object.assign({}, DEFAULTS.fields, c.fields || {}),
          manual: Object.assign({}, DEFAULTS.manual, c.manual || {})
        });
      }
    } catch (e) {}
    return Object.assign({}, DEFAULTS);
  }
  function saveCfg() { try { localStorage.setItem(KEY, JSON.stringify(S.cfg)); } catch (e) {} }

  S.cfg = loadCfg();

  /* ======================== 3. MOTOR DE ROTACAO ======================== */
  const C = (function () {
    const cache = {};
    const f = n => { if (n in cache) return cache[n]; let r = 1; for (let i = 2; i <= n; i++) r *= i; return (cache[n] = r); };
    return (n, k) => (k < 0 || k > n) ? 0 : Math.round(f(n) / (f(k) * f(n - k)));
  })();

  function rot() {
    const out = [];
    for (const raw of S.cfg.rotation) {
      const p = String(raw).trim().split(/\s+/);
      if (!p[0]) continue;
      if (p[0].toLowerCase() === 'dice') {
        const m = parseFloat(p[1]);
        if (isFinite(m) && m > 1) out.push({ game: 'Dice', mult: m, label: 'Dice ' + m.toFixed(2) + 'x', winChance: (1 - S.cfg.edge) / m });
      } else if (p[0].toLowerCase() === 'mines') {
        const m = parseInt(p[1], 10), k = parseInt(p[2], 10);
        if (m >= 1 && m <= 24 && k >= 1 && k <= 25 - m) {
          const pw = C(25 - m, k) / C(25, k);
          out.push({ game: 'Mines', mult: (1 - S.cfg.edge) / pw, mines: m, tiles: k,
                     label: 'Mines ' + m + 'm/' + k + 'c', winChance: pw });
        }
      }
    }
    return out;
  }
  function currentStep() { const r = rot(); return r.length ? r[S.cursor % r.length] : null; }

  /* ==================== 3.1 TABELA DE EDGE DOS JOGOS ====================
     Fonte: pagina oficial de suporte do 500 Casino (house edge por jogo).
     Estes valores estao EMBUTIDOS porque o utilizador nao os deve ter de saber de cor,
     e porque recomendar uma aposta sem conhecer a margem e recomendar às cegas.
     ==================================================================== */
  const GAMES = {
    dice:      { nome: 'Dice',           edge: 0.01,   tipo: 'mult-livre',
                 nota: 'Multiplicador livre de 1.0102x a 9900x. Chance de ganhar = 99% / M.' },
    mines:     { nome: 'Mines',          edge: 0.01,   tipo: 'minas',
                 nota: 'A margem de 1% e paga na ENTRADA. A partir daí o jogo é justo.' },
    limbo:     { nome: 'Limbo',          edge: 0.02,   tipo: 'mult-livre', nota: 'Como o Dice, mas com 2% de margem.' },
    keno:      { nome: 'Keno',           edge: 0.02,   tipo: 'tabela',     nota: 'Tabela fixa de prémios.' },
    towers:    { nome: 'Towers',         edge: 0.05,   tipo: 'escada',     nota: '5% cobrados em cada decisão de subir.' },
    plinko:    { nome: 'Plinko',         edge: 0.04,   tipo: 'tabela',     nota: '4% (8% no modo extremo). Tabela fixa.' },
    wheel:     { nome: 'Wheel',          edge: 0.0501, tipo: 'tabela',
                 nota: 'Média 5,01%. Cinza 3,7% / vermelho 5,5% / azul 7,4% / dourado 7,4%.' },
    roulette:  { nome: 'Roulette',       edge: 0.0666, tipo: 'tabela',
                 nota: '6,66% — a roleta do 500 é mais caras que uma europeia (2,7%).' },
    crash:     { nome: 'Crash',          edge: 0.06,   tipo: 'mult-livre',
                 nota: '~6%: 6% das rondas crasham imediatamente a 1x.' },
    duels:     { nome: 'Duels',          edge: 0.05,   tipo: 'pvp',        nota: '5% de rake por duelo.' },
    hilo:      { nome: 'Hi Lo',          edge: 0.02,   tipo: 'escada',     nota: '2%. Cada carta tem uma probabilidade diferente.' },
    blackjack: { nome: 'Blackjack',      edge: 0.0052, tipo: 'cartas',
                 nota: 'RTP 99,48%, o melhor do site — mas a forma do payout é má para subir banca.' },
    baccarat:  { nome: 'Baccarat',       edge: 0.01,   tipo: 'cartas',     nota: '1%, com 9,5% de empates.' },
    blitz:     { nome: 'Blitz',          edge: 0.02,   tipo: '?',
                 nota: '2%. O 500 não publica a estrutura de pagamento. Fora da rotação.' },
    trader:    { nome: 'Trader',         edge: 0.02,   tipo: '?',
                 nota: '2%. Mecânica de preço não documentada. Fora da rotação.' },
    cross:     { nome: 'Cross The Road', edge: 0.02,   tipo: 'escada',
                 nota: '2% (escada). Cada passo cobra a margem outra vez.' },
    cases:     { nome: 'Cases',          edge: 0.10,   tipo: 'tabela',
                 nota: '10% de margem somada sobre o valor dos itens da caixa.' },
    sports:    { nome: 'Sportsbook',     edge: 0.03,   tipo: '?',
                 nota: '3% nominal e dinâmico. Em longshots a margem real é muito pior.' }
  };

  /* Deteccao do jogo pelo URL. Confiavel e sem tocar na pagina. */
  function detectGame() {
    let p = location.pathname.replace(/^\/[a-z]{2}(?=\/|$)/i, '');
    const seg = (p.split('/').filter(Boolean)[0] || '').toLowerCase();
    const map = { mines: 'mines', dice: 'dice', limbo: 'limbo', keno: 'keno', towers: 'towers',
                  plinko: 'plinko', wheel: 'wheel', roulette: 'roulette', crash: 'crash',
                  duels: 'duels', split: 'duels', hilo: 'hilo', 'hi-lo': 'hilo' };
    if (map[seg]) return map[seg];
    if (/blackjack/.test(p)) return 'blackjack';
    if (/baccarat/.test(p)) return 'baccarat';
    if (/cases|battles/.test(p)) return 'cases';
    if (/sports|bets/.test(p)) return 'sports';
    return null;
  }

  /* ==================== 3.2 MOTOR DE RECOMENDACAO ====================
     Calcula, para o jogo em que o utilizador esta, o edge real da jogada,
     o que pode ganhar e perder, e o que o plano diz. NUNCA decide por ele.
     ================================================================= */
  /* Leitura do valor de um campo, seja um input, um textarea, um select ou um texto.

     O SELECT é o caso que importava: no csgo500 o número de minas é um seletor de 1 a 24.
     Num select, `el.value` nem sempre diz o que está escolhido — se os <option> não tiverem
     atributo value, ou se o value for um identificador ("opt-3") e não o número, o valor
     numérico está no TEXTO da opção seleccionada. Ler o value em vez do texto foi parte do
     motivo pelo qual "não escolheu o número de minas". */
  function lerValorDeCampo(el) {
    if (!el) return null;
    if (el.tagName === 'SELECT' && el.options && el.selectedIndex >= 0) {
      const opt = el.options[el.selectedIndex];
      const porTexto = parseMoney(opt && opt.textContent);
      if (porTexto != null) return porTexto;
      return parseMoney(opt && opt.value);
    }
    const bruto = el.value != null && el.value !== '' ? el.value : el.textContent;
    return parseMoney(bruto);
  }

  /* O que está escrito no campo, tal como o site o mostra. Distinto do valor numérico:
     o painel mostra-te o texto cru («0,30») porque é o que tu vês no ecrã, e compara pelo
     número, porque é o que decide se a escrita pegou. */
  function textoDoCampo(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT' && el.options && el.selectedIndex >= 0) {
      const o = el.options[el.selectedIndex];
      return String(o && o.textContent || '').trim();
    }
    return String(el.value != null && el.value !== '' ? el.value : el.textContent || '').trim();
  }

  function lerCampo(game, campo) {
    const f = (S.cfg.fields || {})[game] || {};
    const sel = f[campo];
    if (!sel) return null;
    let el; try { el = document.querySelector(sel); } catch (e) { return null; }
    return lerValorDeCampo(el);
  }

  /* Escolher uma opção num <select>, pela ordem que funciona na vida real:
       1) por `value` exacto     — o caminho normal;
       2) por texto exacto        — <option>3</option>;
       3) por valor numérico      — «3 minas» ou value="opt-3";
       4) por índice 1..N         — último recurso quando as opções são "1..24" na ordem.
     Se nada servir, devolve a LISTA de opções: sem isso o utilizador fica a olhar para um
     select a perguntar-se porque é que ninguém o consegue escolher. */
  function escolherOpcao(el, val) {
    const v = String(val);
    const num = parseMoney(v);
    const opts = Array.prototype.slice.call(el.options || []);
    if (!opts.length) return { ok: false, motivo: 'o <select> não tem opções (ainda não carregou?)' };

    let alvo = opts.filter(o => String(o.value) === v)[0];
    let como = 'value';
    if (!alvo) { alvo = opts.filter(o => String(o.textContent).trim() === v)[0]; como = 'texto'; }
    if (!alvo && num != null) {
      alvo = opts.filter(o => parseMoney(o.textContent) === num)[0]; como = 'texto-numerico';
    }
    if (!alvo && num != null) {
      alvo = opts.filter(o => parseMoney(o.value) === num)[0]; como = 'value-numerico';
    }
    if (!alvo && num != null && num >= 1 && num <= opts.length) {
      alvo = opts[num - 1]; como = 'indice';
    }
    if (!alvo) {
      return { ok: false, motivo: 'nenhuma opção corresponde a ' + v + ' — opções: ' +
        opts.map(o => String(o.textContent).trim()).slice(0, 30).join(' | ') };
    }

    el.selectedIndex = opts.indexOf(alvo);
    try {
      if (typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement) {
        const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, alvo.value);
      } else el.value = alvo.value;
    } catch (e) { try { el.value = alvo.value; } catch (e2) {} }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, como: como, texto: String(alvo.textContent).trim() };
  }

  function recommend() {
    const g = detectGame();
    if (!g || !GAMES[g]) {
      return { jogo: g, meta: null, titulo: 'jogo não reconhecido',
               linhas: ['Abre Dice ou Mines para veres a recomendação e o edge.'], ok: null };
    }
    const meta = GAMES[g];
    const passo = currentStep();
    const stake = S.cfg.stake;
    /* Selectores que o utilizador ensinou para ESTE jogo (para poder mostrar o caminho
       do próprio campo — ver a linha do multiplicador nas Minas). */
    const campos = (S.cfg.fields || {})[g] || {};
    const linhas = [];
    let titulo = '—', ganho = null, perda = stake, ok = null;

    /* ---------- DICE / qualquer jogo de multiplicador livre ---------- */
    if (meta.tipo === 'mult-livre') {
      const planeado = passo && passo.game === 'Dice' ? passo.mult : null;
      const noSite = lerCampo(g, 'mult');
      const alvo = noSite || planeado;
      if (alvo == null) {
        /* Sem passo de Dice na rotacao E sem o multiplicador lido do ecra nao existe
           "jogada recomendada": so existe a margem. Antes disto o codigo fazia
           alvo.toFixed(2) sobre null e REBENTAVA — e como recommend() corre a cada
           900 ms, bastava estar no Dice para o painel inteiro morrer em silencio. */
        ok = null; titulo = 'ENSINAR O HUD A LER';
        linhas.push('Não sei com que multiplicador estás a jogar: a tua rotação não tem passo de Dice e o campo do multiplicador não está ensinado.');
        linhas.push('Ensina o campo do multiplicador (configuração → campos) ou mete um passo «dice 2.0» na rotação.');
        linhas.push('Enquanto não souber, não te dou recomendação de jogada — só o edge: ' + (meta.edge * 100).toFixed(2) + '%.');
      } else {
        ganho = stake * (alvo - 1);
        const chance = (1 - meta.edge) / alvo;
        linhas.push('Multiplicador ' + alvo.toFixed(2) + 'x  →  chance de acerto ' + (chance * 100).toFixed(2) + '%');
        linhas.push('Ganhas ' + MONEY(ganho) + ' se der, perdes ' + MONEY(stake) + ' se não der.');
        linhas.push('EV desta aposta: ' + MONEY(-meta.edge * stake) + '  (a margem come ' + (meta.edge * 100).toFixed(2) + '% do que apostas, sempre)');
        if (planeado && noSite && Math.abs(noSite - planeado) > 0.001) {
          ok = false;
          titulo = 'AJUSTAR para ' + planeado.toFixed(2) + 'x';
          linhas.push('O plano diz ' + planeado.toFixed(2) + 'x  e  o site está em ' + noSite.toFixed(2) + 'x.');
        } else {
          ok = true;
          titulo = 'APOSTAR ' + alvo.toFixed(2) + 'x  ·  ' + MONEY(stake);
        }
      }
    }

    /* ------------------------------ MINAS ------------------------------ */
    if (meta.tipo === 'minas') {
      const planMines = (passo && passo.game === 'Mines') ? passo.mines : 3;
      const planTiles = (passo && passo.game === 'Mines') ? passo.tiles : 3;
      const minas = Math.round(lerCampo(g, 'mines') || planMines);
      const multSite = lerCampo(g, 'mult');
      const P = k => C(25 - minas, k) / C(25, k);
      const M = k => (1 - meta.edge) / P(k);

      linhas.push(minas + ' minas  ·  plano: ' + planMines + ' minas / ' + planTiles + ' casas');

      if (multSite == null) {
        /* Sem saber o multiplicador actual não sabemos quantas casas estao abertas.
           Nunca inventar: pedir a leitura. */
        ok = null; titulo = 'ENSINAR O HUD A LER';
        linhas.push('Não sei quantas casas tens abertas. Ensina o HUD a ler o multiplicador no ecrã (configuração → campos).');
        linhas.push('Enquanto não souber, não te dou recomendação de jogada — só o edge: ' + (meta.edge * 100).toFixed(2) + '%.');
      } else {
        const abertas = Math.max(0, Math.round(reverterCasas(minas, multSite, meta.edge)));
        const retirar = abertas > 0 ? stake * M(abertas) : null;
        const pProx = (25 - minas - abertas) / (25 - abertas);
        ganho = stake * M(Math.max(1, abertas)) - stake;

        linhas.push('Abriste ' + abertas + ' casas  →  o ecrã mostra ' + multSite.toFixed(2) + 'x');
        linhas.push('Esse valor está em: ' + (campos.mult || '(campo não ensinado)') +
                    '  — copia este caminho para o campo do multiplicador.');
        if (retirar != null) {
          linhas.push('RETIRAR agora devolve ' + MONEY(retirar) + '  (lucro ' + MONEY(retirar - stake) + ').');
          if (pProx > 0) {
            const Mnext = M(abertas + 1);
            const evAbrir = pProx * stake * Mnext;
            linhas.push('ABRIR mais 1: ' + (pProx * 100).toFixed(2) + '% de acerto → ' + MONEY(stake * Mnext) +
                        ', senão $0.00.');
            linhas.push('EV de abrir ' + MONEY(evAbrir) + '  vs  EV de retirar ' + MONEY(retirar) +
                        '  →  diferença ' + MONEY(evAbrir - retirar));
          }
        }
        if (planTiles > 0 && abertas > planTiles) { titulo = 'FORA DO PLANO · RETIRAR'; ok = false; }
        else if (planTiles > 0 && abertas === planTiles) { titulo = 'RETIRAR'; ok = true; }
        else { titulo = 'ABRIR MAIS 1'; ok = true; }
        linhas.push('O plano pede ' + planTiles + ' casas. ' + (abertas === planTiles
          ? 'Atingiste o alvo: é aqui que se retira.'
          : (abertas < planTiles ? 'Faltam ' + (planTiles - abertas) + '.' : 'Passaste o alvo.')));
      }

      linhas.push('A margem de 1% foi paga na ENTRADA. A partir daí o jogo é justo:');
      linhas.push('abrir ou retirar é escolha de VARIÂNCIA, não de valor.');
    }

    /* ---------- jogos de tabela / cartas / outros ---------- */
    if (['tabela', 'cartas', 'pvp', 'escada', '?'].includes(meta.tipo)) {
      ok = false;
      titulo = 'SEM RECOMENDAÇÃO DE APOSTA';
      linhas.push('Edge ' + (meta.edge * 100).toFixed(2) + '% — ' + meta.nota);
      linhas.push('Este jogo não se adapta à estratégia de rotação. Se o plano não te diz para estar aqui, não estejas.');
      linhas.push('Se apostares ' + MONEY(stake) + ', o EV é ' + MONEY(-meta.edge * stake) + ' por ronda.');
    }

    return { jogo: g, meta, titulo, ganho, perda, linhas, ok, passo };
  }

  /* Multiplicador inverso: quantas casas seguras produzem este multiplicador. */
  function reverterCasas(minas, mult, edge) {
    for (let k = 0; k <= 25 - minas; k++) {
      const M = (1 - edge) / (C(25 - minas, k) / C(25, k));
      if (M >= mult - 0.005) return k;
    }
    return 0;
  }

  /* ==================== 3.3 PREENCHER OS CAMPOS (sem apostar) ====================
     LIMITE EXACTO DESTA SECCAO:
       PERMITIDO: escrever .value num campo e despachar Event('input'|'change'),
                  para o framework da pagina notar, e LER de volta para verificar.
       PROIBIDO:  .click(), MouseEvent/KeyboardEvent/PointerEvent, Enter, submit(),
                  requestSubmit(), ou qualquer coisa que confirme a aposta.
     A verificacao por leitura de volta e obrigatoria: se o site nao aceitar o valor,
     o utilizador TEM de saber antes de carregar em Aposta.
     ============================================================================ */
  /* Escrita num campo, do modo que funciona em frameworks reactivas.

     Escrever `el.value = x` NÃO chega quando o campo é controlado por React/Vue: o
     framework tem um tracker interno do valor, e no render seguinte repõe o que ele julga
     ser o valor verdadeiro — a escrita é revertida e parece que "deu erro". O caminho
     correcto é o SETTER NATIVO do protótipo (HTMLInputElement.prototype), que passa por
     fora do tracker: é o mesmo mecanismo que o React usa internamente.

     Isto continua a ser escrita num campo, não interacção com um botão: nenhum clique,
     nenhuma tecla, nenhum submit. O que se acrescenta é precisamente que a escrita PEGUE. */
  function escreverNoCampo(el, v) {
    const valor = String(v);
    if (el.tagName === 'SELECT') {
      const r = escolherOpcao(el, valor);
      return r.ok ? 'select-' + r.como : 'select-falhou';
    }
    if (el.isContentEditable === true) {
      el.textContent = valor;
      return 'contenteditable';
    }
    try {
      const proto = (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) ? HTMLInputElement.prototype
                  : (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
                  : (typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
                  : null;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') {
        desc.set.call(el, valor);
        return 'setter-nativo';
      }
    } catch (e) { /* cai para a escrita simples */ }
    el.value = valor;
    return 'escrita-simples';
  }

  /* O React (e o Vue) deixam as suas propriedades internas nos nós do DOM. Encontrar uma
     delas responde a uma pergunta que muda tudo: o campo é controlado por um framework?
     Se for, a escrita directa em `.value` é revertida no render seguinte, e a única via
     que resta é o setter nativo do protótipo. */
  function controladoPorFramework(el) {
    try {
      const nomes = Object.getOwnPropertyNames(el) || [];
      for (const k of nomes) {
        if (k.indexOf('__reactProps$') === 0 || k.indexOf('__reactFiber$') === 0) return 'React';
        if (k.indexOf('__vue__') === 0 || k.indexOf('__vueParentComponent') === 0) return 'Vue';
        if (k.indexOf('_reactListening') === 0) return 'React';
      }
    } catch (e) { /* alguns elementos são exóticos: não vale a pena insistir */ }
    return null;
  }

  /* O que é este elemento, afinal? É esta a pergunta a que não se responde com heurísticas:
     responde-se a ler o DOM. Um controlo de "nº de minas" pode ser um <input type=range>,
     um <select>, um div com role=slider, ou um stepper de botões — e cada caso tem um
     desfecho diferente para o HUD. */
  function inspecionarCampo(sel, rotulo, elJa) {
    const item = { campo: rotulo, sel: sel || null };
    if (!sel) { item.estado = 'não ensinado'; return item; }
    let el = elJa || null;
    if (!el) { try { el = document.querySelector(sel); } catch (e) { item.estado = 'selector inválido'; return item; } }
    if (!el) { item.estado = 'não existe nesta página'; return item; }
    const tag = el.tagName || '';
    const escrevivel = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
    item.estado = 'existe';
    item.tag = tag + (el.type ? '[' + String(el.type).toLowerCase() + ']' : '');
    item.role = el.getAttribute ? (el.getAttribute('role') || '') : '';
    item.escrevivel = escrevivel;
    item.leitura = textoDoCampo(el).slice(0, 30);
    item.readOnly = !!el.readOnly;
    item.disabled = !!el.disabled;
    item.framework = controladoPorFramework(el);
    /* Num SELECT, o que interessa saber é quais são as opções — e se o valor que o plano
       pede existe lá dentro. "não escolheu o número de minas" responde-se aqui. */
    if (tag === 'SELECT' && el.options) {
      const opts = Array.prototype.slice.call(el.options);
      item.nOpcoes = opts.length;
      item.opcaoSeleccionada = opts[el.selectedIndex] ? String(opts[el.selectedIndex].textContent).trim() : null;
      item.opcoes = opts.map(o => String(o.textContent).trim()).slice(0, 30).join(' | ');
      const passo = currentStep();
      if (passo && passo.game === 'Mines') {
        const alvo = String(passo.mines);
        const achou = opts.some(o => String(o.value) === alvo || String(o.textContent).trim() === alvo ||
                                     parseMoney(o.textContent) === passo.mines ||
                                     parseMoney(o.value) === passo.mines);
        item.alvoDoPlanoExiste = achou;
        item.alvoDoPlano = passo.mines;
      }
    }
    item.motivo = escrevivel ? null
      : 'não aceita escrita por script: é um controlo do SITE (slider, stepper de botões, ou div). ' +
        'Só se muda com cliques, e o HUD não clica — muda-o tu, é 1 clique';
    return item;
  }

  function inspecionarCampos(pagina) {
    const g = pagina || detectGame();
    if (!g) return [];
    const f = (S.cfg.fields || {})[g] || {};
    return Object.keys(f).map(k => inspecionarCampo(f[k], g + '.' + k));
  }

  /* Texto puro da inspecção, para colar. Puro por desenho: testável sem browser. */
  function textoInspecao(itens, jogo) {
    if (!itens || !itens.length) return 'Inspecção: nenhum campo ensinado para ' + (jogo || 'este jogo') + '.';
    const L = ['Inspecção dos campos — ' + (jogo || '?')];
    itens.forEach(i => {
      L.push('  ' + i.campo);
      L.push('    estado:     ' + i.estado + (i.tag ? '  ·  ' + i.tag : '') + (i.role ? '  role=' + i.role : ''));
      if (i.estado !== 'existe') return;
      L.push('    lê:         «' + (i.leitura || '') + '»');
      L.push('    escrevível: ' + (i.escrevivel ? 'sim' : 'NÃO — ' + i.motivo));
      L.push('    atributos:  ' + (i.readOnly ? 'readOnly ' : '') + (i.disabled ? 'disabled ' : '') +
             (i.framework ? 'controlado por ' + i.framework : 'sem framework detectado'));
      if (i.nOpcoes != null) {
        L.push('    opções:     ' + i.nOpcoes + '  ·  escolhida: «' + (i.opcaoSeleccionada || '—') + '»');
        L.push('    lista:      ' + i.opcoes);
        if (i.alvoDoPlano != null) {
          L.push('    do plano:   ' + i.alvoDoPlano + ' existe nas opções? ' + (i.alvoDoPlanoExiste ? 'SIM' : 'NÃO'));
        }
      }
    });
    return L.join('\n');
  }

  /* O que se escreve no campo deve ser o que tu lês no plano. O plano diz «$0.30» e eu escrevia
     «0.3»: o site aceitava, mas obrigava-te a comparar à mão duas coisas escritas de forma
     diferente. Só se acrescenta o zero à direita — NUNCA se arredonda: se o valor não couber em
     duas casas (por exemplo $0.005), escreve-se exactamente como está, porque uma aposta
     arredondada é uma aposta que tu não autorizaste. */
  function textoDaAposta(v) {
    const n = typeof v === 'number' ? v : parseMoney(v);
    if (n == null || !isFinite(n)) return String(v);
    const duas = Number(n.toFixed(2));
    return duas === n ? n.toFixed(2) : String(v);
  }

  function setFieldValue(sel, val) {
    if (!sel) return { ok: false, motivo: 'campo não ensinado ao HUD' };
    let el; try { el = document.querySelector(sel); } catch (e) { return { ok: false, motivo: 'selector inválido' }; }
    if (!el) return { ok: false, motivo: 'campo não encontrado na página' };
    const insp = inspecionarCampo(sel, 'x', el);
    /* Um <span> com "1.29x" é um valor de LEITURA, e um div com role=slider é um controlo do
       SITE. Nos dois casos, dizer "não confirmei" seria um alarme falso sobre uma coisa que
       nunca foi para escrever por script — e o utilizador ficaria a procurar um erro que não
       existe. O motivo tem de dizer a verdade: este campo não é escrevível, e porquê. */
    if (!insp.escrevivel) return { ok: false, motivo: insp.motivo, tag: insp.tag, inspeccao: insp };

    const antes = textoDoCampo(el);
    try { el.focus(); } catch (e) {}
    const via = escreverNoCampo(el, val);
    if (el.tagName !== 'SELECT') {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    try { el.blur(); } catch (e) {}
    const depois = textoDoCampo(el);
    const depoisNumero = lerValorDeCampo(el);
    /* A confirmação é NUMÉRICA, não textual. Este era o falso erro do 0.30: eu escrevia
       «0.3» e o site normalizava para «0,30» ou «0.30», portanto a comparação de strings
       falhava e o painel dizia que o site não aceitou — quando tinha aceitado bem. */
    const n2 = parseMoney(val);
    const igual = (depoisNumero != null && n2 != null && Math.abs(depoisNumero - n2) < 1e-9) ||
                 String(depois) === String(val);
    if (via === 'select-falhou') {
      const r = escolherOpcao(el, val);
      return { ok: false, sel, antes, depois, depoisNumero, pretendido: String(val), via,
               tag: insp.tag, framework: insp.framework, inspeccao: insp,
               motivo: r.motivo || 'não consegui escolher a opção neste seletor' };
    }
    return { ok: igual, sel, antes, depois, depoisNumero, pretendido: String(val), via,
             tag: insp.tag, framework: insp.framework, inspeccao: insp,
             motivo: igual ? null : 'o campo não reteve o valor que escrevi' };
  }

  /* Guarda o selector de um campo ensinado pelo utilizador.
     Regra importante: o campo do VALOR DA APOSTA é o MESMO elemento no Dice e nas
     Minas, por isso ensina-lo UMA vez serve para ambos. Sem isto o utilizador teria
     de clicar no mesmo campo duas vezes e concluiria, com razão, que o HUD está avariado. */
  const CAMPO_ESPECIFICO = { stake: 'stake', mult: 'mult', mines: 'mines' };
  function teachField(alvo, sel) {
    S.cfg.fields = S.cfg.fields || {};
    const pontos = String(alvo || '').split('.');
    let jogos, campo, explicito;
    if (pontos.length === 2) { jogos = [pontos[0].toLowerCase()]; campo = pontos[1].toLowerCase(); explicito = true; }
    else { jogos = Object.keys(S.cfg.fields); campo = pontos[0].toLowerCase(); explicito = false; }
    if (!campo) return 'nada (nome de campo vazio)';
    /* Só no formato CURTO é que o token podia ser, por engano, um nome de jogo.
       Com jogo explícito («mines.mines») jogos=['mines'] e campo='mines' é legítimo:
       é o selector do NÚMERO DE MINAS — o campo em que o utilizador toca em quase
       todas as rondas. Filtrar aqui deixava-o sem poder ser ensinado. */
    if (!explicito) jogos = jogos.filter(j => j !== campo);
    /* «stake» vale para todos os jogos: é o mesmo input da página. */
    if (campo === 'stake') jogos = jogos.concat(Object.keys(S.cfg.fields)).concat(['dice', 'mines']);
    jogos = jogos.filter((j, i) => jogos.indexOf(j) === i);
    if (!jogos.length) return 'campo ' + campo + ' (nenhum jogo conhecido para guardar)';
    for (const j of jogos) {
      S.cfg.fields[j] = S.cfg.fields[j] || {};
      S.cfg.fields[j][campo] = sel || '';
    }
    return 'campo ' + campo + ' → ' + jogos.join(', ');
  }

  /* Configurar a ronda sozinho: escreve o valor e a configuração de minas/multiplicador do
     passo actual, sem ninguém carregar em nada.

     Onde está a linha, dita com precisão: isto escreve CAMPOS. Não carrega em Apostar, não
     abre casa, não retira. O clique que põe dinheiro em jogo continua a ser humano — e é
     esse clique que separa um assistente de um bot.

     Guardas que existem por bons motivos:
       - em pausa (Freno de mão) não escreve: configurar durante uma pausa seria contrariar
         o travão que tu próprio pediste;
       - só quando a página é a do jogo do passo actual (evita escrever o multiplicador do
         Dice num ecrã de Mines);
       - uma vez por passo e por número de rondas: nunca há um ciclo de escrita contínuo. */
  function autoConfigurar() {
    if (!S.cfg.autoFill) return { feito: false, motivo: 'desligado' };
    if (locked()) return { feito: false, motivo: 'em pausa' };
    const passo = currentStep();
    if (!passo) return { feito: false, motivo: 'rotação vazia' };
    const jogo = detectGame();
    const doPasso = passo.game === 'Dice' ? 'dice' : (passo.game === 'Mines' ? 'mines' : null);
    if (!jogo || jogo !== doPasso) return { feito: false, motivo: 'não é a página do passo (' + passo.label + ')' };
    const chave = passo.label + '|' + S.history.length;
    if (S.autoFeito === chave) return { feito: false, motivo: 'já configurado' };
    S.autoFeito = chave;
    const out = preencherNoSite();
    const resultados = out.resultados.map(x => ({ campo: x.campo, ok: !!x.ok, manual: !!x.manual,
      instrucao: x.instrucao || null, motivo: x.motivo || null }));
    S.autoLog.push({ at: Date.now(), chave: chave, resultados: resultados });
    if (S.autoLog.length > 40) S.autoLog.shift();
    if (S.cfg.debug) console.log('[Sessão 500] auto-configurar ' + chave + ' → ' +
      resultados.map(r => r.campo + (r.manual ? ' → ' + r.instrucao : (r.ok ? ' ✓' : ' ✗'))).join(', '));
    return { feito: true, resultados: resultados, chave: chave };
  }

  /* Um campo «à mão» é um campo que EXISTE, que o HUD lê, e que ele nunca consegue escrever —
     o nº de minas desenhado pelo site. Vive aqui, fora do bloco de interface, porque quem
     decide se escreve ou se diz o número é o preenchimento, não o painel. */
  function eManual(papel, campo) {
    const m = S.cfg.manual || {};
    return !!(m[papel] || (campo && m[campo]));
  }

  function preencherNoSite() {
    const g = detectGame();
    const f = (S.cfg.fields || {})[g] || {};
    const passo = currentStep();
    if (!passo) return { resultados: [], erro: 'rotação vazia' };
    const res = [];

    /* SO CONFIGURACAO PRE-RONDA. Nada de accoes dentro do jogo:
       - stake                : campo de formulario          -> preenchivel
       - multiplicador (Dice) : campo de formulario          -> preenchivel
       - nº de minas (Mines)  : controlo de configuracao     -> preenchivel
       - abrir uma casa       : accao de jogo (clique)       -> NUNCA tocada
       - retirar              : accao de jogo (clique)       -> NUNCA tocada */
    res.push(Object.assign({ campo: 'stake' }, setFieldValue(f.stake, textoDaAposta(S.cfg.stake))));
    if (passo.game === 'Dice') res.push(Object.assign({ campo: 'multiplicador' }, setFieldValue(f.mult, passo.mult.toFixed(4))));
    if (passo.game === 'Mines') {
      /* Um controlo do SITE não se escreve. Em vez de uma escrita que falha (e de um ✗ que
         faria parecer avaria o que é apenas o site a ser o site), sai daqui uma INSTRUÇÃO:
         o número que tu tens de escolher, dito sem rodeios. */
      if (eManual('mines.mines', 'mines')) {
        res.push({ campo: 'nº de minas', manual: true, ok: false,
          instrucao: 'ESCOLHE ' + passo.mines + ' no seletor das minas',
          motivo: 'o nº de minas é um controlo do próprio site: o HUD diz-te o número e escolhes tu' });
      } else {
        res.push(Object.assign({ campo: 'nº de minas' }, setFieldValue(f.mines, passo.mines)));
      }
    }
    return { resultados: res };
  }

  /* ==================== 4. LEITURA DO SALDO (SO LEITURA) ==================== */
  function readBalance() {
    if (!S.cfg.sel) return null;
    let el;
    try { el = document.querySelector(S.cfg.sel); } catch (e) { return null; }
    if (!el) return null;
    const txt = (el.textContent || '').trim();
    const v = parseMoney(txt);
    if (v == null) return null;
    S.cfg.rawLast = txt;
    return v;
  }

  /* Caminho CSS de um elemento, para o apanhador guardar. */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth++ < 6) {
      let p = cur.tagName.toLowerCase();
      if (cur.classList.length) p += '.' + CSS.escape(cur.classList[0]);
      const par = cur.parentElement;
      if (par) {
        const sibs = Array.from(par.children).filter(x => x.tagName === cur.tagName);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(p);
      if (cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
      cur = par;
    }
    return parts.join(' > ');
  }

  /* ==================== 3.4 DESCOBERTA AUTOMATICA DOS CAMPOS ====================
     Ensinar campos à mão era a ÚNICA fricção real deste HUD — e a que faz desistir
     antes de ver a estratégia a funcionar.

     Mas a distinção importa, e é fácil confundi-la:

       A ESTRATÉGIA está no código.  Edge de cada jogo, multiplicadores, rotação,
                                     EV, travões, orçamento de volume. Não falta nada.
       O MAPA não pode estar no código. Em que elemento do csgo500 vive o saldo,
                                     e onde estão os campos do valor, do multiplicador
                                     e do nº de minas. Isto é específico do site, muda
                                     quando ele redesenha, e nenhum código adivinha isto.

     O que se pode fazer é MEDIR e PROPÔR. É para isso que serve esta secção.
     A HUD nunca adopta um campo sozinha: pontua candidatos, mostra o texto cru que
     leu, e TU confirmas com um clique. Um saldo adivinhado mal estragaria as contas
     em silêncio; um clique é barato.
     ============================================================================ */
  const CHAVE_BALANCE = /balance|wallet|saldo|carteira|currency|amount|cash|money|coin|credit/i;
  const CHAVE_STAKE = /stake|bet|aposta|valor|amount|wager|montante/i;
  const CHAVE_MULT = /multipl|chance|payout|odds|cota/i;
  const CHAVE_MINES = /minas|mines|bombas|bombs/i;
  const MOEDA = /(USD|EUR|GBP|BRL|USDT|USDC|BTC|ETH|R\$|\$|\u20ac|\u00a3)/i;
  const MOEDA_G = /(USD|EUR|GBP|BRL|USDT|USDC|BTC|ETH|R\$|\$|\u20ac|\u00a3)/gi;

  /* Pontuação PURA (sem DOM): é o que os testes exercitam. Um saldo é um número com
     moeda, visível, de preferência no topo, numa folha curta, e — o sinal mais forte
     de todos — que MUDA entre duas observações. Um rótulo estático não muda. */
  function pontuarSaldo(texto, meta) {
    const t = String(texto == null ? '' : texto).trim();
    if (!t) return -99;
    const v = parseMoney(t);
    if (v == null) return -60;
    const m = meta || {};
    let p = 0;
    if (m.visivel) p += 3; else p -= 6;
    if (MOEDA.test(t)) p += 4;
    if (m.noTopo) p += 2;
    if (m.filhos != null && m.filhos <= 2) p += 1;
    if (CHAVE_BALANCE.test(m.chave || '')) p += 3;
    if (m.mudou) p += 3;
    if (m.interativo) p -= 4;
    if (t.length > 24) p -= 2;
    /* Se, tirando a moeda, os dígitos e os separadores, ainda SOBRA texto, isto não é um
       saldo — é uma frase que contém um número. «RTP verificado em 2024 pela equipa» tem
       de perder para «2024,00 USD», e é aqui que isso se decide. */
    const sobra = t.replace(MOEDA_G, '').replace(/[\d\s.,'\u2019+\-\u2212()]/g, '');
    if (sobra.length >= 2) p -= 12;
    return p;
  }

  /* Pontuação PURA de um candidato a campo, para um papel ('stake' | 'mult' | 'mines').

     Distinção que importa e que eu tinha baralhado: `legivel` é «consigo ler um número
     daqui» — verdadeiro para um input E para um <span> com "1.29x". `editavel` é «consigo
     ESCREVER aqui» — verdadeiro só para inputs. O multiplicador das Minas é texto, e basta
     lê-lo; o valor da aposta e o nº de minas têm de ser escrevíveis, porque é isso que o
     botão de preencher faz. Tratar os dois como a mesma coisa esconderia o multiplicador
     do utilizador — que é precisamente o número sem o qual não há recomendação nenhuma. */
  function pontuarCampo(meta, papel) {
    const m = meta || {};
    const v = parseMoney(m.valor);
    const chave = m.chave || '';

    /* VETOS. São requisitos binários, não penalizações — e a diferença não é estética:
       somar penalizações deixa um candidato claramente inválido ficar com pontuação
       positiva, e portanto APARECER na lista de propostas. Uma lista que inclui lixo
       treina o utilizador a aceitar lixo. Um requisito que falha não se compensa. */
    if (!m.legivel) return -99;                       // não se lê um número daqui
    if (papel !== 'mult' && !m.editavel) return -99;   // stake e minas são ESCRITOS, não só lidos
    if (v == null || !(v > 0)) return -99;
    if (papel === 'mult' && v < 0.99) return -99;      // abaixo de 1 não é multiplicador nenhum
    if (papel === 'mines' && v > 24) return -99;       // mais de 24 minas não existe no jogo

    let p = 3;                                         // legível e com número > 0
    if (m.visivel) p += 3; else p -= 12;
    if (m.tipo === 'number') p += 3;
    if (m.tipo === 'select') p += 1;   // select é escrevível e tem opções limitadas
    if (m.passo) p += 1;
    if (m.juntoDeBotao) p += 3;
    if (m.aoLadoDeX) p += 3;
    if (CHAVE_STAKE.test(chave)) p += 2;
    if (papel === 'mult') {
      if (CHAVE_MULT.test(chave)) p += 4;
      if (v > 1.001) p += 2; else p -= 2;
      if (!m.editavel) p += 1;   // ler é o suficiente: o multiplicador das Minas é texto
    }
    if (papel === 'mines') {
      if (CHAVE_MINES.test(chave)) p += 4;
      if (Math.abs(v - Math.round(v)) < 1e-9) p += 2;
    }
    if (papel === 'stake' && v <= 10000) p += 1;

    /* Discriminação ENTRE papéis. Um campo que se chama «mines-count» não é o valor da
       aposta, e um que se chama «bet-amount» não é o nº de minas. Sem isto, quem decidia
       a atribuição era o bónus geométrico («está perto do botão») — e decidia mal: na
       primeira versão o valor da aposta era atribuído ao campo das minas só porque ele
       ficava 30px mais perto do botão de apostar. O nome é evidência de intenção; a
       posição é só evidência de layout. */
    if (papel === 'stake' && (CHAVE_MINES.test(chave) || CHAVE_MULT.test(chave))) p -= 6;
    if (papel === 'mines' && CHAVE_STAKE.test(chave) && !CHAVE_MINES.test(chave)) p -= 6;
    if (papel === 'mult' && CHAVE_MINES.test(chave) && !CHAVE_MULT.test(chave)) p -= 6;
    if (!chave) p -= 1;
    return p;
  }

  /* Retângulo visível de um elemento, ou null. Separado da pontuação para manter a
     pontuação testável sem browser. */
  function caixaDoElemento(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return null; }
    if (!r || r.width < 8 || r.height < 6) return null;
    const alt = (typeof window !== 'undefined' && window.innerHeight) || 900;
    if (r.bottom < 0 || r.top > alt) return null;
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const st = window.getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0)) return null;
    }
    return r;
  }

  const chaveDoElemento = el => [
    el && el.id, el && el.name, el && el.placeholder,
    el && el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('data-testid') || '') : '',
    el && typeof el.className === 'string' ? el.className : ''
  ].filter(Boolean).join(' ');

  /* Memória do texto de cada elemento, entre duas buscas. É o que dá sentido ao sinal
     "mudou": a segunda busca (a que se faz depois de apostares uma vez) classifica
     melhor do que a primeira, porque já sabe o que se mexe. */
  const memoriaTexto = new WeakMap();

  const SELETORES_SALDO = [
    '[class*="balance" i]', '[class*="wallet" i]', '[class*="saldo" i]',
    '[id*="balance" i]', '[id*="wallet" i]', '[id*="saldo" i]', '[class*="currency" i]',
    '[class*="amount" i]', '[data-testid*="balance" i]', 'header span', 'header div',
    'nav span', 'nav div'
  ];

  /* Varredura limitada de FOLHAS de texto (elementos sem filhos). É isto que salva a
     descoberta num site com classes geradas — `css-1x2y3z` não diz nada, mas o texto
     «5,00 USD» diz tudo. Limitada de propósito: um tecto de nós e de candidatos, e só
     corre quando carregas no botão. */
  function folhasDeTexto(maxCandidatos) {
    let todos = [];
    try { todos = document.body ? document.body.querySelectorAll('*') : []; } catch (e) { return []; }
    const limite = Math.min(todos.length, 20000), out = [];
    for (let i = 0; i < limite; i++) {
      const el = todos[i];
      if (el.children && el.children.length) continue;
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 40) continue;
      out.push({ el, txt });
      if (out.length >= (maxCandidatos || 400)) break;
    }
    return out;
  }

  function procurarSaldo() {
    const vistos = new Set(), els = [];
    for (const sel of SELETORES_SALDO) {
      let achados = [];
      try { achados = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of achados) {
        if (els.length >= 300) break;
        if (vistos.has(el)) continue;
        vistos.add(el);
        els.push(el);
      }
    }
    /* Complemento: folhas cujo texto parece dinheiro, mesmo sem nome nenhum que ajude. */
    for (const f of folhasDeTexto(400)) {
      if (vistos.has(f.el)) continue;
      if (!MOEDA.test(f.txt) && !/^\d[\d\s.,]*$/.test(f.txt)) continue;
      vistos.add(f.el);
      els.push(f.el);
      if (els.length >= 400) break;
    }
    const dentroDoHud = el => { let c = el; while (c) { if (c.tagName === 'P500-HUD') return true; c = c.parentElement; } return false; };
    const alt = (typeof window !== 'undefined' && window.innerHeight) || 900;
    const out = [];
    for (const el of els) {
      if (dentroDoHud(el)) continue;
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 60) continue;
      const r = caixaDoElemento(el);
      const anterior = memoriaTexto.get(el);
      memoriaTexto.set(el, txt);
      const pontos = pontuarSaldo(txt, {
        visivel: !!r,
        noTopo: !!r && r.top < alt * 0.22,
        filhos: el.children ? el.children.length : 0,
        chave: chaveDoElemento(el),
        mudou: anterior !== undefined && anterior !== txt,
        interativo: /^(INPUT|BUTTON|A|SELECT|TEXTAREA)$/.test(el.tagName)
      });
      out.push({ sel: cssPath(el), texto: txt, pontos });
    }
    out.sort((a, b) => b.pontos - a.pontos);
    /* Só propostas com pontuação positiva e distintas entre si. */
    const vistas = new Set(), final = [];
    for (const c of out) {
      if (c.pontos <= 0 || vistas.has(c.texto)) continue;
      vistas.add(c.texto);
      final.push(c);
      if (final.length === 3) break;
    }
    return final;
  }

  function procurarCampos() {
    /* input, textarea E select. O select não pode faltar: no csgo500 o número de minas é um
       seletor de 1 a 24, e uma busca que só olha para <input> nunca o encontraria. */
    let inputs = [];
    try { inputs = document.querySelectorAll('input, textarea, select'); } catch (e) { return []; }
    let botoes = [];
    try { botoes = document.querySelectorAll('button, [role="button"]'); } catch (e) { botoes = []; }
    const caixasDeBotao = [];
    for (const b of botoes) {
      const r = caixaDoElemento(b);
      if (r && r.width * r.height > 1200) caixasDeBotao.push(r);   // só botões a sério, não ícones
    }
    const out = [];
    for (const el of inputs) {
      const ehSelect = el.tagName === 'SELECT';
      const tipo = ehSelect ? 'select' : String(el.type || 'text').toLowerCase();
      if (!ehSelect && ['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'password'].indexOf(tipo) !== -1) continue;
      const r = caixaDoElemento(el);
      const pai = el.parentElement;
      const irmaos = pai && pai.textContent ? String(pai.textContent).replace(String(el.value || ''), '') : '';
      const juntoDeBotao = !!r && caixasDeBotao.some(b => Math.abs((b.top + b.height / 2) - (r.top + r.height / 2)) < r.height * 3 && b.left >= r.left - 40);
      const meta = {
        /* Num select, o que se compara é o TEXTO da opção escolhida («3»), não o `value`,
           que pode ser um identificador sem número nenhum. */
        valor: ehSelect
          ? String((el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent : ''))
          : el.value,
        tipo,
        chave: chaveDoElemento(el),
        passo: el.step != null && el.step !== '',
        visivel: !!r,
        legivel: true,
        editavel: !el.disabled && !el.readOnly,
        juntoDeBotao,
        aoLadoDeX: /(^|\s)[x\u00d7](\s|$)|\.\d+x|\dx/i.test(irmaos)
      };
      const sel = cssPath(el);
      for (const papel of ['stake', 'mult', 'mines']) {
        const pontos = pontuarCampo(meta, papel);
        if (pontos > 0) out.push({ sel, papel, pontos, valor: String(el.value), chave: meta.chave });
      }
    }

    /* O multiplicador das MINAS costuma ser TEXTO ("1.29x"), não um input. Sem esta
       passagem, o campo mais importante do jogo em que mais se joga ficava invisível à
       busca — e o utilizador concluiria, com razão, que a busca não presta. */
    const FORMAMULT = /^\d{1,9}(?:[.,]\d{1,6})?\s*[x\u00d7]$/i;
    const vistosTexto = new Set();
    const considerarTexto = el => {
      if (!el || vistosTexto.has(el) || el.tagName === 'INPUT') return;
      vistosTexto.add(el);
      const txt = (el.textContent || '').trim();
      /* forma de multiplicador: 1.29x / 1,29x / 2x — e nada mais na linha */
      if (!FORMAMULT.test(txt)) return;
      const r = caixaDoElemento(el);
      const pontos = pontuarCampo({
        valor: txt, tipo: 'texto', chave: chaveDoElemento(el), visivel: !!r,
        legivel: true, editavel: false, aoLadoDeX: true
      }, 'mult');
      if (pontos > 0) out.push({ sel: cssPath(el), papel: 'mult', pontos, valor: txt, chave: chaveDoElemento(el) });
    };
    const SELETORES_MULT = ['[class*="mult" i]', '[class*="chance" i]', '[class*="payout" i]',
                            '[class*="odds" i]', '[data-testid*="mult" i]'];
    for (const selT of SELETORES_MULT) {
      let achados = [];
      try { achados = document.querySelectorAll(selT); } catch (e) { continue; }
      for (const el of achados) considerarTexto(el);
    }
    /* E o mesmo complemento de folhas: o multiplicador das Minas pode estar num <span>
       sem classe nenhuma, com o texto «1.29x» e mais nada. */
    for (const f of folhasDeTexto(400)) considerarTexto(f.el);
    out.sort((a, b) => b.pontos - a.pontos);
    const porPapel = {};
    for (const c of out) {
      if (porPapel[c.papel] && porPapel[c.papel].sel === c.sel) continue;
      porPapel[c.papel] = porPapel[c.papel] || c;
    }
    return porPapel;
  }

  /* ==================== 5. DETECCAO DE RONDA POR DELTA ====================
     O coracao do HUD. Em vez de tu registares a ronda, o HUD observa a VARIACAO do saldo
     e infere o que aconteceu. Nao clica em nada: apenas le.

       delta == -stake                     -> derrota
       delta == +stake*(mult-1)            -> vitoria
       delta == 0                          -> nada
       delta grande positivo               -> deposito / ganho externo
       delta grande negativo               -> saque / aposta fora do plano
       qualquer outra coisa                -> indeterminado (o utilizador classifica)
     ======================================================================= */
  const near = (a, b) => Math.abs(a - b) < 0.005;

  function classify(delta) {
    const step = currentStep();
    const stake = S.cfg.stake;
    if (!step) return { result: 'unknown', note: 'rotação vazia' };
    const winGain = stake * (step.mult - 1);
    if (near(delta, -stake)) return { result: 'lose', step };
    if (near(delta, winGain)) return { result: 'win', step };
    if (delta > winGain + 0.02 && delta > stake) return { result: 'external', step, note: 'depósito ou ganho fora do plano' };
    if (delta < -stake - 0.02) return { result: 'external', step, note: 'saque ou aposta maior que o plano' };
    return { result: 'unknown', step, note: 'delta ' + delta.toFixed(2) };
  }

  let unknownQueue = [];

  function onBalance(b) {
    if (S.startBalance == null) { S.startBalance = b; S.balance = b; S.lastSeen = b; render(); return; }
    S.balance = b;
    if (S.lastSeen == null) { S.lastSeen = b; return; }
    const delta = Math.round((b - S.lastSeen) * 100) / 100;
    S.lastSeen = b;
    if (Math.abs(delta) < 0.005) return;
    if (!S.cfg.autoDetect) return;
    commit(delta);
  }

  function commit(delta) {
    const info = classify(delta);
    const step = info.step;
    const stake = S.cfg.stake;
    if (info.result === 'win') { S.lossStreak = 0; }
    else if (info.result === 'lose') { S.lossStreak++; }
    S.history.push({
      i: S.history.length + 1, game: step ? step.label : '?', stake: Math.abs(delta) > stake ? Math.abs(delta) : stake,
      mult: step ? step.mult : 0, delta, result: info.result, balance: S.balance, at: Date.now(), auto: true,
      /* guardar o MOTIVO da classificacao: sem isto o utilizador ve "external" e nao
         sabe se foi um deposito, um saque ou uma aposta fora do plano. */
      note: info.note || ''
    });
    if (info.result === 'win' || info.result === 'lose') S.cursor++;
    if (info.result === 'unknown' || info.result === 'external') unknownQueue.push({ delta, at: Date.now(), note: info.note });
    checkTriggers(info.result === 'win' ? stake * ((step ? step.mult : 1) - 1) : 0, step);
  }

  /* ============================ 6. TRAVOES ============================ */
  function locked() { return !!S.lockKind && Date.now() < S.lockUntil; }
  function openLock(kind, secs, why, foot) {
    S.lockKind = kind; S.lockUntil = Date.now() + secs * 1000; S.lockStart = Date.now();
    S.lockWhy = why || ''; S.lockFoot = foot || '';
    render();
  }
  function releaseLock() {
    if (!S.lockKind) return;
    S.breaks.push({ kind: S.lockKind, secs: (Date.now() - S.lockStart) / 1000, afterRound: S.history.length, at: Date.now() });
    if (S.lockKind === 'streak') S.lossStreak = 0;
    S.lockKind = null; S.lockUntil = 0; S.lockWhy = ''; S.lockFoot = '';
    render();
  }
  function roundsSinceBreak() { return S.history.length - (S.breaks.length ? S.breaks[S.breaks.length - 1].afterRound : 0); }
  function checkTriggers(winGain, step) {
    const g = S.cfg.guard;
    if (locked() || S.ended) return;
    if (S.lossStreak >= g.lossStreak) return openLock('streak', g.lossCool, S.lossStreak + ' derrotas seguidas detectadas. É o momento clássico de apostar na emoção.');
    if (winGain >= g.winCoolAmount) return openLock('win', g.winCoolSecs, 'Ganho de ' + winGain.toFixed(2) + ' numa ronda. É aqui que se sobe o stake.');
    if (roundsSinceBreak() >= g.microEvery) return openLock('micro', g.microSecs, roundsSinceBreak() + ' rondas sem parar.');
  }

  /* ============================ 7. UI (Shadow DOM) ============================
     Shadow DOM: o CSS do casino nao entra aqui e o meu nao sai para fora. Nao ha
     colisoes de nomes possiveis e o site nao pode partir o painel.
     ============================================================================ */
  const CSS_TEXT = `
  :host{ all:initial; }
  *{ box-sizing:border-box; margin:0; padding:0; }
  .hud{
    position:fixed; top:0; right:0; height:100vh; width:322px; z-index:2147483646;
    background:#12101a; color:#e8e6f0; border-left:1px solid #2e2a3f;
    font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex; flex-direction:column; overflow:hidden;
  }
  .hud.min{ width:0; border:none; }
  .tab{
    position:fixed; top:50%; right:0; transform:translateY(-50%); z-index:2147483647;
    background:#ff5773; color:#fff; border:none; border-radius:10px 0 0 10px; cursor:pointer;
    font:700 11px/1.2 ui-monospace,monospace; padding:14px 7px; letter-spacing:1px; writing-mode:vertical-rl;
  }
  .tab.hide{ display:none; }
  .body{ overflow-y:auto; padding:14px; flex:1; }
  h2{ font-size:10px; text-transform:uppercase; letter-spacing:1.2px; color:#8b8798; font-weight:600; margin:16px 0 8px; }
  h2:first-child{ margin-top:0; }
  .row{ display:flex; gap:8px; align-items:center; }
  .bal{ font:700 30px/1.1 ui-monospace,monospace; }
  .raw{ font:11px/1.4 ui-monospace,monospace; color:#8b8798; word-break:break-all; }
  .pnl{ font:700 15px/1.3 ui-monospace,monospace; }
  .kv{ display:flex; justify-content:space-between; gap:8px; padding:4px 0; border-bottom:1px solid #262238; font-size:12px; }
  .kv b{ font-family:ui-monospace,monospace; font-weight:600; }
  .bar{ height:7px; border-radius:99px; background:#232032; overflow:hidden; margin:7px 0; }
  .bar>i{ display:block; height:100%; width:0; background:#3ddc97; transition:width .25s; }
  .bar.w>i{ background:#f5c451; } .bar.b>i{ background:#ff6b6b; }
  button{ font:600 12px/1 inherit; color:#e8e6f0; background:#232032; border:1px solid #2e2a3f;
          border-radius:9px; padding:9px 10px; cursor:pointer; }
  button:hover{ border-color:#4a4463; }
  button.shield{ width:100%; padding:13px; font-size:13.5px; border-radius:11px;
                 background:linear-gradient(135deg,#1e4a38,#2a6b52); border-color:#3a8f6d; color:#d6fbec; }
  button.impulse{ width:100%; margin-top:7px; border-style:dashed; border-color:#6a5a3a; color:#f5c451; background:transparent; }
  button.w{ width:100%; }
  .log{ max-height:150px; overflow:auto; font:11.5px/1.6 ui-monospace,monospace; }
  .log td{ padding:2px 6px 2px 0; }
  .win{ color:#3ddc97; } .lose{ color:#ff6b6b; } .other{ color:#8b8798; }
  .flag{ border-left:3px solid #f5c451; padding-left:9px; margin:9px 0; font-size:12px; color:#d9d6e6; }
  .flag.bad{ border-color:#ff6b6b; } .flag.ok{ border-color:#3ddc97; }
  input,select{ font:12px/1 inherit; color:#e8e6f0; background:#232032; border:1px solid #2e2a3f;
                border-radius:8px; padding:7px 8px; width:100%; }
  label{ display:block; font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#8b8798; margin:8px 0 4px; }
  details>summary{ cursor:pointer; color:#8b8798; font-size:11.5px; margin-top:12px; }
  #overlay{ position:fixed; inset:0; background:rgba(9,8,14,.955); z-index:2147483647;
            display:none; align-items:center; justify-content:center; padding:24px; }
  #overlay.on{ display:flex; }
  .obox{ max-width:520px; width:100%; background:#1b1826; border:1px solid #2e2a3f; border-radius:16px; padding:26px; }
  .obox h3{ font-size:12px; text-transform:uppercase; letter-spacing:1.4px; color:#f5c451; margin-bottom:8px; }
  .ot{ font:700 50px/1 ui-monospace,monospace; }
  .obox ul{ list-style:none; margin-top:14px; }
  .obox li{ padding:6px 0 6px 22px; position:relative; font-size:13.5px; border-bottom:1px solid #262238; }
  .obox li:before{ content:"→"; position:absolute; left:2px; color:#ff5773; font-weight:700; }
  /* pointer-events:none de propósito: a máscara existe para se VER, não para receber cliques.
     Com cliques, era ela que aparecia debaixo do cursor e o HUD aprendia a máscara em vez do
     campo — o apanhador capturava-se a si mesmo. O realce do que está por baixo continua a
     funcionar porque o mousemove é ouvido na janela, em fase de captura. */
  .pick{ position:fixed; inset:0; z-index:2147483647; pointer-events:none; background:rgba(255,87,115,.10); }
  .pickHint{ position:fixed; top:12px; left:50%; transform:translateX(-50%); background:#ff5773; color:#fff;
             padding:11px 16px; border-radius:10px; font:600 13px/1.3 sans-serif; z-index:2147483647; }
  .pickHover{ outline:2px solid #3ddc97 !important; background:rgba(61,220,151,.14) !important; }
  /* O painel da captura guiada vive dentro do Shadow DOM (é a única forma de ter este CSS)
     e assenta no topo do ecrã — longe do painel do HUD e do jogo. */
  .capPanel{ position:fixed; top:12px; left:50%; transform:translateX(-50%); width:min(580px,95vw);
             background:#12101c; border:1px solid #3a3550; border-radius:14px; padding:15px 17px;
             z-index:2147483647; color:#e8e6f0; font:13px/1.45 -apple-system,"Segoe UI",sans-serif;
             box-shadow:0 14px 44px rgba(0,0,0,.65); }
  /* Arrastável e minimizável. Um painel fixo tapa sempre o sítio onde está a coisa que te pedi
     para clicar — e tapar o saldo tornava a captura impossível de completar. */
  .capPanel .capCab{ display:flex; align-items:center; gap:8px; cursor:move; margin-bottom:9px; }
  .capPanel h4{ font-size:11.5px; text-transform:uppercase; letter-spacing:1.3px; color:#ff5773; flex:1; }
  .capPanel .capCab button{ padding:2px 9px; font-size:13px; line-height:1.2; }
  .capPanel.min .corpo{ display:none; }
  .capPanel .alvo{ font-weight:700; font-size:15.5px; line-height:1.3; }
  .capPanel .fila{ font:11.5px/1.6 ui-monospace,monospace; color:#8b8798; margin-top:9px;
                   max-height:104px; overflow:auto; }
  .capPanel .capBtns{ display:flex; gap:8px; margin-top:11px; }
  .capPanel .capBtns button{ flex:1; }
  .recT{ font:700 19px/1.25 -apple-system,"Segoe UI",sans-serif; margin:6px 0 8px; letter-spacing:.2px; }
  /* Aviso sobre o tabuleiro. pointer-events:none no contentor de propósito: ele ACONSELHA,
     não bloqueia nem clica. Sem isto, o aviso tapava o jogo e passava a ser ele a decidir. */
  .aviso{ position:fixed; z-index:2147483646; pointer-events:none; display:none; max-width:min(430px,86vw); }
  .aviso.on{ display:block; }
  .aviso .cx{ background:rgba(18,16,28,.95); border:1px solid #3a3550; border-radius:14px;
              padding:13px 15px; box-shadow:0 12px 40px rgba(0,0,0,.55); }
  .aviso .tt{ font:700 22px/1.15 -apple-system,"Segoe UI",sans-serif; letter-spacing:.2px; margin:0 0 6px; }
  .aviso .ln{ font:12.5px/1.5 ui-monospace,monospace; color:#c9c4da; }
  .aviso .fim{ margin-top:9px; font-size:11.5px; color:#8b8798; }
  .aviso button{ pointer-events:auto; font:600 12.5px/1 inherit; background:#232032; color:#e8e6f0;
                 border:1px solid #3a3550; border-radius:9px; padding:8px 11px; margin:8px 6px 0 0; cursor:pointer; }
  .aviso .chip{ pointer-events:none; font:600 12px/1 -apple-system,"Segoe UI",sans-serif; color:#b9b4c9;
                background:rgba(18,16,28,.9); border:1px solid #3a3550; border-radius:999px; padding:7px 11px; }
  .aviso.pausa .cx{ border-color:#f5c451; }
  `;

  const HTML_TEXT = `
  <button class="tab hide" id="tab">SESSÃO 500</button>
  <div class="hud" id="hud">
    <div class="body">
      <!-- Aviso no topo: quando o HUD não consegue trabalhar, a explicação tem de estar
           no primeiro ecrã. Um painel que só diz «—» faz desistir. -->
      <div id="diagBanner"></div>

      <h2>Recomendação · jogo detectado</h2>
      <div id="rec"></div>
      <!-- FORA do #rec de propósito: renderRec() reescreve o #rec por inteiro a cada 900 ms,
           e uma mensagem escrita lá dentro desaparecia antes de poder ser lida. Era isso que
           tornava o "deu erro" impossível de diagnosticar: aparecia e sumia. -->
      <div id="fillStatus"></div>

      <h2>Saldo lido do site</h2>
      <div class="bal" id="bal">—</div>
      <div class="raw" id="raw">à espera do selector do saldo</div>

      <h2>Lucro / Prejuízo</h2>
      <div class="pnl" id="pnl">—</div>

      <h2>Orçamento de volume</h2>
      <div class="kv"><span id="volTxt">—</span><b id="volPct">—</b></div>
      <div class="bar" id="volBar"><i></i></div>
      <div class="raw" id="edgeTxt">—</div>

      <h2>Ronda detectada</h2>
      <div class="log" id="log"></div>

      <h2>Diagnóstico</h2>
      <div id="diagCaixa"></div>
      <button id="btnLer" class="w">Ler o saldo agora</button>
      <button id="btnCopiarDiag" class="w">Copiar diagnóstico (para colar onde quiseres)</button>
      <label>Registar cada mudança de saldo na consola (debug)</label>
      <select id="debug"><option value="1">ligado</option><option value="0">desligado</option></select>
      <div class="raw" id="diagOut" style="margin-top:6px"></div>

      <h2>Freno de mão</h2>
      <div class="kv"><span>Tempo em pausa</span><b id="brTime">0:00</b></div>
      <div class="kv"><span>Sequência de derrotas</span><b id="brStreak">0</b></div>
      <div class="kv"><span>Desde a última pausa</span><b id="brSince">0</b></div>
      <div class="kv"><span>Impulsos registados</span><b id="brImp">0</b></div>

      <h2>Botão de disciplina</h2>
      <button class="shield" id="btnShield">🛡 Vou apostar com disciplina</button>
      <button class="impulse" id="btnImpulse">⚡ Impulso de fugir ao plano</button>
      <button id="btnGate" class="w" style="margin-top:7px;font-size:11.5px">Quero alterar o plano (gate 60 s)</button>

      <div id="alerts"></div>

      <details>
        <summary>Configuração e ligação ao saldo</summary>
        <label>Selector do saldo (ou usa o apanhador)</label>
        <input id="sel" placeholder="ex: .balance-value">
        <button id="btnPick" class="w" style="margin-top:6px">🎯 Clicar no saldo no site</button>
        <label>Stake fixo ($)</label><input id="stake" type="number" step="0.05">
        <label>Orçamento inicial ($)</label><input id="budget" type="number" step="0.5">
        <label>Edge do jogo (%)</label><input id="edge" type="number" step="0.1">
        <label>Detecção automática de rondas</label>
        <select id="auto"><option value="1">ligada</option><option value="0">desligada (só manual)</option></select>
        <label>Aviso sobre o tabuleiro (só conselho — nunca clica)</label>
        <select id="overlay"><option value="1">ligado</option><option value="0">desligado</option></select>
        <label>Escrever a configuração da ronda sozinho (valor + minas)</label>
        <select id="autoFill"><option value="0">desligado</option><option value="1">ligado — nunca clica em Apostar</option></select>

        <label>Rotação (uma por linha: <code>dice 2.0</code> / <code>mines 3 2</code>)</label>
        <textarea id="rot" rows="5"></textarea>
        <label>MAPA do site — a estratégia já está no código; isto só encontra onde as coisas vivem aqui</label>
        <button id="btnCapturar" class="w">🎯 Captura guiada — clico nos elementos e ele apanha-os (recomendado)</button>
        <div class="raw" style="margin-top:5px">Entras uma vez: saldo → valor da aposta → nº de minas →
          tabuleiro. Clicas em cada um, por ordem, e ele <b>valida antes de guardar</b> — um clique no sítio
          errado é recusado com o motivo. Esc termina.</div>
        <button id="btnAuto" class="w">🔎 Procurar o saldo e os campos por mim</button>
        <div class="raw" id="autoOut" style="margin-top:6px"></div>
        <button id="btnInsp" class="w" style="margin-top:6px">🔬 Inspecionar os campos (o que são, afinal, e se dão para escrever)</button>
        <button id="btnInspCopiar" class="w">Copiar inspecção</button>
        <div class="raw" id="inspOut" style="margin-top:6px"></div>

        <label>Ensinar um campo do site à mão (se preferires)</label>
        <select id="teachWhich">
          <option value="stake">Valor da aposta (serve para Dice e Mines)</option>
          <option value="dice.mult">Dice · campo do multiplicador</option>
          <option value="mines.mines">Mines · selector do nº de minas</option>
          <option value="mines.mult">Mines · multiplicador mostrado no ecrã</option>
          <option value="mines.board">Mines · tabuleiro (para o aviso ficar por cima)</option>
          <option value="dice.board">Dice · tabuleiro (para o aviso ficar por cima)</option>
        </select>
        <div class="raw" style="margin-top:6px">O «tabuleiro» só serve para posicionar o aviso. Se não
          souberes qual é, o aviso fica no topo do ecrã — funciona na mesma.</div>
        <div class="raw" style="margin-top:8px">Nota sobre o modo <b>demo/fun</b>: aí o saldo real não se
          move, por isso não há variação nenhuma a detectar. O HUD lê o teu saldo — se estiveres em demo,
          ele diz-to no diagnóstico em vez de fingir que está a funcionar.</div>
        <button id="btnTeach" class="w" style="margin-top:6px">🎯 Clicar no elemento no site</button>
        <div class="raw" id="teachStatus" style="margin-top:6px"></div>
        <button id="btnTestarMapa" class="w" style="margin-top:6px">✅ Testar o mapa agora (escreve a configuração e confirma)</button>
        <!-- O resultado de uma captura vive FORA da lista de campos, de propósito: a lista é
             reescrita a cada 900 ms pelo render, e uma mensagem escrita lá desaparecia antes de
             ser lida — a mesma armadilha que já tinha apanhado no estado do preenchimento. -->
        <div id="capOut" style="margin-top:6px"></div>
        <div class="raw" style="margin-top:8px">Só se ensinam campos de CONFIGURAÇÃO.
          Abrir casa e retirar são acções de jogo — o HUD nunca as toca.</div>

        <button id="btnSave" class="w" style="margin-top:8px">Guardar configuração</button>
        <button id="btnReset" class="w" style="margin-top:6px">Nova sessão</button>
        <details style="margin-top:12px"><summary>Limites de desenho deste HUD</summary>
          <div class="raw" style="margin-top:8px">Lê o saldo. Não clica, não submete, não chama API.
          A detecção de rondas é inferida por variação de saldo — nunca por execução de apostas.
          Se os números não baterem certo, corrige no log; a leitura é heurística, não autoritativa.</div>
        </details>
      </details>
    </div>
  </div>
  <div id="aviso"></div>
  <div id="overlay"><div class="obox" id="obox"></div></div>
  `;

  function buildUI() {
    /* nome de elemento personalizado (com hifen): o CSS do casino e muito menos
       provavel que o apanhe do que um <div> generico. Isolamento de estilo em duas
       camadas: tag improvável + Shadow DOM. */
    const host = document.createElement('p500-hud');
    host.style.cssText = 'all:initial;';
    // isolamento total: o CSS do casino nao entra, o meu nao sai
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML_TEXT;
    root.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    return root;
  }

  let root = null;
  const $ = id => root.getElementById(id);
  const MONEY = v => (v < 0 ? '−' : '') + '$' + Math.abs(v).toFixed(2);
  const mmss = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  /* ============================== 8. RENDER ============================== */
  /* ==================== 7.5 DIAGNOSTICO ====================
     Um HUD que não funciona em silêncio é pior do que nenhum: a pessoa conclui que a
     ferramenta está avariada e desiste. Este bloco responde, no ecrã e em português, à
     única pergunta que importa quando nada acontece: PORQUÊ.

     Os cinco estados da ligação ao saldo — que é o que alimenta tudo o resto:
       sem-selector    nunca foi ensinado (nem pela busca automática)
       nao-encontrado  o selector existe, mas já não corresponde a nada na página
       nao-numerico    achou o elemento, mas não há número reconhecível dentro
       saldo-zero      leu um número, e é zero — a conta está vazia
       ligado          leu um saldo positivo. Está a funcionar

     A distinção entre os três do meio é o que evita o pior diagnóstico possível: dizer
     «não dá» quando o problema é «não tens saldo» (ou ao contrário).
     ======================================================== */
  function estadoDaLigacao() {
    if (!S.cfg.sel) {
      return { codigo: 'sem-selector', nivel: 'bad',
        titulo: 'O HUD não sabe onde está o teu saldo',
        detalhe: 'Sem saldo não há deteção de rondas, nem orçamento, nem travões: é o saldo que alimenta tudo o resto.',
        acao: 'Configuração → «Procurar o saldo e os campos por mim».' };
    }
    let el = null;
    try { el = document.querySelector(S.cfg.sel); } catch (e) { el = null; }
    if (!el) {
      return { codigo: 'nao-encontrado', nivel: 'bad',
        titulo: 'O selector do saldo já não corresponde a nada',
        detalhe: 'Guardado como ' + S.cfg.sel + ' — não existe nesta página. O casino pode ter mudado o layout, ou o saldo só aparece depois de entrares na conta.',
        acao: 'Procura outra vez. Se continuar a falhar, ensina à mão com o apontador.' };
    }
    const txt = (el.textContent || '').trim();
    const v = parseMoney(txt);
    if (v == null) {
      return { codigo: 'nao-numerico', nivel: 'bad',
        titulo: 'Encontrei o elemento, mas não leio um número nele',
        detalhe: 'O texto que está lá dentro é «' + txt.slice(0, 60) + '»',
        acao: 'Escolhe outro candidato na busca — provavelmente apanhaste um rótulo em vez do valor.' };
    }
    if (!(v > 0)) {
      return { codigo: 'saldo-zero', nivel: 'warn',
        titulo: 'Leio o teu saldo como ' + MONEY(v) + ' — a conta está vazia',
        detalhe: 'Li «' + txt.slice(0, 60) + '». O HUD está a funcionar; não há é nada para jogar. Com saldo zero não há rondas para detetar nem orçamento para medir.',
        acao: 'Confirma no site se o saldo que vês é mesmo esse. Se for, é só depositar.' };
    }
    /* Lê bem, tem saldo, e o valor nunca mudou. Três hipóteses honestas, sem escolher por ti. */
    if (S.leituras.length >= 8 && S.nMudancas === 0) {
      return { codigo: 'sem-movimento', nivel: 'warn',
        titulo: 'Leio o saldo, mas ele não se move há ' + S.nLeituras + ' leituras',
        detalhe: 'Está em ' + MONEY(v) + ' e nunca mudou desde que o HUD arrancou. Três explicações possíveis: (1) ainda não apostaste; (2) estás em modo demo/fun — aí o saldo real não se move, e não há rondas para detectar; (3) o elemento que escolhi mostra um valor que não é o saldo, ou está congelado.',
        acao: 'Aposta uma vez e vê se o número muda. Se não mudar, procura o saldo outra vez.' };
    }
    return { codigo: 'ligado', nivel: 'ok', titulo: 'Ligado — leio ' + MONEY(v),
      detalhe: 'String crua: «' + txt.slice(0, 60) + '» · ' + S.nLeituras + ' leituras, ' + S.nMudancas + ' com valor diferente',
      acao: '' };
  }

  function registarLeitura(raw, v) {
    S.nLeituras++;
    const anterior = S.leituras.length ? S.leituras[S.leituras.length - 1].raw : null;
    const mudou = S.leituras.length > 0 && anterior !== (raw == null ? null : String(raw));
    if (mudou) S.nMudancas++;
    S.leituras.push({ t: Date.now(), raw: raw == null ? null : String(raw).slice(0, 40), v: v, mudou: mudou });
    if (S.leituras.length > 12) S.leituras.shift();
    /* Com debug ligado, cada MUDANÇA aparece na consola. Só as mudanças: registar 900 ms de
       leituras iguais enchia a consola e escondia o que interessa. */
    if (S.cfg && S.cfg.debug && mudou) {
      const c = classify(v != null && S.lastSeen != null ? Math.round((v - S.lastSeen) * 100) / 100 : 0);
      console.log('[Sessão 500] saldo ' + (v == null ? 'ilegível' : v) + '  ← «' + raw + '»' +
        (c && c.result !== 'unknown' ? '  →  ' + c.result + (c.step ? ' (' + c.step.label + ')' : '') : ''));
    }
    return mudou;
  }

  function diagnostico() {
    const lig = estadoDaLigacao();
    const campos = {};
    for (const jogo of ['dice', 'mines']) {
      const f = (S.cfg.fields || {})[jogo] || {};
      campos[jogo] = {};
      for (const k of Object.keys(f)) {
        if (!f[k]) continue;
        let el = null;
        try { el = document.querySelector(f[k]); } catch (e) { el = null; }
        campos[jogo][k] = {
          sel: f[k],
          existe: !!el,
          valor: el ? String(el.value != null && el.value !== '' ? el.value : el.textContent).trim().slice(0, 30) : null
        };
      }
    }
    const passo = currentStep();
    return {
      versao: VERSAO,
      url: (typeof location !== 'undefined' ? location.href : ''),
      jogo: detectGame(),
      passo: passo ? passo.label : null,
      ligacao: lig,
      saldo: S.balance,
      saldoInicial: S.startBalance,
      leituras: S.nLeituras,
      mudancas: S.nMudancas,
      ultimas: S.leituras.slice(-6),
      rondas: S.history.length,
      volume: S.history.reduce((a, h) => a + (h.result === 'external' ? 0 : h.stake), 0),
      travado: !!locked(),
      pausas: S.breaks.length,
      avisoSobreOTabuleiro: !!S.cfg.overlay,
      configurarSozinho: !!S.cfg.autoFill,
      decisões: S.decisions.length,
      autoConfiguracoes: S.autoLog.slice(-4),
      campos: campos,
      camposEnsinados: Object.keys(S.cfg.fields || {}).reduce((a, j) => {
        a[j] = Object.keys(S.cfg.fields[j] || {}).filter(k => S.cfg.fields[j][k]);
        return a;
      }, {}),
      debug: !!S.cfg.debug
    };
  }

  /* Texto puro, para colar. Puro por desenho: recebe o objecto e devolve uma string, o que
     o torna testável sem browser nem DOM. */
  function textoDiagnostico(d) {
    if (!d || !d.ligacao) return 'Diagnóstico indisponível.';
    const L = [];
    L.push('Sessão 500 — HUD v' + d.versao + '  ·  diagnóstico');
    L.push('');
    L.push('ESTADO: ' + d.ligacao.codigo + ' — ' + d.ligacao.titulo);
    L.push('  ' + d.ligacao.detalhe);
    if (d.ligacao.acao) L.push('  O que fazer: ' + d.ligacao.acao);
    L.push('');
    L.push('página:     ' + d.url);
    L.push('jogo:       ' + (d.jogo || 'não reconhecido') + (d.passo ? '  ·  ronda do plano: ' + d.passo : ''));
    L.push('saldo:      ' + (d.saldo == null ? '—' : d.saldo) + '   (inicial: ' + (d.saldoInicial == null ? '—' : d.saldoInicial) + ')');
    L.push('leituras:   ' + d.leituras + '   ·   com valor diferente: ' + d.mudancas);
    L.push('rondas:     ' + d.rondas + '   ·   volume apostado: ' + d.volume.toFixed(2));
    L.push('pausas:     ' + d.pausas + (d.travado ? '   ·   TRAVADO AGORA' : ''));
    L.push('debug:      ' + (d.debug ? 'ligado' : 'desligado'));
    L.push('');
    L.push('CAMPOS ENSINADOS');
    Object.keys(d.camposEnsinados).forEach(j => {
      const ks = d.camposEnsinados[j];
      if (!ks.length) { L.push('  ' + j + ': nenhum'); return; }
      ks.forEach(k => {
        const c = d.campos[j][k];
        L.push('  ' + j + '.' + k + ': ' + (c.existe ? 'OK' : 'NÃO EXISTE') +
               (c.valor ? '  lê «' + c.valor + '»' : '') + '  [' + c.sel + ']');
      });
    });
    if (d.ultimas && d.ultimas.length) {
      L.push('');
      L.push('ÚLTIMAS LEITURAS (mais recente por último)');
      d.ultimas.forEach(l => L.push('  ' + (l.raw == null ? 'ilegível' : '«' + l.raw + '» → ' + l.v) + (l.mudou ? '  *' : '')));
      L.push('  (* = valor diferente da leitura anterior)');
    }
    return L.join('\n');
  }

  let fillSeq = 0;   // número de série do preenchimento, para as reverificações atrasadas

  function renderRec() {
    const el = $('rec');
    if (!el) return;
    const r = recommend();
    const f = (S.cfg.fields || {})[r.jogo] || {};
    const cor = r.ok === true ? '#3ddc97' : r.ok === false ? '#ff6b6b' : '#f5c451';
    const cab = r.meta
      ? r.meta.nome + '  ·  edge ' + (r.meta.edge * 100).toFixed(2) + '%  ·  ' + r.meta.tipo
      : (r.jogo ? 'jogo detectado: ' + r.jogo : 'nenhum jogo detectado');
    let h = '<div class="raw">' + cab + '</div>';
    h += '<div class="recT" style="color:' + cor + '">' + r.titulo + '</div>';
    if (r.ganho != null || r.perda != null) {
      h += '<div class="kv"><span>podes ganhar</span><b class="win">' + MONEY(r.ganho || 0) + '</b></div>';
      h += '<div class="kv"><span>podes perder</span><b class="lose">' + MONEY(r.perda || 0) + '</b></div>';
    }
    h += '<div class="raw" style="margin-top:8px">' +
         r.linhas.map(l => '· ' + l).join('<br>') + '</div>';
    h += '<button id="btnFill" class="w" style="margin-top:10px">Preencher a configuração no site</button>';
    /* Copia o caminho de um campo já ensinado: como o input da aposta é o mesmo para
       Dice e Mines, o caminho do stake costuma ser exactamente o que falta no
       multiplicador de um deles. Evita ter de reensinar à mão o que já se sabe. */
    const saida = Object.keys(f).filter(k => f[k]);
    if (saida.length) {
      h += '<div class="raw" style="margin-top:8px">Copiar caminho: ' +
           saida.map(k => '<button class="w copybtn" data-campo="' + k + '" ' +
             'style="margin:4px 4px 0 0;font-size:11px;padding:4px 8px">' + k + '</button>').join('') +
           '</div>';
    }
    el.innerHTML = h;

    $('btnFill').onclick = () => {
      /* Cada preenchimento leva um número de série: a reverificação atrasada de um clique
         antigo não pode escrever por cima do resultado de um clique novo. */
      const seq = ++fillSeq;
      const st = $('fillStatus');
      if (st) st.innerHTML = '';
      const out = preencherNoSite();
      const todosOk = out.resultados.length > 0 && out.resultados.every(x => x.ok);
      const naoEnsinados = out.resultados.filter(x => !x.ok && /ensinado/.test(x.motivo || '')).length;
      let msg, cls;
      if (todosOk) {
        cls = 'ok';
        msg = '✓ Configuração confirmada no site. <b>CONFERE NO ECRÃ</b> e carrega tu em Aposta — o clique é teu.';
      } else if (out.resultados.length && naoEnsinados === out.resultados.length) {
        cls = 'bad';
        msg = 'Nenhum campo ensinado ao HUD. Abre a configuração e ensina os campos (uma vez).';
      } else {
        cls = 'bad';
        msg = '⚠ ' + out.resultados.map(x => {
          const detalhe = x.motivo || ('ficou "' + x.depois + '" em vez de "' + x.pretendido + '"');
          const extra = (x.tag ? ' [' + x.tag + (x.framework ? ', ' + x.framework : '') + ']' : '');
          return x.campo + ': ' + detalhe + extra;
        }).join('<br>') + '<br><b>Escreve à mão antes de apostar.</b>';
      }

      /* Reverificação atrasada. Se o campo é controlado por React/Vue, o valor pode ser
         revertido DEPOIS de eu confirmar — e a confirmação imediata diria "está tudo bem".
         Este segundo olhar, 400 ms depois, é o que separa «o site aceitou» de «o site aceitou
         e depois desfez». Foi o que faltava para explicar um "os 0.3 ficaram mas deu erro". */
      verificarEscrita(out.resultados, 400, desfeitos => {
        const st = $('fillStatus');
        if (!st || seq !== fillSeq) return;
        if (!desfeitos.length) return;
        st.innerHTML += '<div class="flag bad" style="margin-top:6px">⚠ <b>O site desfez o valor que eu tinha escrito</b> em: ' +
          desfeitos.map(x => x.campo).join(', ') + '. Isto acontece com campos controlados por React/Vue. ' +
          'Escreve à mão — e carrega em «Inspecionar os campos» para ver o que é este campo.</div>';
        render();
      });
      S.deviations.push({ at: Date.now(), kind: 'preencher', ok: todosOk });
      $('fillStatus').innerHTML = '<div class="flag ' + cls + '" style="margin-top:8px">' + msg + '</div>';
    };

    el.querySelectorAll('.copybtn').forEach(b => {
      b.onclick = () => {
        const campo = b.getAttribute('data-campo');
        const caminho = (f || {})[campo] || '';
        const aviso = $('fillStatus');
        if (!navigator.clipboard) {
          if (aviso) aviso.innerHTML = '<div class="flag">' + caminho + '</div>';
          return;
        }
        navigator.clipboard.writeText(caminho).then(() => {
          if (aviso) aviso.innerHTML = '<div class="flag ok">✓ Copiado: <code>' + caminho + '</code></div>';
        }, () => {
          if (aviso) aviso.innerHTML = '<div class="flag">' + caminho + '</div>';
        });
      };
    });
  }

  /* ==================== 7.7 AVISO SOBRE O TABULEIRO ====================
     Aparece POR CIMA das minas e diz o que o plano pede: abrir mais uma casa ou parar a
     ronda. Nada mais. É conselho visível, não acção: o contentor tem pointer-events:none,
     não clica em nada, e as casas continuam a ser tu a abri-las.

     O QUE ESTE AVISO NÃO FAZ, E NÃO PODE FAZER: dizer em que casa está a mina, ou qual é a
     "melhor". Nas Mines, todas as casas tapadas têm EXACTAMENTE a mesma probabilidade. Não
     existe casa melhor: existe só abrir ou parar. Marcar uma casa com um X seria inventar
     uma informação que o jogo não tem — e seria o pior tipo de mentira, porque uma seta
     "recomendada" num tabuleiro faz as pessoas acreditarem nela.
     ==================================================================== */
  const CHAVE_AVISO = () => {
    const r = recommend();
    return [detectGame() || '-', r.titulo || '-', S.history.length, S.cfg.stake].join('|');
  };

  function renderAviso() {
    const el = $('aviso');
    if (!el) return;
    if (!S.cfg.overlay) { el.classList.remove('on'); return; }

    /* Em pausa, o aviso passa a ser o travão — e aí não há botões de decisão: a única
       acção disponível é esperar. */
    if (locked()) {
      const info = LOCK_TEXT[S.lockKind] || LOCK_TEXT.manual;
      el.className = 'aviso on pausa';
      el.innerHTML = '<div class="cx"><div class="tt" style="color:#f5c451">' + info.t + '</div>' +
        '<div class="ln">' + mmss((S.lockUntil - Date.now()) / 1000) + ' — não apostes até o contador chegar a zero.</div>' +
        '<div class="fim">Esta pausa custou-te $0.00 de edge. Foi a única coisa gratuita da sessão.</div></div>';
      posicionarAviso(el);
      return;
    }

    const r = recommend();
    if (!r.meta || r.ok === null || !detectGame()) { el.classList.remove('on'); return; }
    const chave = CHAVE_AVISO();
    const cor = r.ok === true ? '#3ddc97' : '#ff6b6b';

    /* Já reconheceste este aviso? Fica um selo discreto, em vez de insistir. Insistir é a
       forma mais rápida de alguém desligar o aviso de vez. */
    if (S.avisoAck === chave) {
      el.className = 'aviso on';
      el.innerHTML = '<div class="chip" style="color:' + cor + '">' + r.titulo + '</div>';
      posicionarAviso(el);
      return;
    }

    const linhas = [];
    if (r.jogo === 'mines') {
      const abrir = r.titulo.indexOf('ABRIR') === 0;
      linhas.push(abrir
        ? 'Todas as casas tapadas têm a MESMA probabilidade. Não existe casa melhor — abre a que quiseres.'
        : 'Atingiste o alvo do plano. Parar agora devolve o que está na mesa.');
      const util = r.linhas.filter(l => /RETIRAR agora|ABRIR mais 1:|Abriste|diferença|plano pede|paga na ENTRADA/.test(l));
      util.forEach(l => linhas.push(l));
    } else {
      r.linhas.slice(0, 3).forEach(l => linhas.push(l));
    }
    linhas.push('Decisão tua. Isto é um aviso, não um botão de apostar.');

    el.className = 'aviso on';
    el.innerHTML = '<div class="cx"><div class="tt" style="color:' + cor + '">' + r.titulo + '</div>' +
      '<div class="ln">' + linhas.join('<br>') + '</div>' +
      '<div><button id="avParar">Vou parar a ronda</button>' +
      '<button id="avSeguir">Vou abrir mais 1</button></div>' +
      '<div class="fim">Sim ou não? Registo a tua decisão e o aviso encolhe. Zero cliques no site.</div></div>';
    posicionarAviso(el);

    /* Estes botões NÃO tocam no site: registam a tua decisão e calam o aviso. */
    const decidir = (qual) => {
      S.decisions.push({ at: Date.now(), qual: qual, titulo: r.titulo, jogo: r.jogo,
                         rondas: S.history.length, saldo: S.balance });
      S.avisoAck = chave;
      saveCfg();
      render();
    };
    const bp = $('avParar'), bs = $('avSeguir');
    if (bp) bp.onclick = () => decidir('parar');
    if (bs) bs.onclick = () => decidir('abrir-mais');
  }

  /* Posiciona o aviso em cima do tabuleiro, quando o tabuleiro foi ensinado. Sem essa
     informação, fica no topo do ecrã — visível, mas sem fingir que sabe onde está o jogo. */
  function posicionarAviso(el) {
    const g = detectGame();
    const selBoard = g && S.cfg.fields && S.cfg.fields[g] ? S.cfg.fields[g].board : null;
    let alvo = null;
    if (selBoard) { try { alvo = document.querySelector(selBoard); } catch (e) { alvo = null; } }
    if (alvo && alvo.getBoundingClientRect) {
      const r = alvo.getBoundingClientRect();
      if (r.width > 100 && r.height > 60) {
        const larg = el.offsetWidth || 380;
        el.style.left = Math.max(8, Math.min(window.innerWidth - larg - 8, r.left + r.width / 2 - larg / 2)) + 'px';
        el.style.top = Math.max(8, r.top + 10) + 'px';
        el.style.transform = '';
        return;
      }
    }
    el.style.left = '50%';
    el.style.top = '14px';
    el.style.transform = 'translateX(-50%)';
  }

  function renderDiagnostico() {
    const caixa = $('diagCaixa'), banner = $('diagBanner');
    if (!caixa || !banner) return;
    const d = diagnostico();
    const lig = d.ligacao;

    /* Banner: só quando há problema. Um aviso permanente deixa de ser um aviso. */
    banner.innerHTML = lig.codigo === 'ligado' ? '' :
      '<div class="flag ' + lig.nivel + '"><b>' + lig.titulo + '</b><br>' + lig.detalhe +
      (lig.acao ? '<br><b>' + lig.acao + '</b>' : '') + '</div>';

    const linha = (k, v, cor) => '<div class="kv"><span>' + k + '</span><b class="raw"' +
      (cor ? ' style="color:' + cor + '"' : '') + '>' + v + '</b></div>';
    const h = [];
    h.push(linha('ligação ao saldo', lig.codigo === 'ligado' ? 'OK' : lig.codigo,
      lig.codigo === 'ligado' ? '#3ddc97' : (lig.codigo === 'saldo-zero' ? '#f5c451' : '#ff6b6b')));
    h.push(linha('jogo detectado', (d.jogo || 'nenhum') + (d.passo ? ' · ' + d.passo : '')));
    h.push(linha('leituras', d.leituras + ' feitas · ' + d.mudancas + ' com valor diferente'));
    h.push(linha('rondas detectadas', String(d.rondas)));
    h.push(linha('volume apostado', MONEY(d.volume)));
    const campos = [];
    Object.keys(d.campos).forEach(j => Object.keys(d.campos[j]).forEach(k => {
      const c = d.campos[j][k];
      campos.push(j + '.' + k + (c.existe ? ' ✓' : ' ✗'));
    }));
    h.push(linha('campos', campos.length ? campos.join(' · ') : 'nenhum ensinado'));
    h.push(linha('debug', d.debug ? 'ligado' : 'desligado'));
    caixa.innerHTML = h.join('');
  }

  function renderFields() {
    const f = S.cfg.fields || {};
    const txt = ['dice', 'mines'].map(g => {
      const o = f[g] || {};
      /* «à mão» é a marca que impede a mentira mais fácil deste painel: um campo que existe,
         que o HUD leu, e que ele NUNCA consegue escrever. Sem esta marca, o mapa parecia
         completo e o preenchimento automático parecia avariado. */
      const partes = Object.keys(o).filter(k => o[k])
        .map(k => k + (eManual(g + '.' + k, k) ? ' ✓ (à mão)' : ' ✓'));
      return g + ': ' + (partes.length ? partes.join(', ') : 'nenhum campo ensinado');
    }).join('   ·   ');
    const el = $('teachStatus');
    if (el) el.textContent = txt;
  }

  function render() {
    if (!root) return;
    renderRec();
    const bal = S.balance;
    const start = S.startBalance;
    const pnl = (bal != null && start != null) ? bal - start : null;

    $('bal').textContent = bal == null ? '—' : MONEY(bal);
    $('raw').textContent = S.cfg.sel
      ? ('selector: ' + S.cfg.sel + '  ·  lido: "' + S.cfg.rawLast + '"')
      : 'sem selector. Abre a configuração e clica em «Clicar no saldo no site».';

    if (pnl == null) { $('pnl').textContent = '—'; $('pnl').style.color = '#8b8798'; }
    else {
      /* Com saldo inicial 0 (conta vazia), a percentagem era 0/0 = NaN e o painel escrevia
         «NaN%». A percentagem só existe se houver um inicial com que comparar. */
      const temBase = start > 0;
      $('pnl').textContent = (pnl >= 0 ? '+' : '') + MONEY(pnl) + (temBase ? '  (' + (pnl / start * 100).toFixed(1) + '%)' : '  (sem saldo inicial para comparar)');
      $('pnl').style.color = pnl > 0.0001 ? '#3ddc97' : pnl < -0.0001 ? '#ff6b6b' : '#e8e6f0';
    }

    const vol = S.history.reduce((a, h) => a + (h.result === 'external' ? 0 : h.stake), 0);
    const budget = S.cfg.budget / S.cfg.edge;
    const pct = Math.min(1, vol / budget);
    $('volTxt').textContent = 'apostado ' + MONEY(vol);
    $('volPct').textContent = (pct * 100).toFixed(0) + '% de ' + MONEY(budget);
    $('volBar').className = 'bar' + (pct > .85 ? ' b' : pct > .6 ? ' w' : '');
    $('volBar').firstElementChild.style.width = (pct * 100) + '%';
    $('edgeTxt').textContent = 'edge já pago ao casino: ' + MONEY(vol * S.cfg.edge);

    $('brTime').textContent = mmss(S.breaks.reduce((a, b) => a + b.secs, 0));
    $('brStreak').textContent = S.lossStreak + ' / ' + S.cfg.guard.lossStreak;
    $('brStreak').style.color = S.lossStreak >= S.cfg.guard.lossStreak - 1 ? '#ff6b6b' : '#e8e6f0';
    $('brSince').textContent = roundsSinceBreak() + ' / ' + S.cfg.guard.microEvery;
    $('brImp').textContent = S.impulses.length;

    const rows = S.history.slice(-25).reverse().map(h => {
      const cls = h.result === 'win' ? 'win' : h.result === 'lose' ? 'lose' : 'other';
      const sign = h.delta >= 0 ? '+' : '';
      return '<tr><td>' + h.i + '</td><td>' + h.game + '</td><td class="' + cls + '">' +
             h.result + (h.note ? '<br><span class="other" style="font-size:10.5px">' + h.note + '</span>' : '') +
             '</td><td class="' + cls + '">' + sign + h.delta.toFixed(2) + '</td></tr>';
    }).join('');
    $('log').innerHTML = rows
      ? '<table>' + rows + '</table>'
      : '<span class="raw">à espera de variações de saldo…</span>';

    const al = [];
    /* Primeiro de tudo: sem saldo não se joga, e o painel não deve fingir que está tudo
       bem. Era o que fazia antes — «Dentro dos limites» com $0.00 no ecrã. */
    const lig = estadoDaLigacao();
    if (lig.codigo !== 'ligado') al.push([lig.nivel, lig.titulo + (lig.acao ? '  →  ' + lig.acao : '')]);
    else if (bal != null && S.cfg.stake > 0 && bal < S.cfg.stake) {
      al.push(['warn', 'O saldo (' + MONEY(bal) + ') é menor que o stake (' + MONEY(S.cfg.stake) + '). A sessão acabou — por desenho, não por azar.']);
    }
    if (pct >= 1) al.push(['bad', 'Orçamento de volume esgotado. Regra: parar.']);
    else if (pct > .85) al.push(['', 'A ' + ((1 - pct) * 100).toFixed(0) + '% do fim do orçamento.']);
    /* O número que o HUD não escreve, mas tem de DIZER. Um campo onde o site não deixa
       escrever não é um campo esquecido: é uma instrução para ti. Se o painel ficasse calado,
       o plano parecia cumprido quando a ronda ia sair com o número de minas errado. */
    const stAgora = currentStep();
    if (stAgora && stAgora.game === 'Mines' && eManual('mines.mines', 'mines')) {
      al.push(['warn', 'ESCOLHE ' + stAgora.mines + ' MINAS no seletor do site — esse controlo é do '
        + 'site e o HUD não lhe toca (o clique continua a ser teu).']);
    }
    if (S.locked) al.push(['bad', 'EM PAUSA. Não apostes até o contador chegar a zero.']);
    if (unknownQueue.length) al.push(['', unknownQueue.length + ' variação(ões) que o HUD não soube classificar. Vê o log e corrige.']);
    if (!al.length) al.push(['ok', 'Dentro dos limites. Ronda ' + (S.cursor + 1) + ' do plano: ' +
      (currentStep() ? currentStep().label : '—') + ' a ' + MONEY(S.cfg.stake)]);
    $('alerts').innerHTML = al.map(([k, t]) => '<div class="flag ' + k + '">' + t + '</div>').join('');

    if (locked()) {
      const info = LOCK_TEXT[S.lockKind] || LOCK_TEXT.manual;
      $('obox').innerHTML =
        '<h3>' + info.t + '</h3><div class="raw">' + (S.lockWhy || '') + '</div>' +
        '<div class="ot">' + mmss((S.lockUntil - Date.now()) / 1000) + '</div>' +
        '<ul>' + info.steps.map(s => '<li>' + s + '</li>').join('') + '</ul>' +
        '<div class="raw" style="margin-top:14px">' + (S.lockFoot ||
          'Esta pausa custou-te $0.00 de edge. Foi a única coisa gratuita da sessão.') + '</div>' +
        '<div class="row" style="margin-top:16px">' +
        '<button id="oExt">+2 min</button><button id="oStop">Terminar sessão aqui</button></div>';
      $('overlay').classList.add('on');
      $('oExt').onclick = () => { if (locked()) S.lockUntil = Math.max(S.lockUntil, Date.now()) + 120000; render(); };
      $('oStop').onclick = () => {
        if (locked()) S.breaks.push({ kind: S.lockKind, secs: (Date.now() - S.lockStart) / 1000, afterRound: S.history.length, at: Date.now() });
        S.lockKind = null; S.lockUntil = 0; S.ended = true; render();
      };
    } else {
      $('overlay').classList.remove('on');
    }

    renderFields();
    renderDiagnostico();
    renderAviso();
    $('hud').className = S.cfg.collapsed ? 'hud min' : 'hud';
    $('tab').className = S.cfg.collapsed ? 'tab' : 'tab hide';
  }

  const LOCK_TEXT = {
    micro: { t: 'micro-pausa', steps: ['Levanta-te e sai da cadeira.', 'Bebe um copo de água inteiro.',
      'Olha para algo a mais de 6 metros durante 20 segundos.', 'Não abrir o chat nesta pausa.'] },
    streak: { t: 'cooldown por sequência de derrotas', steps: ['Não toques no site durante esta pausa.',
      'O gatilho foi ' + 'uma sequência de derrotas — não é uma oportunidade.',
      'Relê o volume gasto abaixo: é esse o custo real, não a sequência.',
      'Só decides continuar depois de o contador chegar a zero.'] },
    win: { t: 'cooldown por ganho grande', steps: ['Saca metade do que ganhaste. Agora.',
      'A próxima aposta continua com o stake fixo. Sem excepção.',
      'Um ganho grande não muda a matemática — só a tua vontade de subir o stake.',
      'Ouve o plano antes de voltar.'] },
    manual: { t: 'pausa voluntária', steps: ['Boa. Pediste uma pausa sem ninguém obrigar.',
      'Respira fundo três vezes, devagar.', 'Confirma orçamento e tempo.',
      'Decide conscientemente se continuas.'] },
    impulse: { t: 'impulso registado, não seguido', steps: ['Boa. Registaste em vez de cederes.',
      'Não vás ao site durante estes 2 minutos.', 'O impulso é sinal de cansaço ou sequência, não de oportunidade.',
      'Zero impulsos registados viraram aposta.'] },
    escudo: { t: 'ronda do plano confirmada', steps: ['Vai ao site e usa o stake e o jogo indicados abaixo.',
      'Não aumentes o stake. Não mudes de jogo.', 'Se sentires vontade de desviar, carrega em impulso primeiro.',
      'O HUD detecta o resultado sozinho pela variação do saldo.'] }
  };

  /* ============================ 9. LIGAR TUDO ============================ */
  /* A montagem da UI esta isolada num try/catch de propósito: se a pagina do casino mudar
     e a interface nao conseguir montar, a LOGICA (leitura, deteccao, travões) tem de
     continuar viva e testavel, em vez de o script inteiro morrer em silencio. */

  /* A captura guiada nasce dentro desse try — é lá que existem os botões e o painel dela — mas
     a consola e os testes têm de a alcançar de fora, e em strict mode as funções declaradas
     dentro de um bloco têm âmbito desse bloco. Esta é a ponte, preenchida no fim da secção da
     captura. (A estratégia nunca esteve dentro do try: se a interface falhar a montar, o HUD
     continua a ler o saldo e a classificar rondas.) */
  const CAPTURA = {};

  /* Quais dos campos escritos o site DESFEZ. A confirmação imediata diz «o site aceitou»; esta
     segunda leitura, 400 ms depois, responde à pergunta seguinte: «e manteve?». Um campo
     controlado por React/Vue reverte o valor depois de eu já ter dito que estava bem — e é essa
     a diferença entre um mapa que funciona e um mapa que parece funcionar.
     Vive fora do try (é lógica, não interface) para os testes a poderem exercitar, e é a MESMA
     função usada pelo botão de preencher e pelo teste do mapa: duas verdades sobre o mesmo
     assunto divergem sempre. */
  function camposDesfeitos(resultados) {
    return (resultados || []).filter(x => x && x.ok && x.sel).filter(x => {
      let el = null;
      try { el = document.querySelector(x.sel); } catch (e) { return false; }
      if (!el) return true;
      const v = parseMoney(el.value != null && el.value !== '' ? el.value : el.textContent);
      const w = parseMoney(x.pretendido);
      return !(v != null && w != null && Math.abs(v - w) < 1e-9);
    });
  }

  function verificarEscrita(resultados, atraso, cb) {
    return setTimeout(() => { try { cb(camposDesfeitos(resultados)); } catch (e) {} },
                      atraso == null ? 400 : atraso);
  }

  try {
  root = buildUI();

  $('tab').onclick = () => { S.cfg.collapsed = false; saveCfg(); render(); };
  $('btnShield').onclick = () => {
    const st = currentStep();
    openLock('escudo', 20, 'Ronda ' + (S.cursor + 1) + ' do plano.',
      'Stake <b>' + MONEY(S.cfg.stake) + '</b> em <b>' + (st ? st.label : '—') + '</b>. Executa tu, no site.');
  };
  $('btnImpulse').onclick = () => {
    S.impulses.push({ at: Date.now(), balance: S.balance, rounds: S.history.length, lossStreak: S.lossStreak });
    const plan = S.cfg.stake;
    const foot = 'Subir de ' + MONEY(plan) + ' para $0.80 encurta a tua sessão mediana para cerca de um quarto. ' +
                 'Registaste o impulso após ' + S.lossStreak + ' derrotas seguidas — o gatilho clássico.';
    openLock('impulse', 120, 'Registaste o impulso em vez de o seguires.', foot);
  };
  $('btnGate').onclick = () => {
    if (!confirm('O gate de 60 segundos existe para te obrigar a esperar antes de mudar o stake.\n\n' +
      'A tua configuração actual: stake ' + MONEY(S.cfg.stake) + '.\n\n' +
      'Se alterares, fica registado como desvio deliberado.\n\nQueres abrir a configuração?')) return;
    S.deviations.push({ at: Date.now(), kind: 'abriu-gate', stake: S.cfg.stake });
    S.cfg.collapsed = false;
    const d = root.querySelector('details');
    if (d) { d.open = true; }
    render();
  };
  $('btnSave').onclick = () => {
    S.cfg.sel = $('sel').value.trim() || null;
    S.cfg.stake = Math.max(0.01, parseFloat($('stake').value) || S.cfg.stake);
    S.cfg.budget = Math.max(0.5, parseFloat($('budget').value) || S.cfg.budget);
    S.cfg.edge = Math.max(0.0001, (parseFloat($('edge').value) || 1) / 100);
    S.cfg.autoDetect = $('auto').value === '1';
    S.cfg.rotation = $('rot').value.split('\n').map(x => x.trim()).filter(Boolean);
    saveCfg(); render();
  };
  $('btnReset').onclick = () => {
    if (!confirm('Nova sessão? O log actual perde-se.')) return;
    S.history = []; S.breaks = []; S.impulses = []; S.cursor = 0;
    S.startBalance = S.balance; S.lossStreak = 0; S.ended = false; unknownQueue = [];
    S.lastSeen = S.balance; render();
  };
  $('btnLer').onclick = () => {
    const out = $('diagOut');
    const b = readBalance();
    registarLeitura(b == null ? null : S.cfg.rawLast, b);
    if (b == null) { S.syncErr = S.cfg.sel ? 'selector sem correspondência' : 'sem selector'; }
    else { S.syncErr = null; onBalance(b); }
    const lig = estadoDaLigacao();
    out.innerHTML = '<div class="flag ' + lig.nivel + '">' + lig.titulo + ' — string lida: <b>«' +
      String(S.cfg.rawLast || 'nada').slice(0, 40) + '»</b></div>';
    render();
  };
  $('btnCopiarDiag').onclick = () => {
    const texto = textoDiagnostico(diagnostico());
    const out = $('diagOut');
    const mostrar = () => { out.innerHTML = '<div class="raw">Cola isto onde quiseres (ou ' +
      'mostra-me):<br><pre style="white-space:pre-wrap;font-size:11px">' + texto.replace(/[<>&]/g, '') + '</pre></div>'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(() => {
        out.innerHTML = '<div class="flag ok">✓ Diagnóstico copiado (' + texto.split('\n').length + ' linhas).</div>';
      }, mostrar);
    } else mostrar();
  };
  /* Inspecção: em vez de tentar adivinhar porque é que um campo "não pegou", ler o DOM e
     dizer o que ele é — tag, tipo, role, se é escrevível, e se é controlado por framework.
     É a diferença entre "não funcionou" e "é um <div role=slider> e nenhum script o muda". */
  $('btnInsp').onclick = () => {
    const g = detectGame();
    const itens = g ? inspecionarCampos() : [];
    const out = $('inspOut');
    if (!g) {
      out.innerHTML = '<div class="flag">Abre a página do Dice ou das Minas: os campos são de cada jogo.</div>';
      return;
    }
    if (!itens.length) {
      out.innerHTML = '<div class="flag">Nenhum campo ensinado para ' + g + '. Usa a procura automática ou o apontador.</div>';
      return;
    }
    out.innerHTML = itens.map(i => {
      const cor = i.estado !== 'existe' ? '#ff6b6b' : (i.escrevivel ? '#3ddc97' : '#f5c451');
      return '<div class="kv"><span>' + i.campo + '</span><b class="raw">' + i.estado +
        (i.tag ? ' · ' + i.tag : '') + (i.role ? ' · role=' + i.role : '') + '</b></div>' +
        (i.estado === 'existe' ? '<div class="raw" style="color:' + cor + ';padding-left:8px">' +
          'lê «' + (i.leitura || '') + '» · ' +
          (i.escrevivel ? 'escrevível' : 'NÃO escrevível: controlo do site') +
          (i.framework ? ' · controlado por ' + i.framework : ' · sem framework detectado') +
          (i.readOnly ? ' · readOnly' : '') + (i.disabled ? ' · disabled' : '') + '</div>' : '') +
        (i.motivo ? '<div class="raw" style="padding-left:8px">' + i.motivo + '</div>' : '');
    }).join('');
  };
  $('btnInspCopiar').onclick = () => {
    const texto = textoInspecao(inspecionarCampos(), detectGame() || '?');
    const out = $('inspOut');
    const mostrar = () => { out.innerHTML = '<pre style="white-space:pre-wrap;font-size:11px">' +
      texto.replace(/[<>&]/g, '') + '</pre>'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(() => {
        out.innerHTML = '<div class="flag ok">✓ Inspecção copiada. Cola isto onde quiseres.</div>';
      }, mostrar);
    } else mostrar();
  };

  $('overlay').onchange = () => {
    S.cfg.overlay = $('overlay').value === '1';
    if (!S.cfg.overlay) S.avisoAck = null;   // ao religar, volta a avisar
    saveCfg(); render();
  };
  $('autoFill').onchange = () => {
    S.cfg.autoFill = $('autoFill').value === '1';
    S.autoFeito = null;                      // a próxima ronda configura-se já
    saveCfg(); render();
  };
  $('debug').onchange = () => {
    S.cfg.debug = $('debug').value === '1';
    saveCfg();
    if (S.cfg.debug) console.log('[Sessão 500] debug ligado — cada mudança de saldo aparece aqui.');
    render();
  };

  $('btnCapturar').onclick = () => { iniciarCaptura(); render(); };
  $('btnTestarMapa').onclick = () => {
    const out = $('capOut');
    const r = testarMapa(comDesfeitos => {
      const o2 = $('capOut');
      if (o2) o2.innerHTML = '<div class="flag ' + (comDesfeitos.desfeitos.length || comDesfeitos.campos.some(c => !c.ok) ? 'bad' : 'ok') + '">' +
        linhasDoTeste(comDesfeitos) + '</div>';
    });
    if (out) out.innerHTML = '<div class="flag">' + linhasDoTeste(r) + '</div>';
    render();
  };
  $('btnPick').onclick = () => startPicker(null);
  $('btnTeach').onclick = () => {
    const alvo = $('teachWhich').value;
    if (!alvo) return;
    startPicker(alvo);
  };

  /* Descoberta automática: mostra o que encontrou, com o texto cru que leu, e um botão
     por proposta. NÃO adopta nada sozinho — a decisão fica a um clique de distância, e
     o clique é teu. A segunda busca classifica melhor do que a primeira, porque já
     conseguiu observar um segundo de movimento do saldo. */
  $('btnAuto').onclick = () => {
    const saida = $('autoOut');
    const saldos = procurarSaldo();
    const campos = procurarCampos();
    /* O estado vai para uma linha própria, e não para o sítio da lista: a primeira versão
       substituía a lista inteira ao usar UMA proposta, o que obrigava a procurar outra vez
       a cada campo — quatro procuras para configurar quatro coisas. A lista fica. */
    const linhas = ['<div id="autoStatus"></div>'];

    if (!saldos.length) {
      linhas.push('<div class="flag">Não encontrei nenhum candidato a saldo visível. ' +
        'Confirma que estás com a sessão iniciada e usa o apontador abaixo.</div>');
    } else {
      linhas.push('<div class="raw">SALDO — candidatos, do melhor para o pior:</div>');
      saldos.forEach((c, i) => {
        linhas.push('<div class="kv"><span>' + (i === 0 ? '★ ' : '· ') + 'pontos ' + c.pontos +
          '  ·  lê: <b class="raw">"' + String(c.texto).replace(/[<>&]/g, '') + '"</b></span>' +
          '<button class="w autoUsar" data-tipo="saldo" data-sel="' + c.sel + '" ' +
          'style="font-size:11px;padding:4px 8px">usar</button></div>');
      });
      if (saldos.length > 1) {
        linhas.push('<div class="raw">Vê os três e escolhe o que <b>parece mesmo</b> o teu saldo — ' +
          'é por isso que não escolho eu.</div>');
      }
    }

    const nomes = { stake: 'valor da aposta', mult: 'multiplicador', mines: 'nº de minas' };
    const achados = Object.keys(campos);
    if (!achados.length) {
      linhas.push('<div class="raw" style="margin-top:8px">Nenhum campo de aposta encontrado nesta página. ' +
        'Se estiveres no Dice ou nas Minas, ensina à mão com o apontador — demora 3 cliques e é uma vez.</div>');
    } else {
      const g = detectGame();
      linhas.push('<div class="raw" style="margin-top:8px">CAMPOS nesta página (' + (g || 'jogo não reconhecido') +
        ') — o valor da aposta é o mesmo no Dice e nas Minas:</div>');
      achados.forEach(papel => {
        const c = campos[papel];
        linhas.push('<div class="kv"><span>' + (nomes[papel] || papel) + '  ·  pontos ' + c.pontos +
          '  ·  está em: <b class="raw">"' + String(c.valor).replace(/[<>&]/g, '') + '"</b></span>' +
          '<button class="w autoUsar" data-tipo="campo" data-papel="' + papel + '" data-sel="' + c.sel + '" ' +
          'style="font-size:11px;padding:4px 8px">usar</button></div>');
      });
      linhas.push('<div class="raw">Só os campos de CONFIGURAÇÃO. O HUD nunca liga nenhum botão de apostar.</div>');
    }
    saida.innerHTML = linhas.join('');

    saida.querySelectorAll('.autoUsar').forEach(b => {
      b.onclick = () => {
        const sel = b.getAttribute('data-sel');
        const st = $('autoStatus');
        const dizer = (classe, txt) => { if (st) st.innerHTML = '<div class="flag ' + classe + '">' + txt + '</div>'; };
        const usado = (texto) => { b.disabled = true; b.textContent = texto; b.style.opacity = '.55'; };
        if (b.getAttribute('data-tipo') === 'saldo') {
          S.cfg.sel = sel;
          $('sel').value = sel || '';
          saveCfg();
          const v = readBalance();
          usado(v == null ? 'não deu' : '✓ usado');
          dizer(v == null ? 'bad' : 'ok', v == null
            ? 'Guardei o selector, mas não consigo ler um número nele. Tenta outro candidato.'
            : '✓ Saldo ligado: lê <b>' + MONEY(v) + '</b>. Confere no site se é mesmo esse valor.');
        } else {
          const papel = b.getAttribute('data-papel');
          const jogo = detectGame();
          /* O valor da aposta é o mesmo em todos os jogos; o multiplicador e o nº de minas
             são de cada jogo. Sem saber em que jogo estou, guardar aqui seria adivinhar — e
             adivinhar mal atribuiria o multiplicador do Keno ao Dice. */
          if (papel !== 'stake' && !jogo) {
            dizer('warn', 'Abre a página do Dice ou das Minas e volta a procurar: o multiplicador e o ' +
              'nº de minas são específicos do jogo, e eu não sei em que jogo estás.');
            return;
          }
          const destino = papel === 'stake' ? 'stake' : (jogo + '.' + (papel === 'mines' ? 'mines' : 'mult'));
          const onde = teachField(destino, sel);
          const podeEscrever = papel === 'mult' ? ' (é um valor de leitura — o HUD lê-o, não o escreve)' : '';
          usado('✓ usado');
          dizer('ok', '✓ ' + onde + podeEscrever);
        }
        render();
      };
    });
  };

  /* ==================== 9.3 CAPTURA GUIADA ====================
     O apanhador de um clique serve para UMA coisa. Configurar um jogo são quatro, e obrigar-te
     a reabrir o apanhador quatro vezes é desenhar a ferramenta à volta do seu próprio código em
     vez de à volta de quem a usa. Aqui entra-se uma vez e clica-se por ordem:
     saldo → valor da aposta → nº de minas → tabuleiro (os últimos são opcionais).

     Duas coisas que este modo NÃO faz, e é de propósito:
       - não decide sozinho o que é um campo bom. Cada elemento clicado é VALIDADO contra o papel
         que estava a ser pedido, e um clique no sítio errado é recusado COM O MOTIVO. Uma captura
         que aceita tudo treina-te a confiar numa configuração que pode estar errada;
       - não faz nada além de guardar selectores. O clique é apanhado em FASE DE CAPTURA e a
         propagação é interrompida, para que nada no casino seja accionado por engano (nem uma
         casa das minas, nem um botão de apostar).

     A ordem da fila é a ordem em que os problemas aparecem: o saldo alimenta tudo, e sem ele as
     recomendações nem sequer existem.
     ============================================================ */

  /* Uma linha de texto legível, para caber num painel sem rebentar o layout. */
  function cortar(s, n) {
    s = String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* O que se lê de um elemento, seja ele campo de escrita, seletor ou texto simples. Um saldo
     tanto pode viver num <div> como num <input readonly>: a leitura tem de servir para os dois. */
  function textoDoAlvo(el) {
    if (!el) return '';
    const t = el.tagName;
    if (t === 'SELECT') return textoDoCampo(el);
    if (t === 'INPUT' || t === 'TEXTAREA') return (el.value != null && el.value !== '') ? el.value : (el.textContent || '');
    return (el.textContent || '').trim();
  }

  function tagDo(el) {
    if (!el) return '?';
    const t = el.tagName || '?';
    if (t === 'SELECT') return 'SELECT[seletor]';
    return t + (el.type ? '[' + String(el.type).toLowerCase() + ']' : '');
  }

  /* Escrevível PARA CONFIGURAÇÃO. É mais estreito do que «existe»: um <span> com o valor lido
     não é configurável, e um <select> é — é exactamente isso que as minas são. */
  function escrevivelParaConfig(el) {
    if (!el) return false;
    const t = el.tagName;
    if (t === 'SELECT' || t === 'TEXTAREA') return true;
    if (t === 'INPUT') return !/^(checkbox|radio|submit|button|file|image|reset)$/i.test(el.type || '');
    return el.isContentEditable === true;
  }

  /* ============ 9.2.1 O CAMPO DE VERDADE ATRÁS DE UM CONTROLO DESENHADO PELO SITE ============
     O caso real: no 500, o número de minas (1 a 24) não é um <select> nativo — é uma caixa
     desenhada, com uma lista que abre. Quem clica nela e a tenta capturar era recusado, com
     razão (escrever `.value` numa <div> não muda nada) — mas era um BECO SEM SAÍDA.

     Então procura-se primeiro o campo de verdade atrás do que foi clicado: muitos casinos
     escondem um <input> ou um <select> nativo dentro do componente (é o que serve o teclado e
     o telemóvel). Se ele existir, guarda-se ESSE e a escrita volta a funcionar pelo caminho
     normal, sem um único clique. Se não existir, o HUD admite-o e passa a DIZER o número.

     A procura é LIMITADA de propósito — 4 níveis acima e os irmãos imediatos, nunca a página
     inteira. Isto é desenho, não preguiça: um selector apanhado numa travessia global muda de
     significado quando o site muda, e um campo que o HUD julga conhecer mas não conhece é pior
     do que um campo por ensinar. */
  /* Que nós olhar, e a que distância, a partir do que foi clicado. `dist` manda na pontuação:
     um campo ao lado do que clicaste é o campo; um campo a quatro níveis é um palpite. */
  function vizinhancaDe(el) {
    const out = [];
    const vistos = [];
    const juntar = (no, onde, dist) => {
      if (!no || no.nodeType !== 1) return;
      if (no === document.body || no === document.documentElement) return;   // a página inteira, nunca
      if (nossoNo(no)) return;                                               // o HUD, nunca
      if (vistos.indexOf(no) !== -1) return;
      vistos.push(no);
      out.push({ no: no, onde: onde, dist: dist });
    };
    let cur = el, nivel = 0;
    while (cur && nivel <= 4) {
      juntar(cur, nivel === 0 ? 'dentro do que clicaste'
                              : (nivel === 1 ? 'no pai' : 'no pai ' + nivel + ' níveis acima'), nivel);
      /* Os irmãos só nos dois primeiros níveis: mais acima, «ao lado» deixa de ser vizinhança
         e passa a ser a página. */
      const pai = cur.parentElement;
      if (nivel <= 1 && pai && pai.children) {
        Array.prototype.slice.call(pai.children).forEach(s => {
          if (s !== cur) juntar(s, nivel === 0 ? 'ao lado' : 'no pai, ao lado', nivel + 0.5);
        });
      }
      cur = pai;
      nivel++;
    }
    return out;
  }

  const ORCAMENTO_DA_PROCURA = 80;   // nº máximo de nós olhados antes de desistir
  function procurarCampoReal(el) {
    if (!el || el.nodeType !== 1) return null;
    const vizinhos = vizinhancaDe(el);
    const achados = [];
    let olhados = 0;
    for (let i = 0; i < vizinhos.length; i++) {
      if (olhados >= ORCAMENTO_DA_PROCURA) break;
      const v = vizinhos[i];
      const candidatos = [v.no];
      try {
        if (v.no.querySelectorAll) Array.prototype.push.apply(candidatos,
          Array.prototype.slice.call(v.no.querySelectorAll('input, select, textarea')));
      } catch (e) { /* nó exótico: não vale a pena insistir */ }
      for (let j = 0; j < candidatos.length; j++) {
        const c = candidatos[j];
        olhados++;
        if (c === el || nossoNo(c)) continue;
        if (c.disabled === true) continue;
        if (!escrevivelParaConfig(c)) continue;
        if (achados.some(a => a.el === c)) continue;
        achados.push({ el: c, onde: v.onde, dist: v.dist });
      }
    }
    if (!achados.length) return null;
    /* Um <select> com opções vale mais do que um <input> vazio — mas a PROXIMIDADE vale mais
       do que os dois: é ela que impede ir buscar um campo de pesquisa qualquer da página. */
    const pontos = a => {
      let p = 1000 - a.dist * 100;
      const t = a.el.tagName;
      if (t === 'SELECT') p += (a.el.options && a.el.options.length >= 2) ? 60 : 20;
      else if (t === 'INPUT') p += 40;
      else if (t === 'TEXTAREA') p += 10;
      return p;
    };
    achados.sort((a, b) => pontos(b) - pontos(a));
    return achados[0];
  }

  /* Um controlo DESENHADO pelo site (a caixa que abre). Não se escreve por código, mas
     RECONHECE-SE — e reconhecê-lo é o que permite parar de recusar o clique e passar a dizer
     o número. Sem este ramo, o HUD respondia «não» a um controlo que usas em todas as rondas. */
  function pareceControloDoSite(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'BUTTON') return true;
    const g = k => (el.getAttribute ? (el.getAttribute(k) || '') : '');
    if (/combobox|listbox|menuitem|slider|spinbutton|button|textbox/i.test(g('role'))) return true;
    if (g('aria-haspopup') || g('aria-expanded')) return true;
    const c = el.className;
    if (typeof c === 'string' && /select|dropdown|caret|chevron|picker|combo|stepper/i.test(c)) return true;
    /* Um número pequeno escrito lá dentro, num nó com quase nada dentro, já diz o que isto é. */
    const n = parseMoney(textoDoAlvo(el));
    const dentro = el.childElementCount != null ? el.childElementCount : (el.children ? el.children.length : 0);
    return n != null && dentro <= 4;
  }

  /* Uma OPÇÃO da lista (as casas «1..24» que aparecem quando a caixa abre) é o alvo ERRADO:
     quando escolhes, a lista fecha e o caminho deixa de existir. Guardá-lo era dar-te um mapa
     que funciona uma vez e depois aponta para o vazio — o pior tipo de mapa, porque parece que
     estava aprendido. O alvo certo é a CAIXA que abre a lista. */
  function ehOpcaoDeLista(el) {
    if (!el || el.nodeType !== 1) return false;
    const attr = (n, k) => (n && n.getAttribute ? (n.getAttribute(k) || '') : '');
    if (/^(option|menuitem|menuitemradio|treeitem)$/i.test(attr(el, 'role'))) return true;
    const pai = el.parentElement;
    return /listbox|menu|radiogroup|tree/i.test(attr(pai, 'role')) &&
           !!(pai && pai.children && pai.children.length >= 2);
  }

  /* A caixa que ABRE a lista, procurada a partir de uma opção lá dentro. Procura-se no pai e dois
     níveis acima, que é onde os componentes a põem — nunca na página inteira. */
  function acharTriggerDaLista(el) {
    let cur = el;
    for (let i = 0; i < 4 && cur; i++) {
      const pai = cur.parentElement;
      if (!pai) break;
      let cands = [];
      try {
        cands = Array.prototype.slice.call(pai.querySelectorAll(
          '[aria-haspopup],[aria-expanded],[role=combobox],[role=button],button'));
      } catch (e) { cands = []; }
      /* O próprio pai também conta: muitos componentes põem o aria-expanded na caixa que contém
         a lista, e não num irmão dela. */
      [pai].concat(Array.prototype.slice.call(pai.children || [])).forEach(c => {
        if (!c || !c.getAttribute) return;
        if (c.getAttribute('aria-haspopup') != null || c.getAttribute('aria-expanded') != null ||
            /combobox/i.test(c.getAttribute('role') || '')) cands.push(c);
      });
      for (const c of cands) {
        if (!c || c === el || nossoNo(c)) continue;
        if (c.contains && c.contains(el)) continue;                    // é a lista onde clicaste
        const r = (c.getAttribute && c.getAttribute('role')) || '';
        if (/option|listbox|menu$|menuitem/i.test(r)) continue;
        return c;
      }
      cur = pai;
    }
    return null;
  }

  /* O que este nó é, numa linha. Existe para o motivo de uma recusa ser COPIÁVEL: saber que
     elemento estava debaixo do rato vale mais do que «não deu». */
  function resumoDoNo(el) {
    if (!el) return 'nada';
    const c = el.className;
    const cls = (typeof c === 'string' && c.trim()) ? '.' + c.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const id = el.id ? '#' + el.id : '';
    const papel = (el.getAttribute && el.getAttribute('role')) ? '[role=' + el.getAttribute('role') + ']' : '';
    let caixas = 0;
    try { caixas = el.querySelectorAll ? el.querySelectorAll('input, select, textarea').length : 0; } catch (e) { caixas = 0; }
    return tagDo(el) + id + cls + papel + (caixas ? ' · ' + caixas + ' campo(s) lá dentro' : ' · sem campos lá dentro');
  }

  function papelTabuleiro(jogo) {
    return {
      etiqueta: 'o TABULEIRO (' + jogo + ')',
      curto: 'o tabuleiro (a área com todas as casas)',
      dica: 'a área das casas — só serve para o meu aviso pousar por cima dela',
      obrigatorio: false,
      validar: el => {
        const n = el.childElementCount != null ? el.childElementCount
                                               : (el.children ? el.children.length : 0);
        if (n < 6) return { ok: false, motivo: 'isto parece ser uma casa só (' + n +
          ' elemento(s) lá dentro) e não o tabuleiro todo. Clica num espaço vazio da grelha — a área que contém todas as casas.' };
        return { ok: true, leitura: n + ' elementos', nota: 'o aviso passa a pousar aqui' };
      }
    };
  }

  /* Cada papel sabe dizer, sozinho, o que recusa e porquê. É esta a diferença entre uma captura
     que funciona e uma captura que guarda o que lhe apetece. */
  const PAPEIS = {
    saldo: {
      etiqueta: 'o número do teu SALDO',
      curto: 'o teu saldo',
      dica: 'o dinheiro que tens — ex.: «5 805,80 USD». Clica no NÚMERO, não no cartão inteiro.',
      obrigatorio: true,
      validar: el => {
        const bruto = textoDoAlvo(el);
        const v = parseMoney(bruto);
        if (v == null) return { ok: false, motivo: 'não há nenhum número que eu saiba ler aqui dentro (li «' +
          cortar(bruto, 46) + '»).' };
        return { ok: true, leitura: cortar(bruto, 46), nota: 'vou lê-lo como ' + MONEY(v) };
      }
    },
    stake: {
      etiqueta: 'o CAMPO DO VALOR da aposta',
      curto: 'o campo do valor',
      dica: 'onde se escreve quanto se aposta — o mesmo serve para o Dice e para as Mines',
      obrigatorio: true,
      validar: el => {
        if (el.tagName === 'SELECT') return { ok: false, motivo: 'isto é uma lista de escolha, não o campo do valor. O valor da aposta é onde se ESCREVE o número.' };
        if (!escrevivelParaConfig(el)) return { ok: false, motivo: 'isto é ' + tagDo(el) +
          ' e não é um campo onde se escreva. Se for o valor mostrado a quem só lê, não serve para preencher a ronda.' };
        return { ok: true, leitura: cortar(textoDoAlvo(el), 18) || '(vazio)' };
      }
    },
    'dice.mult': {
      etiqueta: 'o CAMPO DO MULTIPLICADOR (Dice)',
      curto: 'o campo do multiplicador',
      dica: 'onde se escreve o alvo — ex.: 2.00',
      obrigatorio: true,
      validar: el => {
        if (el.tagName === 'SELECT') return { ok: false, motivo: 'isto é uma lista de escolha, não o campo do multiplicador.' };
        if (escrevivelParaConfig(el)) return { ok: true, leitura: cortar(textoDoAlvo(el), 18) || '(vazio)' };
        if (parseMoney(textoDoAlvo(el)) == null) return { ok: false, motivo: 'isto é ' + tagDo(el) +
          ' e não tem nenhum número dentro. O multiplicador é o campo onde se ESCREVE o alvo.' };
        return { ok: true, leitura: cortar(textoDoAlvo(el), 18),
                 nota: 'campo de LEITURA — vou ler-te o multiplicador em vez de o escrever' };
      }
    },
    'mines.mines': {
      etiqueta: 'o SELETOR DO Nº DE MINAS',
      curto: 'o seletor do nº de minas (a lista de 1 a 24)',
      dica: 'o controlo de 1 a 24 — no 500 é uma lista que se abre, não um campo de texto',
      obrigatorio: true,
      validar: el => {
        if (el.tagName === 'SELECT') {
          const n = el.options ? el.options.length : 0;
          if (n < 2) return { ok: true, leitura: '(ainda sem opções)',
            nota: 'AVISO: o seletor está vazio — o site ainda não desenhou as opções. Volta a capturar quando o número de minas aparecer.' };
          return { ok: true, leitura: 'escolhido «' + cortar(textoDoCampo(el), 6) + '»', nota: n + ' opções' };
        }
        if (escrevivelParaConfig(el)) return { ok: true, leitura: cortar(textoDoAlvo(el), 6) || '(vazio)',
                                               nota: 'campo de escrita' };
        /* Nem seletor nativo nem campo de escrita. Antes de recusar, procura-se o CAMPO DE
           VERDADE atrás do que se clicou — e se ele existir, é esse que se guarda. Só quando
           não existe nenhum é que se admite que este controlo é do site e se passa a dizer o
           número, em vez de se recusar um controlo que o utilizador usa em todas as rondas. */
        const real = procurarCampoReal(el);
        if (real) return { ok: true, alvo: real.el,
          leitura: cortar(textoDoAlvo(real.el), 6) || '(vazio)',
          nota: 'o que clicaste é ' + resumoDoNo(el) + ' — mas o campo que se ESCREVE está ' +
                real.onde + ' (' + tagDo(real.el) + '): guardei esse' };
        /* Clicar numa OPÇÃO da lista que abriu. Em vez de a guardar (o caminho desaparece quando
           a lista fecha), procura-se a caixa que a abre. Não é ser simpático: é guardar o único
           dos dois que continua a existir 5 segundos depois. */
        if (ehOpcaoDeLista(el)) {
          const gatilho = acharTriggerDaLista(el);
          if (gatilho) return { ok: true, alvo: gatilho, manual: true,
            leitura: cortar(textoDoAlvo(gatilho), 12) || '(vazio)',
            nota: 'clicaste numa OPÇÃO da lista, que desaparece quando escolhes — guardei a CAIXA que ' +
                  'abre a lista (' + resumoDoNo(gatilho) + '), que é a que fica na página. ' +
                  'Continuo a não lhe tocar: digo-te o número e escolhes tu' };
          return { ok: false, motivo: 'isto é uma OPÇÃO da lista, e a lista fecha quando escolhes — ' +
            'o caminho deixava de existir. Clica na CAIXA que mostra o número de minas (a que abre a ' +
            'lista), não numa opção de dentro dela.' };
        }
        if (pareceControloDoSite(el)) return { ok: true, manual: true,
          leitura: cortar(textoDoAlvo(el), 12) || '(vazio)',
          nota: 'é um controlo do SITE (' + resumoDoNo(el) + ') e não se escreve por código. ' +
                'Não lhe toco: passo a DIZER-TE o número de minas e escolhes tu na lista' };
        return { ok: false, motivo: 'isto é ' + resumoDoNo(el) +
          ' e não dá para escolher o número de minas. Se o 1 a 24 é uma lista que abre, abre-a ' +
          'primeiro e clica na OPÇÃO de dentro; se não abre, clica no controlo que mostra as minas.' };
      }
    },
    'mines.mult': {
      etiqueta: 'o multiplicador mostrado no ecrã (Mines)',
      curto: 'o multiplicador que o site mostra (o texto «1.29x»)',
      dica: 'o texto tipo «1.29x» que o site mostra — opcional',
      obrigatorio: false,
      validar: el => {
        if (parseMoney(textoDoAlvo(el)) == null) return { ok: false, motivo: 'não encontro nenhum número aqui (li «' +
          cortar(textoDoAlvo(el), 30) + '»).' };
        return { ok: true, leitura: cortar(textoDoAlvo(el), 18), nota: 'campo de LEITURA — só serve para eu conferir contigo' };
      }
    },
    'mines.board': papelTabuleiro('Mines'),
    'dice.board': papelTabuleiro('Dice')
  };

  /* A fila depende do jogo em que estás: os campos são de cada jogo, o saldo e o valor da aposta
     são da página inteira. */
  function filaDaCaptura() {
    const g = detectGame();
    const nomes = ['saldo', 'stake'];
    if (g === 'mines') nomes.push('mines.mines', 'mines.mult', 'mines.board');
    else if (g === 'dice') nomes.push('dice.mult', 'dice.board');
    return nomes.filter(n => PAPEIS[n]).map(n => Object.assign({ papel: n }, PAPEIS[n]));
  }

  /* Os campos de cada jogo, para se poderem juntar à fila À MÃO. A fila automática depende de o
     endereço dizer qual é o jogo — e quando não diz, ficavam de fora três campos e o painel
     anunciava na mesma «mapa aprendido». Um mapa que nunca foi pedido é a pior espécie de mapa:
     o que parece completo. */
  const CAMPOS_DO_JOGO = { mines: ['mines.mines', 'mines.mult', 'mines.board'],
                           dice: ['dice.mult', 'dice.board'] };

  /* PORQUE É QUE A FILA TEM DOIS PASSOS? A resposta tem de estar no painel. Quem está a aprender o
     mapa não tem como adivinhar que a fila depende do endereço — e, sem isso, o HUD parece ter
     saltado passos por sua conta. */
  function motivoDaFilaCurta() {
    const g = detectGame();
    if (g === 'mines' || g === 'dice') return null;
    return 'Não reconheço este endereço como Dice nem como Mines (' + cortar(location.pathname, 32) +
      (g ? ' — parece-me ' + g : '') + '): por isso só te pedi o saldo e o valor da aposta. ' +
      'Junta os campos do jogo que tens aberto, com o botão abaixo.';
  }

  /* O tabuleiro é a AREA que contém as casas. Quem tenta capturá-lo clica numa casa — a
     intenção é óbvia, o tabuleiro é o pai dela. Sobe-se até três níveis, e só se o pai tiver
     mesmo cara de tabuleiro; e o HUD DIZ que subiu, para isto não parecer magia. */
  function subirParaTabuleiro(el) {
    let cur = el, niveis = 0;
    while (cur && niveis++ < 3) {
      const pai = cur.parentElement;
      if (!pai) return null;
      if (pai === (document.body || null) || pai === (document.documentElement || null)) return null;
      if (pai.children && pai.children.length >= 6) return pai;
      cur = pai;
    }
    return null;
  }

  function validarCaptura(papel, el) {
    const def = PAPEIS[papel];
    if (!def) return { ok: false, motivo: 'papel desconhecido: ' + papel };
    return def.validar(el);
  }

  /* ==================== 9.4 TESTE DO MAPA ====================
     Aprender o mapa não prova que o mapa funciona. Este passo ESCREVE a configuração da ronda
     nos campos que acabaste de ensinar e diz, com nomes, o que ficou: cada campo individualmente,
     e depois 400 ms mais tarde se o site manteve o valor (React/Vue revertem depois de aceitar).

     O que ele NÃO faz: carregar em Apostar. Escreve campos de configuração e lê-os de volta —
     o clique que põe dinheiro em jogo continua a ser teu. */
  function valorAtualDoCampo(sel) {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { return null; }
    if (!el) return null;
    const t = textoDoCampo(el);
    return t == null || t === '' ? null : String(t);
  }

  /* O que escrever em cada campo DESTA página. A regra, e a razão dela:
       - se o plano tem um valor para este campo, escreve-se o do plano (é exactamente o que vai
         ser escrito a sério antes da ronda);
       - se não tem, escreve-se de VOLTA o que lá está, e diz-se isso. Inventar um valor de teste
         mudaria a configuração de quem está a jogar — e um teste que mexe no que não devia é pior
         do que não testar.
     O que fica de fora é dito à parte: um multiplicador que só se lê ou o tabuleiro não têm nada
     para escrever, e apresentá-los como «falhados» seria um alarme falso. */
  function valoresDeSonda(g) {
    const f = (S.cfg.fields || {})[g] || {};
    const passo = currentStep();
    const sonda = [], naoTestados = [];
    if (f.stake) sonda.push({ campo: 'valor da aposta', sel: f.stake, valor: textoDaAposta(S.cfg.stake) });
    const minasDoPlano = (passo && passo.game === 'Mines') ? String(passo.mines) : null;
    const multDoPlano = (passo && passo.game === 'Dice') ? passo.mult.toFixed(4) : null;
    if (g === 'mines') {
      /* Testar o que não se escreve seria um alarme falso: o teste do mapa escreve e lê de
         volta, e a um controlo do site não se escreve. Diz-se à parte, com o número à frente. */
      if (f.mines && eManual('mines.mines', 'mines')) {
        naoTestados.push('o nº de minas (controlo do site' +
          (minasDoPlano != null ? ': escolhe ' + minasDoPlano + ' na lista' : ': escolhe-o tu') + ')');
      } else if (f.mines) {
        const actual = valorAtualDoCampo(f.mines);
        sonda.push({ campo: 'nº de minas', sel: f.mines, valor: minasDoPlano != null ? minasDoPlano : actual,
          nota: minasDoPlano != null ? null : (actual == null
            ? 'não consegui ler o que lá está — não escrevo nada para não inventar'
            : 'o plano não tem passo de Mines agora: escrevi de volta o mesmo valor') });
      }
      if (f.mult) naoTestados.push('o multiplicador (só se lê)');
    }
    if (g === 'dice' && f.mult) {
      sonda.push({ campo: 'multiplicador', sel: f.mult,
        valor: multDoPlano != null ? multDoPlano : valorAtualDoCampo(f.mult) });
    }
    if (f.board) naoTestados.push('o tabuleiro (é uma área, não se escreve nele)');
    return { sonda: sonda.filter(x => x.valor != null), naoTestados: naoTestados };
  }

  function testarMapa(cb) {
    const g = detectGame();
    const { sonda, naoTestados } = valoresDeSonda(g);
    const resultados = sonda.map(x => Object.assign({ campo: x.campo }, setFieldValue(x.sel, x.valor), { nota: x.nota || null }));
    const resultado = {
      jogo: g || 'não reconhecido',
      passo: (currentStep() || {}).label || null,
      erro: g ? null : 'não reconheço esta página como Dice ou Mines — abre o jogo e testa lá',
      naoTestados: naoTestados,
      campos: resultados.map(x => ({
        campo: x.campo, ok: !!x.ok, motivo: x.motivo || null, nota: x.nota || null,
        tag: x.tag || null, framework: x.framework || null,
        ficou: x.depois != null ? String(x.depois) : null,
        pretendido: x.pretendido != null ? String(x.pretendido) : null
      })),
      desfeitos: null      // preenchido pela reverificação atrasada
    };
    verificarEscrita(resultados, 400, desfeitos => {
      resultado.desfeitos = desfeitos.map(x => x.campo);
      if (S.cfg.debug) console.log('[Sessão 500] teste do mapa: ' + (textoDoTeste(resultado).join(' | ')));
      if (cb) cb(resultado);
    });
    return resultado;
  }

  /* O veredicto em português, com a linha seguinte já escrita: o que fazer se falhou, e o que
     fazer se passou (conferir no ecrã e carregar em Apostar — tu). */
  function textoDoTeste(r) {
    const linhas = [];
    if (r.erro) linhas.push('⚠ ' + r.erro);
    if (r.passo) linhas.push('passo do plano: ' + r.passo);
    r.campos.forEach(c => {
      if (c.ok) linhas.push('✓ ' + c.campo + ' → «' + (c.ficou || '') + '»' + (c.tag ? ' [' + c.tag + ']' : '') +
                            (c.nota ? ' — ' + c.nota : ''));
      else linhas.push('✗ ' + c.campo + ': ' + (c.motivo || 'não ficou'));
    });
    if (r.naoTestados && r.naoTestados.length) linhas.push('(não se testa: ' + r.naoTestados.join(', ') + ')');
    const maus = r.campos.filter(c => !c.ok);
    if (!r.campos.length) {
      linhas.push('Não escrevi nada: nenhum campo desta página está ensinado ao HUD.');
    } else if (r.desfeitos && r.desfeitos.length) {
      linhas.push('✗ O SITE DESFEZ o valor em: ' + r.desfeitos.join(', ') +
        ' — são campos controlados por React/Vue. Escreve-os à mão.');
    } else if (maus.length) {
      linhas.push('✗ Escreve à mão antes de apostar: ' + maus.map(c => c.campo).join(', ') +
        '. Se for sempre este, volta a capturar esse campo.');
    } else if (r.desfeitos) {
      linhas.push('✓ O site aceitou e MANTEVE tudo. Agora CONFERE NO ECRÃ, carrega em «Vou apostar com disciplina» ' +
        'e faz tu a aposta — o clique em Apostar é teu.');
    } else {
      linhas.push('… a confirmar se o site manteve os valores (meio segundo).');
    }
    return linhas;
  }

  function linhasDoTeste(r) {
    return textoDoTeste(r).map(l => String(l).replace(/[<>&]/g, '')).join('<br>');
  }

  /* O elemento que está MESMO debaixo do cursor. A máscara do HUD está com pointer-events:none,
     por isso normalmente nem aparece na pilha — mas se aparecer, é saltada: capturar o próprio
     HUD seria o pior desfecho possível desta função. */
  function nossoNo(el) {
    if (!el) return true;
    const h = (root && root.host) || null;
    if (h && (el === h || (h.contains && h.contains(el)))) return true;
    if (root && el === root) return true;
    const c = el.classList;
    return !!(c && c.contains && (c.contains('pick') || c.contains('pickHint') || c.contains('capPanel')));
  }

  function elementoDebaixo(x, y) {
    let pilha = [];
    try {
      if (document.elementsFromPoint) pilha = document.elementsFromPoint(x, y) || [];
      else if (document.elementFromPoint) pilha = [document.elementFromPoint(x, y)];
    } catch (e) { pilha = []; }
    for (const el of pilha) if (!nossoNo(el)) return el;
    return null;
  }

  /* Um clique que nasceu DENTRO do HUD (os botões do painel) não é uma captura: é um clique na
     ferramenta. Sem esta distinção, o painel ficava inutilizável no momento em que o abres. */
  function veioDoHud(e) {
    if (!root) return false;
    const caminho = (e && e.composedPath) ? e.composedPath() : null;
    if (caminho && caminho.length) return caminho.indexOf(root.host) !== -1 || caminho.indexOf(root) !== -1;
    return !!root.host && e && e.target === root.host;
  }

  /* Aplica UMA captura validada e diz o que aconteceu. É esta a função que os testes exercitam:
     recebe o elemento, devolve o resultado, não depende de nenhum clique real. */
  function capturarElemento(papel, el) {
    if (!el) return { ok: false, papel: papel, motivo: 'não apanhei elemento nenhum aí' };
    let alvo = el, subiu = '';
    let v = validarCaptura(papel, alvo);
    if (!v.ok && /\.board$/.test(papel)) {
      const pai = subirParaTabuleiro(el);
      if (pai) {
        const v2 = validarCaptura(papel, pai);
        if (v2.ok) { alvo = pai; v = v2; subiu = ' (subi da casa para o tabuleiro — o tabuleiro é a área que as contém)'; }
      }
    }
    if (!v.ok) return { ok: false, papel: papel, motivo: v.motivo, resumo: resumoDoNo(el) };
    /* A validação pode ter encontrado um alvo MELHOR do que o que foi clicado (o campo de
       verdade escondido dentro da caixa desenhada). É esse que se guarda — guardar o que se
       clicou seria guardar um sítio onde a escrita não pega. */
    if (v.alvo && v.alvo !== alvo) { alvo = v.alvo; }
    const sel = cssPath(alvo);
    if (!sel) return { ok: false, papel: papel, motivo: 'não consegui construir um caminho até este elemento' };
    /* O saldo é o alimento do HUD inteiro: vive em cfg.sel. Os campos vivem por jogo. */
    if (papel === 'saldo') {
      S.cfg.sel = sel;
      const inp = $('sel'); if (inp) inp.value = sel;
    } else {
      teachField(papel, sel);
      /* Fica registado, no próprio mapa, quando um campo NÃO se escreve: assim o preenchimento
         automático não lhe toca, e o painel diz o valor em vez de fingir que o escreveu. */
      if (!S.cfg.manual) S.cfg.manual = {};
      if (v.manual) S.cfg.manual[papel] = true; else delete S.cfg.manual[papel];
    }
    saveCfg();
    return { ok: true, papel: papel, sel: sel, leitura: v.leitura || '', manual: !!v.manual,
             nota: (v.nota || '') + subiu, tag: tagDo(alvo) };
  }

  Object.assign(CAPTURA, {
    iniciar: iniciarCaptura,
    terminar: terminarCaptura,
    testar: testarMapa,
    faseDeTeste: faseDeTeste,
    textoDoTeste: textoDoTeste,
    posicionar: posicionarCaptura,
    limitarPosicao: limitarPosicao,
    minimizar: () => { if (CAP) { CAP.min = !CAP.min; renderCapPanel(); } return CAP ? !!CAP.min : null; },
    capturarElemento: capturarElemento,
    validar: validarCaptura,
    fila: filaDaCaptura,
    estado: estadoCaptura,
    avancar: avancarCaptura,
    voltar: voltarCaptura,
    juntar: juntarCamposDoJogo,
    retomar: entrarEmPassos,
    motivoFila: motivoDaFilaCurta,
    papeis: PAPEIS
  });

  let CAP = null;          // sessão de captura activa (null quando não há nenhuma)
  let capEl = null;        // o painel da captura
  let capHover = null;     // o elemento realçado neste momento
  let capArrastando = null;  // { dx, dy } enquanto arrastas o painel
  let capPos = null;         // onde o painel foi posto à mão (para o travão sobreviver ao redesenho)

  /* O travão de margens, em função pura (para se poder testar sem browser): um painel arrastado
     para fora do ecrã deixaria de se poder apanhar outra vez. */
  function limitarPosicao(x, y, w, h, vw, vh) {
    const m = 6;
    return {
      x: Math.max(m, Math.min(Math.max(m, vw - w - m), x)),
      y: Math.max(m, Math.min(Math.max(m, vh - h - m), y))
    };
  }

  /* Move o painel para um ponto do ecrã, sempre dentro da janela. */
  function posicionarCaptura(x, y) {
    if (!capEl || !capEl.style) return;
    const w = capEl.offsetWidth || 440, h = capEl.offsetHeight || 140;
    const vw = window.innerWidth || 1200, vh = window.innerHeight || 800;
    const p = limitarPosicao(x, y, w, h, vw, vh);
    capPos = { x: x, y: y };
    capEl.style.transform = 'none';
    capEl.style.left = p.x + 'px';
    capEl.style.top = p.y + 'px';
  }

  function estadoCaptura() {
    if (!CAP) return { activa: false };
    const passo = CAP.fila[CAP.i] || null;
    return {
      activa: true, fase: CAP.fase, i: CAP.i, total: CAP.fila.length,
      papel: passo ? passo.papel : null,
      feito: Object.keys(CAP.feitos),
      rejeitado: CAP.rejeitado || null,
      tapado: CAP.tapado || null,
      teste: CAP.teste || null
    };
  }

  function renderCapPanel() {
    if (!CAP) {
      if (capEl && capEl.remove) capEl.remove();
      capEl = null;
      return;
    }
    if (!capEl) {
      capEl = document.createElement('div');
      capEl.className = 'capPanel';
      if (root) root.appendChild(capEl);
    }
    const feito = Object.keys(CAP.feitos);
    const passo = CAP.fila[CAP.i] || null;
    capEl.className = 'capPanel' + (CAP.min ? ' min' : '');
    /* O caminho até aqui, em palavras: a lista dos passos já aprendidos. */
    const aprendido = CAP.fila.filter(p => CAP.feitos[p.papel]).map(p => {
      const f = CAP.feitos[p.papel] || {};
      /* «à mão» dito aqui e não escondido numa nota: é a diferença entre um mapa completo e um
         mapa que parece completo. */
      return '✓ ' + (p.curto || p.papel) + ' → <b class="raw">' + cortar(f.sel, 26) + '</b>' +
        (f.manual ? ' <b style="color:#f5c451">(à mão — eu digo-te o número)</b>' : '');
    });

    let corpo;
    if (CAP.fase === 'teste') {
      /* Fim da aprendizagem. Nada aqui fecha sozinho: diz-se o que ficou, o que fazer agora, e
         dá-se o botão que faz o teste — senão o utilizador fica a olhar para um painel fechado
         a perguntar-se se aquilo aprendeu mesmo alguma coisa. */
      const teste = CAP.teste;
      corpo =
        '<div class="alvo">✓ Mapa aprendido — ' + feito.length + ' de ' + CAP.fila.length + '</div>' +
        '<div class="fila">' + (aprendido.join('<br>') || 'nada') + '</div>' +
        (CAP.faltamTeste && CAP.faltamTeste.length
          ? '<div class="flag">Ficou por aprender: ' + CAP.faltamTeste.join(', ') +
            '. Podes repetir a captura só para esses — o resto já está guardado.</div>' : '') +
        '<div class="raw" style="margin-top:9px"><b>Agora testa.</b> Eu escrevo a configuração da ronda ' +
        'nos campos que ensinaste e confirmo se o site os reteve. Não carrego em Apostar — o clique é teu.</div>' +
        (eManual('mines.mines', 'mines')
          ? '<div class="raw" style="margin-top:5px">O nº de minas é um controlo do site: esse não se ' +
            'escreve por código — digo-te o número e escolhes tu na lista.</div>' : '') +
        (teste ? '<div style="margin-top:8px">' + textoDoTeste(teste).map(l =>
            '<div class="raw" style="margin-top:3px">' + l.replace(/[<>&]/g, '') + '</div>').join('') + '</div>' : '') +
        (motivoDaFilaCurta() ? '<div class="flag">' + motivoDaFilaCurta() + '</div>' : '') +
        '<div class="capBtns">' +
          '<button class="w" id="capTestar">' + (teste ? '↻ Testar outra vez' : '✅ Testar agora') + '</button>' +
          botoesJuntar() +
          '<button class="w" id="capCancel">Fechar (Esc)</button>' +
        '</div>';
    } else {
      /* Durante a aprendizagem, a instrução é literal: AGORA clica nesta, depois naquela. */
      const depois = CAP.fila.slice(CAP.i + 1).map(p => p.curto || p.papel);
      corpo =
        '<div class="alvo">AGORA: clica em <b>' + (passo ? (passo.curto || passo.papel) : '—') + '</b></div>' +
        (depois.length ? '<div class="depois">depois: ' + depois.join(' → ') + '</div>' : '') +
        '<div class="raw" style="margin-top:5px">' + (passo ? passo.dica + (passo.obrigatorio ? '' : ' (opcional — podes saltar)') : '') + '</div>' +
        (motivoDaFilaCurta() ? '<div class="flag">' + motivoDaFilaCurta() + '</div>' : '') +
        (CAP.rejeitado ? '<div class="flag bad">Recusei esse. ' + cortar(CAP.rejeitado.motivo, 220) + '</div>' : '') +
        (CAP.tapado ? '<div class="flag bad">Esse clique caiu ' +
          (CAP.tapado.painel === 'captura' ? 'no painel da captura' : 'no painel do HUD') +
          ', que estava a TAPAR o site nesse ponto' +
          (CAP.tapado.porBaixo ? ' (por baixo dele está ' + CAP.tapado.porBaixo + ')' : '') +
          ' — o site não o recebeu, e por isso não aprendi nada. Afasta esse painel (arrasta-o ou ' +
          'encolhe-o) e clica outra vez.</div>' : '') +
        /* A nota da última captura aceite (o campo escondido que se guardou, ou o aviso de que
           este campo é à mão) tem de aparecer SEMPRE no painel: se só existir no objecto de
           retorno, ninguém a lê. */
        (CAP.ultimo && CAP.ultimo.nota
          ? '<div class="flag ok">' + cortar(CAP.ultimo.nota, 260) + '</div>' : '') +
        '<div class="fila">' + (aprendido.join('<br>') || 'nada aprendido ainda') + '</div>' +
        '<div class="capBtns">' +
          (CAP.i > 0 ? '<button class="w" id="capVoltar">↩ Voltar</button>' : '') +
          '<button class="w" id="capSkip">Saltar este</button>' +
          botoesJuntar() +
          '<button class="w" id="capCancel">Fechar (Esc)</button>' +
        '</div>';
    }

    capEl.innerHTML =
      '<div class="capCab"><h4>' + (CAP.fase === 'teste' ? '🎯 Mapa aprendido' : '🎯 A aprender o mapa') +
        ' — ' + feito.length + ' de ' + CAP.fila.length +
        '</h4><span class="raw" style="font-size:10px">v' + VERSAO + ' · arrasta-me</span>' +
        '<button id="capMin">' + (CAP.min ? '+' : '–') + '</button></div>' +
      '<div class="corpo">' + corpo + '</div>';

    const q = s => (capEl.querySelector ? capEl.querySelector(s) : null);
    const bSkip = q('#capSkip'), bCanc = q('#capCancel'), bMin = q('#capMin'), bTestar = q('#capTestar');
    const cab = q('.capCab');
    if (bSkip && bSkip.style) bSkip.onclick = () => avancarCaptura();
    const bVoltar = q('#capVoltar');
    if (bVoltar && bVoltar.style) bVoltar.onclick = () => voltarCaptura();
    ['dice', 'mines'].forEach(j => {
      const b = q('#capJuntar' + j);
      if (b && b.style) b.onclick = () => juntarCamposDoJogo(j);
    });
    if (bCanc && bCanc.style) bCanc.onclick = () => terminarCaptura('fechada por ti');
    if (bMin && bMin.style) bMin.onclick = () => { CAP.min = !CAP.min; renderCapPanel(); };
    if (bTestar && bTestar.style) bTestar.onclick = () => {
      CAP.teste = testarMapa(() => renderCapPanel());
      renderCapPanel();
    };
    if (cab && cab.style) cab.onmousedown = e => {
      const r = (capEl.getBoundingClientRect ? capEl.getBoundingClientRect() : null) || { left: 0, top: 0 };
      capArrastando = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      if (e.preventDefault) e.preventDefault();
    };
    /* O painel MUDA DE ALTURA entre fases (a do teste é bem mais alta). Sem voltar a aplicar o
       travão, os botões ficavam abaixo do fundo do ecrã e o clique caía no vazio — foi assim
       que descobri isto, a clicar no botão do teste com o rato a sério. */
    if (capPos) posicionarCaptura(capPos.x, capPos.y);
  }

  function capTrava(e) {
    if (veioDoHud(e)) return;               // o painel do HUD tem de continuar clicável
    e.preventDefault(); e.stopPropagation();
  }

  function capMove(e) {
    /* O arrasto do painel é tratado ANTES da regra do HUD: o rato está por cima do painel,
       mas isto não é um clique na ferramenta — é a mover a ferramenta. */
    if (capArrastando) { posicionarCaptura(e.clientX - capArrastando.dx, e.clientY - capArrastando.dy); return; }
    if (veioDoHud(e)) return;
    const el = elementoDebaixo(e.clientX, e.clientY);
    if (capHover === el) return;
    if (capHover && capHover.classList) capHover.classList.remove('pickHover');
    capHover = el;
    if (capHover && capHover.classList) capHover.classList.add('pickHover');
  }

  function capSolta() { capArrastando = null; }

  function capTecla(e) {
    if (e.key === 'Escape') { e.preventDefault(); terminarCaptura('cancelada por ti (Esc)'); }
  }

  function capTentativa(el) {
    if (!CAP) return null;
    CAP.tapado = null;
    const passo = CAP.fila[CAP.i];
    if (!passo) return null;
    const r = capturarElemento(passo.papel, el);
    if (r.ok) {
      CAP.feitos[passo.papel] = r;
      CAP.ultimo = r;
      CAP.rejeitado = null;
      if (CAP.i < CAP.fila.length - 1) CAP.i++;
      else return faseDeTeste();
    } else {
      CAP.rejeitado = { papel: passo.papel, motivo: r.motivo };
    }
    if (S.cfg.debug) console.log('[Sessão 500] captura ' + passo.papel + ' → ' +
      (r.ok ? 'guardado ' + r.sel : 'recusado: ' + r.motivo));
    renderCapPanel();
    render();
    return r;
  }

  /* O que está MESMO debaixo do rato do lado do HUD.
     Isto separa duas coisas que eram tratadas como uma só:
       - um clique num CONTROL0 do HUD (botão, campo, aba, o painel da captura) é um clique na
         ferramenta — e tem de continuar a funcionar;
       - um clique numa zona do HUD que não faz nada NÃO é um clique na ferramenta: é o HUD a TAPAR
         o site. Até aqui, esse clique era engolido EM SILÊNCIO — a pessoa clicava no controlo que
         via, nada acontecia, e a conclusão era «o HUD recusa isto». Não recusava: não dizia nada.
     Devolve { tipo: 'controlo'|'tapa', painel: ... } — ou null quando não se sabe (não inventar). */
  function hudEm(x, y) {
    let dentro = null;
    try {
      if (root && root.elementsFromPoint) dentro = (root.elementsFromPoint(x, y) || [])[0] || null;
      else if (root && root.elementFromPoint) dentro = root.elementFromPoint(x, y);
    } catch (e) { dentro = null; }
    if (!dentro) return null;
    let cur = dentro, niveis = 0, painel = null;
    while (cur && niveis++ < 6) {
      const t = cur.tagName;
      if (t === 'BUTTON' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' ||
          t === 'LABEL' || t === 'SUMMARY' || t === 'OPTION') return { tipo: 'controlo', painel: painel };
      const c = cur.classList;
      if (c && c.contains) {
        if (c.contains('capBtns') || c.contains('tab') || c.contains('pick')) return { tipo: 'controlo', painel: painel };
        if (!painel && c.contains('capPanel')) painel = 'captura';
        if (!painel && c.contains('hud')) painel = 'hud';
      }
      const mais = cur.parentNode || cur.parentElement;
      if (!mais || mais.nodeType !== 1 || mais === root) break;
      cur = mais;
    }
    return { tipo: 'tapa', painel: painel || 'hud' };
  }

  function capClique(e) {
    if (veioDoHud(e)) {
      const dentro = hudEm(e.clientX, e.clientY);
      /* Qualquer clique novo fala do que acabou de acontecer: a denúncia anterior deixa de valer,
         seja porque acertaste num botão, seja porque caiu outra vez no pano. */
      if (CAP) CAP.tapado = null;
      if (!dentro || dentro.tipo === 'controlo') return;   // botão do HUD, ou não sei: não é captura
      /* Caiu no pano do HUD. O site não recebeu este clique, e o HUD tem de o DIZER em vez de
         ficar calado — a alternativa era a pessoa clicar no vazio sem perceber porquê. Melhor
         ainda: dizer também o que está por baixo, que é o que ela queria clicar. */
      if (CAP) {
        const porBaixo = elementoDebaixo(e.clientX, e.clientY);
        CAP.tapado = { painel: dentro.painel, x: Math.round(e.clientX), y: Math.round(e.clientY),
                       porBaixo: porBaixo ? resumoDoNo(porBaixo) : null };
      }
      renderCapPanel();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    capTentativa(elementoDebaixo(e.clientX, e.clientY));
  }

  function avancarCaptura() {
    if (!CAP) return null;
    if (CAP.i < CAP.fila.length - 1) { CAP.i++; CAP.rejeitado = null; CAP.ultimo = null; CAP.tapado = null; }
    else return faseDeTeste();
    renderCapPanel();
    return estadoCaptura();
  }

  /* Acabou de aprender. Engolir cliques deixa de fazer sentido — a página volta a ser tua — mas
     o painel fica, com o que ficou aprendido e o convite para TESTAR. Fechar em silêncio seria
     deixar a pessoa sem saber se aquilo serviu para alguma coisa. */
  function faseDeTeste() {
    cleanupLeitura();
    if (!CAP) return null;
    CAP.fase = 'teste';
    CAP.rejeitado = null;
    CAP.ultimo = null;
    CAP.faltamTeste = CAP.fila.map(p => p.papel).filter(p => !CAP.feitos[p]);
    renderCapPanel();
    render();
    return estadoCaptura();
  }

  /* Deixa de engolir cliques na página (o HUD volta a ser só um painel que observa). */
  function cleanupLeitura() {
    window.removeEventListener('mousemove', capMove, true);
    window.removeEventListener('mousedown', capTrava, true);
    window.removeEventListener('mouseup', capSolta, true);
    window.removeEventListener('click', capClique, true);
    capArrastando = null;
    if (capHover && capHover.classList) capHover.classList.remove('pickHover');
    capHover = null;
    if (document.body && document.body.style) document.body.style.cursor = '';
  }

  function cleanupCap() {
    cleanupLeitura();
    window.removeEventListener('keydown', capTecla, true);
  }

  /* Engolir os cliques da página enquanto se aprende. Está separado do arranque porque há um
     segundo caminho que volta a este modo: juntar os campos do jogo à fila depois de a
     aprendizagem ter terminado. */
  function ligarCaptura() {
    window.addEventListener('mousemove', capMove, true);
    window.addEventListener('mousedown', capTrava, true);
    window.addEventListener('mouseup', capSolta, true);
    window.addEventListener('click', capClique, true);
    window.addEventListener('keydown', capTecla, true);
    if (document.body && document.body.style) document.body.style.cursor = 'crosshair';
  }

  function iniciarCaptura() {
    if (CAP) terminarCaptura('recomeçada');
    CAP = { fila: filaDaCaptura(), i: 0, feitos: {}, rejeitado: null, ultimo: null, tapado: null,
            min: false, fase: 'passos', teste: null };
    /* O painel do HUD, aberto, tapa metade do que se vai clicar: os cliques morrem nele e a pessoa
       conclui que a ferramenta não deixa. Ao entrar em captura, encolhe-se à aba — e volta ao que
       estava quando a captura termina. É o remédio para a causa, em vez de um aviso sobre ela. */
    CAP.reabrirPainel = !S.cfg.collapsed;
    if (CAP.reabrirPainel) { S.cfg.collapsed = true; saveCfg(); }
    renderCapPanel();
    ligarCaptura();
    return estadoCaptura();
  }

  /* Junta à fila os campos de um jogo e volta ao modo de captura, já apontado ao primeiro deles.
     É a resposta ao caso «o endereço não diz qual é o jogo»: em vez de obrigar a repetir a captura
     inteira noutra página, junta-se o que falta onde se está. */
  function juntarCamposDoJogo(jogo) {
    if (!CAP) return null;
    const nomes = CAMPOS_DO_JOGO[jogo] || [];
    let primeiro = -1, juntados = 0;
    nomes.forEach(nome => {
      if (!PAPEIS[nome]) return;
      if (CAP.fila.some(p => p.papel === nome)) return;
      CAP.fila.push(Object.assign({ papel: nome }, PAPEIS[nome]));
      juntados++;
      if (primeiro < 0) primeiro = CAP.fila.length - 1;
    });
    if (primeiro >= 0) CAP.i = primeiro;
    entrarEmPassos();
    return { juntados: juntados, i: CAP.i, fila: CAP.fila.map(p => p.papel) };
  }

  /* Volta ao modo de captura sem perder o que já foi aprendido (o que está aprendido vive na
     configuração, não na sessão). É o caminho de volta da fase de teste. */
  function entrarEmPassos() {
    if (!CAP) return null;
    CAP.fase = 'passos';
    CAP.rejeitado = null;
    CAP.ultimo = null;
    ligarCaptura();
    renderCapPanel();
    render();
    return estadoCaptura();
  }

  /* O HUD avança sozinho quando o clique é ACEITE — e um passo dado a mais era irrecuperável:
     sobrava repetir a captura inteira. Agora volta atrás, e o campo que estava mal fica pronto a
     ser substituído (a captura seguinte escreve por cima, como sempre). */
  function voltarCaptura() {
    if (!CAP) return null;
    if (CAP.i > 0) { CAP.i--; CAP.rejeitado = null; CAP.ultimo = null; }
    renderCapPanel();
    render();
    return estadoCaptura();
  }

  /* Os botões que faltavam: sem eles, quem não fosse reconhecido pelo endereço não tinha como
     aprender os campos do jogo — e o painel dizia «aprendido» sobre um mapa que nunca foi pedido. */
  function botoesJuntar() {
    if (!CAP) return '';
    let h = '';
    ['dice', 'mines'].forEach(j => {
      const falta = CAMPOS_DO_JOGO[j].some(n => !CAP.fila.some(p => p.papel === n));
      if (!falta) return;
      h += '<button class="w" id="capJuntar' + j + '">＋ campos do ' +
           (j === 'dice' ? 'Dice' : 'Minas') + '</button>';
    });
    return h;
  }

  /* Fecha a captura e resume o que ficou. O resumo vai para a zona de configuração, e não para o
     painel que desaparece: uma captura interrompida a meio tem de deixar rasto de onde parou. */
  function terminarCaptura(motivo) {
    const fila = CAP ? CAP.fila : [];
    const feitos = CAP ? Object.assign({}, CAP.feitos) : {};
    const faltam = fila.map(p => p.papel).filter(p => !feitos[p]);
    /* Devolve o painel principal ao estado em que estava antes da captura. */
    if (CAP && CAP.reabrirPainel) { S.cfg.collapsed = false; saveCfg(); }
    cleanupCap();
    CAP = null;
    renderCapPanel();
    const nomes = Object.keys(feitos);
    const linhas = [];
    if (nomes.length) {
      linhas.push('<div class="flag ok">✓ Capturado (' + nomes.length + '): ' + nomes.map(n =>
        n + ' → ' + feitos[n].sel).join(' · ') + '</div>');
    }
    if (faltam.length) {
      linhas.push('<div class="flag">' + (nomes.length ? 'Ficou por capturar: ' : 'Não capturei nada. Faltava: ') +
        faltam.join(', ') + '. Podes repetir a captura só para esses.</div>');
    }
    if (!nomes.length && !faltam.length) linhas.push('<div class="flag bad">Captura terminada sem nada (' + cortar(motivo, 60) + ').</div>');
    const out = $('capOut');
    if (out) out.innerHTML = linhas.join('');
    render();
    if (S.cfg.debug) console.log('[Sessão 500] captura terminada (' + motivo + '): ' + nomes.join(', '));
    return { feitos: nomes, faltam: faltam, motivo: motivo };
  }

  /* Apanhador de elemento: deixa-te clicar no saldo para o HUD aprender onde ele está.
     So leitura: o clique é capturado em fase de captura e a propagacao e interrompida,
     para nao accionar nenhum botao do casino por engano.
     Monta a mascara DENTRO do Shadow DOM (as classes .pick vivem no CSS do HUD: fora dele,
     a mascara nao tinha estilo nenhum) e com pointer-events:none, para que o
     elementFromPoint continue a ver o que esta por baixo — que e o que estamos a apanhar. */
  function startPicker(alvo) {
    const mask = document.createElement('div');
    mask.className = 'pick';
    const hint = document.createElement('div');
    hint.className = 'pickHint';
    hint.textContent = 'Clique único: clica em ' +
      (PAPEIS[alvo] ? PAPEIS[alvo].etiqueta : PAPEIS.saldo.etiqueta) + '. Esc cancela.';
    let hovered = null;
    const onMove = e => {
      const el = elementoDebaixo(e.clientX, e.clientY);
      if (hovered === el) return;
      if (hovered) hovered.classList.remove('pickHover');
      hovered = el;
      if (hovered && hovered.classList) hovered.classList.add('pickHover');
    };
    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    /* O apanhador de um clique passa pela MESMA validação da captura guiada. Duas validações
       para o mesmo gesto divergiriam, e a que ficasse para trás passaria a guardar lixo. */
    const finish = e => {
      stop(e); cleanup();
      const el = elementoDebaixo(e.clientX, e.clientY);
      const out = $('capOut');
      if (!el) { if (out) out.innerHTML = '<div class="flag bad">Não apanhei nada nesse ponto.</div>'; return; }
      const papel = alvo || 'saldo';
      const r = capturarElemento(papel, el);
      if (out) out.innerHTML = r.ok
        ? '<div class="flag ok">✓ ' + papel + ' → <b class="raw">' + r.sel + '</b>' +
          (r.leitura ? ' · lê «' + r.leitura + '»' : '') + (r.nota ? ' · ' + r.nota : '') + '</div>'
        : '<div class="flag bad">✗ ' + papel + ' recusado: ' + r.motivo + '</div>';
      render();
    };
    function cleanup() {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', finish, true);
      window.removeEventListener('mousedown', stop, true);
      window.removeEventListener('keydown', onKey, true);
      if (hovered && hovered.classList) hovered.classList.remove('pickHover');
      mask.remove(); hint.remove();
      if (document.body && document.body.style) document.body.style.cursor = '';
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', stop, true);
    window.addEventListener('click', finish, true);
    window.addEventListener('keydown', onKey, true);
    if (root) { root.appendChild(mask); root.appendChild(hint); }
    if (document.body && document.body.style) document.body.style.cursor = 'crosshair';
  }

  /* ============================== 10. LOOP ============================== */
  const POLL = 900;                       // 900 ms: as variacoes de saldo sao humanas, nao de bot
  setInterval(() => {
    const b = readBalance();
    registarLeitura(b == null ? null : S.cfg.rawLast, b);
    if (b == null) { S.syncErr = S.cfg.sel ? 'selector sem correspondência' : 'sem selector'; }
    else { S.syncErr = null; onBalance(b); }
    if (S.lockKind && Date.now() >= S.lockUntil) releaseLock();
    autoConfigurar();
    render();
  }, POLL);

  function fillInputs() {
    $('sel').value = S.cfg.sel || '';
    $('stake').value = S.cfg.stake;
    $('budget').value = S.cfg.budget;
    $('edge').value = (S.cfg.edge * 100).toFixed(2);
    $('auto').value = S.cfg.autoDetect ? '1' : '0';
    $('debug').value = S.cfg.debug ? '1' : '0';
    $('overlay').value = S.cfg.overlay ? '1' : '0';
    $('autoFill').value = S.cfg.autoFill ? '1' : '0';
    $('rot').value = S.cfg.rotation.join('\n');
  }
  fillInputs();
  } catch (e) {
    console.warn('HUD Sessão 500: interface não montada (' + (e && e.message) +
                 '). A lógica de leitura e detecção continua activa.');
  }

  /* API de consola, util para depurar a leitura sem sair do site,
     e ponto de entrada dos testes automatizados. */
  window.PAINEL500 = {
    state: S,
    cfg: S.cfg,
    rot: rot,
    passoAtual: currentStep,
    leitura: readBalance,
    alimentar: onBalance,     // injecta um saldo (usado pelo harness de teste)
    cometer: commit,          // processa um delta de saldo
    parse: parseMoney,
    classificar: classify,
    cssPath: cssPath,
    irPara: sel => { S.cfg.sel = sel; saveCfg(); return readBalance(); },
    /* --- motor de jogos / recomendação / preenchimento --- */
    detectGame: detectGame,
    jogos: GAMES,
    recomendar: recommend,
    reverterCasas: reverterCasas,
    setFieldValue: setFieldValue,
    textoDaAposta: textoDaAposta,
    camposDesfeitos: camposDesfeitos,
    verificarEscrita: verificarEscrita,
    teachField: teachField,
    /* --- captura guiada (o MAPA, não a estratégia) --- */
    captura: CAPTURA,
    iniciarCaptura: CAPTURA.iniciar,
    terminarCaptura: CAPTURA.terminar,
    testarMapa: CAPTURA.testar,
    textoDoTeste: CAPTURA.textoDoTeste,
    faseDeTeste: CAPTURA.faseDeTeste,
    capturarElemento: CAPTURA.capturarElemento,
    validarCaptura: CAPTURA.validar,
    filaDaCaptura: CAPTURA.fila,
    estadoCaptura: CAPTURA.estado,
    avancarCaptura: CAPTURA.avancar,
    papeis: CAPTURA.papeis,
    preencher: preencherNoSite,
    lerCampo: lerCampo,
    /* --- descoberta automática (a estratégia já está no código; isto só encontra o MAPA) --- */
    diagnostico: diagnostico,
    textoDiagnostico: textoDiagnostico,
    estadoDaLigacao: estadoDaLigacao,
    registarLeitura: registarLeitura,
    autoConfigurar: autoConfigurar,
    escreverNoCampo: escreverNoCampo,
    lerValorDeCampo: lerValorDeCampo,
    textoDoCampo: textoDoCampo,
    escolherOpcao: escolherOpcao,
    inspecionarCampos: inspecionarCampos,
    inspecionarCampo: inspecionarCampo,
    textoInspecao: textoInspecao,
    controladoPorFramework: controladoPorFramework,
    procurarCampos: procurarCampos,
    versao: VERSAO,
    pontuarSaldo: pontuarSaldo,
    pontuarCampo: pontuarCampo,
    procurarSaldo: procurarSaldo,
    procurarCampos: procurarCampos
  };

  console.log('%cSessão 500 — HUD de disciplina carregado. Leitura apenas; nunca coloca apostas.',
              'color:#ff5773;font-weight:bold');
})();
