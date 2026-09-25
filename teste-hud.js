/**
 * Testes do painel-500.user.js  --  sem dependencias, sem browser.
 *
 * O userscript e carregado tal como esta (o ficheiro real, nao uma copia) dentro de um
 * stub de DOM permissivo. O stub nao tenta imitar um browser: e um Proxy que aceita
 * qualquer leitura/escrita, para que a UI possa "montar" sem rebentar e o teste se
 * concentre na LOGICA -- parser de moeda, rotacao, deteccao de ronda e travoes.
 *
 * Uso:  node teste-hud.js
 */

const fs = require('fs');
const path = require('path');

/* ============================== STUB DE DOM ============================== */
const anyProxy = new Proxy(function () {}, {
  get(t, k) {
    if (k === Symbol.toPrimitive) return () => '';
    if (k === 'then') return undefined;
    if (k === 'length') return 0;
    if (k === 'toString') return () => '';
    return anyProxy;
  },
  set() { return true; },
  apply() { return anyProxy; }
});

/* O último Shadow DOM criado (o do HUD). Os testes precisam dele para distinguir um clique
   NO SITE de um clique NO PAINEL — é essa distinção que impede a captura de engolir os seus
   próprios botões. */
let shadowDoHud = null;

function fakeElement(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: { cssText: '', setProperty() {} },
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    /* O filho sabe quem é o pai e `remove()` tira-o mesmo da lista: sem isto, um elemento
       removido continuava a ser encontrado nos testes, e uma asserção sobre «o painel já não
       existe» passava a medir o painel velho. */
    appendChild(c) {
      if (c) { c._paiStub = el; if (el.children.indexOf(c) === -1) el.children.push(c); }
      return c;
    },
    removeChild() {},
    remove() {
      const p = el._paiStub;
      if (p && p.children) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); }
    },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    /* guarda os eventos despachados: é assim que o teste verifica, por comportamento
       e nao apenas por lint, que so chegam eventos input/change ao campo. */
    _events: [],
    dispatchEvent(ev) { el._events.push(ev && ev.type); return true; },
    querySelector() { return fakeElement('div'); },
    querySelectorAll() { return []; },
    getElementById() { return fakeElement('div'); },
    focus() {}, blur() {},
    firstElementChild: null,
    attachShadow() { shadowDoHud = shadowRoot(); return shadowDoHud; }
  };
  /* permissivo e PREGUICOSO: criar um fakeElement aqui recursava infinitamente
     (fakeElement -> firstElementChild -> fakeElement -> ...). */
  el.firstElementChild = anyProxy;
  el.lastElementChild = anyProxy;
  el.parentElement = anyProxy;
  el._text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; }, set(v) { el._text = String(v); }
  });
  el._html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; }, set(v) { el._html = String(v); }
  });
  return el;
}

function shadowRoot() {
  const kids = [];
  /* getElementById devolve SEMPRE o mesmo objecto (como no DOM). Antes devolvia um elemento
     novo a cada chamada, e isso tornava impossivel testar qualquer coisa que ESCREVE num
     elemento e depois la vai ler — incluindo o bug de uma mensagem apagada pelo render. */
  const porId = {};
  const sr = {
    appendChild(c) {
      if (c) {
        c._paiStub = sr;
        if (kids.indexOf(c) === -1) kids.push(c);
        if (c.id) porId[c.id] = c;
      }
      return c;
    },
    getElementById(id) {
      if (porId[id]) return porId[id];
      const e = fakeElement('div');
      e.id = id;
      porId[id] = e;
      return e;
    },
    querySelector() { return fakeElement('div'); },
    children: kids,
    _porId: porId
  };
  return sr;
}

/* Um input de formulario. `aceita: false` simula os campos CONTROLADOS por frameworks
   (React/Vue): a escrita em .value nao pega, e o HUD tem de o detectar e reportar. */
function fakeInput(inicial, aceita) {
  const el = fakeElement('input');
  let v = String(inicial == null ? '' : inicial);
  Object.defineProperty(el, 'value', {
    get() { return v; },
    set(x) { if (aceita) v = String(x); }
  });
  return el;
}

/* Elementos reais que o teste controla (o "saldo" da pagina falsa). */
const registry = {};
registry['#wallet'] = fakeElement('div');
registry['#wallet'].textContent = '5,00 USD';
registry['.balance-value'] = registry['#wallet'];

function installStub() {
  const captured = { intervals: [], winListeners: [] };
  /* Os listeners da janela sao registados a serio: e assim que o teste consegue exercitar o
     caminho REAL da captura (clique apanhado em fase de captura e engolido) em vez de chamar
     a logica por dentro e ficar a testar outra coisa. */
  global.window = {
    addEventListener(tipo, fn, capture) { captured.winListeners.push({ tipo, fn, capture: !!capture }); },
    removeEventListener(tipo, fn) {
      for (let i = captured.winListeners.length - 1; i >= 0; i--) {
        const l = captured.winListeners[i];
        if (l.tipo === tipo && l.fn === fn) captured.winListeners.splice(i, 1);
      }
    },
    dispatchEvent() {},
    __PAINEL500_HUD__: undefined
  };
  global.document = {
    readyState: 'complete',
    body: fakeElement('body'),
    documentElement: fakeElement('html'),
    createElement: fakeElement,
    querySelector(sel) { return registry[sel] || null; },
    querySelectorAll() { return []; },
    getElementById() { return fakeElement('div'); },
    addEventListener() {}, removeEventListener() {}
  };
  const store = {};
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  global.CSS = { escape: s => String(s) };
  global.alert = () => {};
  global.confirm = () => true;
  global.setInterval = fn => { captured.intervals.push(fn); return captured.intervals.length; };
  global.clearInterval = () => {};
  /* O userscript le `location.pathname` directamente (sem window.), por isso o teste
     controla o global. Cada bloco muda o path antes de chamar detectGame(). */
  global.location = { pathname: '/', href: 'https://csgo500.com/' };
  global.__stub = { captured, registry, store };
  return captured;
}

/* ============================== CORRER O USERSCRIPT ============================== */
const capturado = installStub();
const src = fs.readFileSync(path.join(__dirname, 'painel-500.user.js'), 'utf8');
// Executa o ficheiro real no contexto global do Node.
new Function('window', 'document', 'localStorage', 'CSS', 'setInterval', 'clearInterval', 'alert', 'confirm', src)(
  global.window, global.document, global.localStorage, global.CSS,
  global.setInterval, global.clearInterval, global.alert, global.confirm
);

const P = global.window.PAINEL500;
const avisos = [];
const consoleWarn = console.warn;
console.warn = (...a) => avisos.push(a.join(' '));

/* ============================== HARNESS ============================== */
let passou = 0, falhou = 0;
function ok(nome, cond, extra) {
  if (cond) { passou++; console.log('  ok   ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (extra ? '  -> ' + extra : '')); }
}
function igual(nome, obtido, esperado) {
  ok(nome, obtido === esperado, 'obtido ' + JSON.stringify(obtido) + ', esperado ' + JSON.stringify(esperado));
}
function seccao(t) { console.log('\n' + t); }

if (!P) {
  console.error('\nO userscript não expôs PAINEL500. Abortar.');
  process.exit(1);
}

/* ============================== 1. PARSER DE MOEDA ============================== */
seccao('[1] Parser de moeda — formatos REAIS observados no csgo500.com');
[
  ['5 805,80 USD', 5805.80],      // espaço para milhares, vírgula decimal
  ['199 999,91', 199999.91],
  ['398,02 USD', 398.02],
  ['1 177,30', 1177.30],
  ['19 967,06', 19967.06],
  ['13 512,80', 13512.80],
  ['0,72 USD', 0.72],
  ['22,00', 22.00],
  ['5,00 USD', 5.00],
  ['5,805.80 USD', 5805.80],      // formato US com ambos
  ['1.234,56', 1234.56],          // europeu com ambos
  ['1,234.56', 1234.56],          // US com ambos
  ['5.80 USD', 5.80],             // só ponto, 2 decimais -> decimal
  ['1.234', 1234],                // só ponto, 3 decimais -> milhares (ambiguidade documentada)
  ['−3,50 USD', -3.50],           // U+2212: o sinal de menos do site NÃO é o hífen do teclado
  ['\u2212199 999,91', -199999.91],
  ['', null],
  ['abc', null]
].forEach(([entrada, esperado]) => igual('parse(' + JSON.stringify(entrada) + ')', P.parse(entrada), esperado));

/* ============================== 2. ROTACAO ============================== */
seccao('[2] Motor de rotacao (inclui combinatória das Minas)');
igual('nº de rondas na rotacao por defeito', P.rot().length, 6);
const minas = P.rot().find(r => r.game === 'Mines' && r.mines === 3 && r.tiles === 2);
ok('mines 3m/2c existe', !!minas);
// p = C(22,2)/C(25,2) = 231/300 = 0.77  ->  mult = 0.99/0.77 = 1.2857
igual('probabilidade mines 3m/2c', minas ? Math.round(minas.winChance * 10000) / 10000 : null, 0.77);
igual('multiplicador mines 3m/2c', minas ? Math.round(minas.mult * 10000) / 10000 : null, 1.2857);
igual('ronda actual e a primeira da rotacao', P.passoAtual().label, 'Dice 1.10x');

/* ============================== 3. LEITURA DO SALDO ============================== */
seccao('[3] Leitura do saldo a partir do selector');
P.irPara('#wallet');
igual('le o saldo da pagina', P.leitura(), 5.00);
igual('guarda a string crua', P.state.cfg.rawLast, '5,00 USD');
igual('selector invalido devolve null', P.irPara('#nao-existe'), null);

/* ============================== 4. DETECCAO DE RONDA ============================== */
seccao('[4] Deteccao automatica de rondas por variacao de saldo');
P.state.cfg.stake = 0.30;
P.state.cfg.rotation = ['dice 2.0'];       // rotacao simples: perde 0.30 / ganha 0.30
P.state.history = []; P.state.breaks = []; P.state.cursor = 0; P.state.lossStreak = 0;

P.alimentar(5.00);                          // primeira leitura -> inicializa a sessao
igual('inicializa a banca', P.state.startBalance, 5.00);
igual('ainda sem rondas', P.state.history.length, 0);

P.alimentar(4.70);                          // -0.30 -> derrota
igual('delta -0.30 classificado como derrota', P.state.history[0].result, 'lose');
igual('ronda avancou na rotacao', P.state.cursor, 1);

P.alimentar(5.00);                          // +0.30 -> vitoria
igual('delta +0.30 classificado como vitoria', P.state.history[1].result, 'win');
igual('sequencia de derrotas reiniciada', P.state.lossStreak, 0);

P.alimentar(4.70);                          // -0.30 -> derrota
P.alimentar(4.40);                          // -0.30 -> derrota
igual('duas derrotas seguidas contadas', P.state.lossStreak, 2);

P.alimentar(44.40);                         // +40 -> deposito
const ext = P.state.history[P.state.history.length - 1];
igual('delta grande positivo classificado como external', ext.result, 'external');
ok('nota do external menciona deposito', /dep[oó]sito/i.test(ext.note || ''), ext.note);

P.alimentar(44.47);                         // +0.07 -> nao corresponde a nada
igual('delta irreconhecivel classificado como unknown',
     P.state.history[P.state.history.length - 1].result, 'unknown');

/* ============================== 5. TRAVOES ============================== */
seccao('[5] Freno de mao disparado pela deteccao');
P.state.cfg.guard.lossStreak = 3;
P.state.cfg.guard.winCoolAmount = 9999;     // desligar o gatilho de ganho
P.state.lockKind = null; P.state.lockUntil = 0; P.state.lossStreak = 0;
P.state.history = []; P.state.cursor = 0; P.state.breaks = [];

P.alimentar(40.00);                         // re-inicializa com banca limpa
P.alimentar(39.70); P.alimentar(39.40); P.alimentar(39.10);   // 3 derrotas
ok('travao abriu por sequencia de derrotas', P.state.lockKind === 'streak', 'lockKind=' + P.state.lockKind);
ok('contador de pausa a correr', P.state.lockUntil > Date.now());
ok('motivo menciona as derrotas', /derrotas/i.test(P.state.lockWhy), P.state.lockWhy);

// simulacao do tick: expirar e verificar que a pausa fica registada
P.state.lockUntil = Date.now() - 1;
global.__stub.captured.intervals[0]();      // corre um tick do proprio loop do HUD
ok('a pausa foi registada', P.state.breaks.length === 1, 'breaks=' + P.state.breaks.length);
igual('a sequencia de derrotas foi reiniciada', P.state.lossStreak, 0);
igual('o travo libertou', P.state.lockKind, null);

/* ============================== 6. GARANTIA DE NAO-APOSTA ============================== */
seccao('[6] Garantia de desenho: o HUD nao coloca apostas');

/** Remove comentarios e literais de string, para que a verificação abaixo olhe apenas
 *  para CODIGO EXECUTAVEL. A primeira versão só filtrava linhas começadas por * ou //,
 *  o que dava falsos positivos no texto de continuação de blocos de comentário. */
function stripCommentsAndStrings(s) {
  let out = '', i = 0, mode = 'code';
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += ' '; i++; continue; }
      out += c; i++;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i++;
    } else { /* dentro de string */
      if (c === '\\') { i += 2; continue; }
      if (c === mode) { mode = 'code'; out += ' '; i++; continue; }
      out += (c === '\n' ? '\n' : ' '); i++;
    }
  }
  return out;
}
/** Igual ao anterior, mas MANTÉM os literais de string. É preciso porque a verificação
 *  dos eventos tem de ler o nome do evento ('input'/'change'), que o outro apagava. */
function stripCommentsKeepStrings(s) {
  let out = '', i = 0, mode = 'code';
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; out += c; i++; continue; }
      out += c; i++;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; }
      out += (c === '\n' ? '\n' : ' '); i++;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i++;
    } else { /* dentro de string */
      if (c === '\\') { out += c + (n || ''); i += 2; continue; }
      if (c === mode) { mode = 'code'; out += c; i++; continue; }
      out += c; i++;
    }
  }
  return out;
}
const linhasFonte = stripCommentsKeepStrings(src).split('\n');

const codigo = stripCommentsAndStrings(src);
const linhasCodigo = codigo.split('\n');
const contemCodigo = re => {
  const idx = linhasCodigo.findIndex(l => re.test(l));
  return idx === -1 ? null : (idx + 1) + ': ' + linhasCodigo[idx].trim();
};
const proibido = [
  [/\.click\s*\(/, 'chamada .click()'],
  [/\bMouseEvent\b/, 'MouseEvent'],
  [/\bKeyboardEvent\b/, 'KeyboardEvent'],
  [/\bPointerEvent\b/, 'PointerEvent'],
  [/\.submit\s*\(/, 'form.submit()'],
  [/\brequestSubmit\b/, 'requestSubmit'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/navigator\.sendBeacon/, 'sendBeacon'],
  [/\bplaceBet|colocarAposta|autoBet|autobet\b/i, 'funcao de aposta']
];
proibido.forEach(([re, nome]) => {
  const achado = contemCodigo(re);
  ok('sem ' + nome + ' no codigo executavel', achado === null, achado || '');
});
ok('o comentário de limite foi mesmo removido pelo lint',
   /element\.click\(\)/.test(stripCommentsAndStrings(src)) === false);

/* A escrita nos campos é permitida, mas APENAS via eventos input/change. */
const linhasEvento = linhasFonte.filter(l => /new Event\(/.test(l));
ok('existem eventos sinteticos (o autofill precisa deles)', linhasEvento.length > 0);
ok('TODOS os eventos criados sao input/change',
   linhasEvento.every(l => /new Event\('(input|change)'/.test(l)),
   linhasEvento.filter(l => !/new Event\('(input|change)'/.test(l)).join(' | '));
const linhasDispatch = linhasFonte.filter(l => /dispatchEvent/.test(l));
ok('todo o dispatchEvent e de input/change',
   linhasDispatch.length > 0 && linhasDispatch.every(l => /Event\('(input|change)'/.test(l)),
   linhasDispatch.filter(l => !/Event\('(input|change)'/.test(l)).join(' | '));
ok('nao despacha eventos de teclado nem de rato',
   !/dispatchEvent\s*\(\s*new\s+(KeyboardEvent|MouseEvent|PointerEvent)/.test(codigo));
ok('nao despacha nenhum evento de clique',
   !/dispatchEvent\s*\(\s*new\s+Event\('(click|mousedown|mouseup|keydown|keyup|submit)'/.test(codigo));

/* ============================== 7. DETECCAO DO JOGO ============================== */
seccao('[7] Deteccao do jogo pelo URL');
const casosUrl = [
  ['/pt/mines', 'mines'], ['/mines', 'mines'], ['/pt/dice', 'dice'], ['/en/dice', 'dice'],
  ['/pt/limbo', 'limbo'], ['/pt/keno', 'keno'], ['/pt/plinko', 'plinko'],
  ['/pt/towers', 'towers'], ['/pt/crash', 'crash'], ['/pt/wheel', 'wheel'],
  ['/pt/roulette', 'roulette'], ['/pt/duels', 'duels'], ['/pt/hilo', 'hilo'],
  ['/pt/live-games/blackjack-x', 'blackjack'], ['/pt/baccarat', 'baccarat'],
  ['/pt/cases/featured', 'cases'], ['/pt/casino/all', null], ['/', null]
];
casosUrl.forEach(([url, esperado]) => {
  global.location.pathname = url;
  igual('url ' + url, P.detectGame(), esperado);
});

/* ============================== 8. TABELA DE EDGE ============================== */
seccao('[8] Tabela de edge embutida (fonte: ajuda oficial do 500)');
[['dice', 0.01], ['mines', 0.01], ['limbo', 0.02], ['keno', 0.02], ['plinko', 0.04],
 ['towers', 0.05], ['wheel', 0.0501], ['roulette', 0.0666], ['crash', 0.06], ['duels', 0.05],
 ['blackjack', 0.0052], ['baccarat', 0.01], ['cases', 0.10], ['sports', 0.03]
].forEach(([g, e]) => igual('edge de ' + g, P.jogos[g] ? P.jogos[g].edge : null, e));
ok('todos os jogos tem nota explicativa',
   Object.keys(P.jogos).every(k => (P.jogos[k].nota || '').length >= 10),
   Object.keys(P.jogos).filter(k => (P.jogos[k].nota || '').length < 10).join(','));
ok('dice e mines explicam o MECANISMO da margem, nao so o numero',
   /9900x/.test(P.jogos.dice.nota) && /ENTRADA/.test(P.jogos.mines.nota));
ok('nenhum jogo desconhecido se apresenta como tipo "?" sem aviso',
   ['blitz', 'trader'].every(k => /não publica|não documentada/.test(P.jogos[k].nota)));

/* ============================== 9. RECOMENDACAO ============================== */
seccao('[9] Motor de recomendacao');
P.state.cfg.stake = 0.30;
P.state.cfg.edge = 0.01;

// --- Dice ---
global.location.pathname = '/pt/dice';
P.state.cfg.rotation = ['dice 2.0'];
P.state.cursor = 0;
P.state.cfg.fields.dice = { stake: '', mult: '' };
let r = P.recomendar();
igual('dice: jogo', r.jogo, 'dice');
igual('dice: edge mostrado', r.meta.edge, 0.01);
ok('dice: recomenda apostar 2.00x', /APOSTAR 2\.00x/.test(r.titulo), r.titulo);
ok('dice: ganho esperado 0.30', Math.abs(r.ganho - 0.30) < 1e-9, r.ganho);
ok('dice: perda esperada 0.30', Math.abs(r.perda - 0.30) < 1e-9, r.perda);
ok('dice: explica o EV negativo', r.linhas.some(l => /EV desta aposta/.test(l)));

// --- Mines, com o multiplicador lido do site ---
global.location.pathname = '/pt/mines';
P.state.cfg.rotation = ['mines 3 2'];
P.state.cursor = 0;
registry['#mcount'] = fakeInput('3');
registry['#mmult'] = fakeInput('1.2857');
P.state.cfg.fields.mines = { stake: '', mines: '#mcount', mult: '#mmult' };
igual('reverterCasas(3 minas, 1.2857x) = 2 casas', P.reverterCasas(3, 1.2857, 0.01), 2);
r = P.recomendar();
ok('mines: recomenda RETIRAR ao atingir o alvo', r.titulo === 'RETIRAR', r.titulo);
ok('mines: diz quantas casas abriste', r.linhas.some(l => /Abriste 2 casas/.test(l)));
ok('mines: mostra o valor de retirar', r.linhas.some(l => /RETIRAR agora devolve/.test(l)));
ok('mines: mostra a margem de abrir mais 1', r.linhas.some(l => /ABRIR mais 1:/.test(l)));
ok('mines: mostra que o EV de abrir é IGUAL ao de retirar',
   r.linhas.some(l => /diferen[çc]a\s*(−|-)?\$0\.00/.test(l)),
   r.linhas.find(l => /diferen/.test(l)));
ok('mines: explica que a margem foi paga na entrada',
   r.linhas.some(l => /paga na ENTRADA/.test(l)));

// alvo do plano nao atingido -> abrir mais 1
P.state.cfg.rotation = ['mines 3 5'];
r = P.recomendar();
ok('mines: recomenda ABRIR MAIS 1 antes do alvo', r.titulo === 'ABRIR MAIS 1', r.titulo);

// sem saber o multiplicador, NAO inventa recomendacao
P.state.cfg.fields.mines.mult = '';
r = P.recomendar();
igual('mines: sem leitura do multiplicador nao recomenda jogada', r.ok, null);
ok('mines: pede para ensinar o HUD', /ENSINAR/.test(r.titulo), r.titulo);

// --- Dice SEM multiplicador conhecido: antes isto rebentava (alvo.toFixed sobre null) ---
global.location.pathname = '/pt/dice';
P.state.cfg.rotation = ['mines 3 2'];      // rotacao sem passo de Dice
P.state.cfg.fields.dice = {};
let rebentou = null;
try { r = P.recomendar(); } catch (e) { rebentou = e.message; }
ok('dice sem multiplicador conhecido NAO rebenta', rebentou === null, rebentou || '');
ok('dice sem multiplicador pede para ensinar em vez de inventar', r && /ENSINAR/.test(r.titulo), r && r.titulo);
ok('dice sem multiplicador continua a mostrar o edge',
   r && r.meta && r.meta.edge === 0.01);

// --- jogos que nao se adaptam ao plano ---
global.location.pathname = '/pt/plinko';
r = P.recomendar();
ok('plinko: recusa recomendar aposta', /SEM RECOMENDA/.test(r.titulo), r.titulo);
ok('plinko: mostra o edge de 4%', /4\.00%/.test(r.linhas.join(' ')));

/* ============================== 10. PREENCHIMENTO ============================== */
seccao('[10] Preenchimento dos campos, sem apostar');
global.location.pathname = '/pt/mines';
P.state.cfg.rotation = ['mines 3 2'];
P.state.cursor = 0;
registry['#bet'] = fakeInput('9.99', true);      // campo bem comportado
registry['#mcount'] = fakeInput('1', true);
P.state.cfg.fields.mines = { stake: '#bet', mines: '#mcount', mult: '#mmult' };
let out = P.preencher();
ok('preenche o stake', out.resultados.some(x => x.campo === 'stake' && x.ok));
ok('preenche o nº de minas', out.resultados.some(x => x.campo === 'nº de minas' && x.ok));
ok('stake ficou mesmo 0.30', registry['#bet'].value === '0.3' || registry['#bet'].value === '0.30',
   registry['#bet'].value);
ok('minas ficou mesmo 3', registry['#mcount'].value === '3', registry['#mcount'].value);
ok('os eventos que CHEGARAM ao campo sao apenas input/change',
   registry['#bet']._events.join(',') === 'input,change',
   registry['#bet']._events.join(','));
ok('NAO preenche nenhum campo de accao de jogo',
   !out.resultados.some(x => /casa|abrir|retirar|tile/i.test(x.campo)),
   out.resultados.map(x => x.campo).join(','));
ok('nao existe sequer selector guardado para accoes de jogo',
   !('tiles' in (P.state.cfg.fields.mines || {})));

// campo que o site NAO aceita (framework controla o input) -> tem de reportar falha
registry['#bet'] = fakeInput('9.99', false);
out = P.preencher();
const rStake = out.resultados.find(x => x.campo === 'stake');
ok('detecta que o site nao aceitou o valor', rStake && rStake.ok === false);
ok('reporta o valor que ficou', rStake && rStake.depois === '9.99', rStake && rStake.depois);

// campo nao ensinado
P.state.cfg.fields.mines = { stake: '', mines: '', mult: '' };
out = P.preencher();
ok('campo nao ensinado e reportado como tal',
   out.resultados.every(x => x.ok === false && /ensinado/.test(x.motivo)),
   JSON.stringify(out.resultados.map(x => x.motivo)));
ok('o userscript nao referencia endpoints do casino',
   !/https?:\/\/(?!csgo500\.com\/\*)/.test(src.replace(/@match[^\n]*\n/g, '')));

/* ============================== 11. ENSINO DOS CAMPOS ============================== */
seccao('[11] Ensino dos campos do site ao HUD');
P.state.cfg.fields = {};
let d = P.teachField('stake', '#bet');
ok('ensinar o valor da aposta grava no Dice', P.lerCampo('dice', 'stake') !== null);
ok('ensinar o valor da aposta grava TAMBEM nas Minas', P.lerCampo('mines', 'stake') !== null);
ok('o retorno diz onde foi guardado', /stake/.test(d) && /mines/.test(d), d);

P.state.cfg.fields = {};
P.teachField('mines.mult', '#mm');
ok('o multiplicador das Minas so vai para as Minas',
   P.state.cfg.fields.mines.mult === '#mm' && (P.state.cfg.fields.dice || {}).mult === undefined);
ok('nao inventa uma entrada de jogo com o nome do campo',
   P.state.cfg.fields.mult === undefined);

// formato antigo sem jogo -> todos os jogos conhecidos
P.state.cfg.fields = { dice: {}, mines: {} };
P.teachField('mult', '#x');
ok('formato sem jogo aplica-se a todos os jogos conhecidos',
   P.state.cfg.fields.dice.mult === '#x' && P.state.cfg.fields.mines.mult === '#x');

/* O selector do numero de minas chama-se "mines" DENTRO do jogo "mines": o nome do
   campo e o nome do jogo coincidem. Filtrar por isso deixava este campo — um dos mais
   usados — sem poder ser ensinado. */
P.state.cfg.fields = {};
P.teachField('mines.mines', '#mc');
igual('ensina o selector do nº de minas (campo com o nome do jogo)',
      P.state.cfg.fields.mines.mines, '#mc');
P.state.cfg.fields = { mines: {} };
P.teachField('mines', '#mc2');
ok('formato curto com nome de jogo NAO cria um campo fantasma',
   P.state.cfg.fields.mines.mines === undefined, JSON.stringify(P.state.cfg.fields));

ok('nome de campo vazio nao rebenta', typeof P.teachField('', '#x') === 'string');
P.state.cfg.fields = {};
P.teachField('stake', '#bet');
ok('nao duplica jogos na lista de destino',
   Object.keys(P.state.cfg.fields).sort().join(',') === 'dice,mines',
   Object.keys(P.state.cfg.fields).join(','));

// o select da interface tem de estar de acordo com o contrato do teachField
ok('a interface ensina o valor da aposta UMA vez (nao uma por jogo)',
   /value="stake"/.test(src) && !/value="(dice|mines)\.stake"/.test(src));
ok('a interface so oferece campos de CONFIGURACAO para ensinar',
   !/value="[a-z]+\.(tiles|casa|abrir|retirar)"/.test(src));

/* ============================== 12. O MOTOR NUNCA REBENTA ==============================
   recommend() corre a cada 900 ms no site. Uma excepcao aqui nao é "um teste vermelho":
   é o painel inteiro a desaparecer em silêncio enquanto o utilizador aposta. Este bloco
   varre o produto cartesiano de jogos x rotações x estados de campos a procura de
   excepções — incluindo estados que o utilizador consegue criar sozinho, como escrever
   lixo na rotação. ========================================================================== */
seccao('[12] recommend() e preencher() nunca rebentam (fuzz de estados)');
const urls = ['/pt/dice', '/pt/mines', '/pt/limbo', '/pt/keno', '/pt/plinko', '/pt/towers',
              '/pt/roulette', '/pt/crash', '/pt/wheel', '/pt/duels', '/pt/hilo',
              '/pt/blackjack', '/pt/baccarat', '/pt/cases', '/', '/pt/casino/all'];
const rotacoes = [[], ['dice 2.0'], ['mines 3 2'], ['dice 1.5', 'mines 5 5'], ['lixo'], ['dice'],
                  ['mines 99 99'], ['dice 0'], ['mines 1 24'], ['mines 24 1'], ['dice 1e9'],
                  [''], ['   '], ['DICE 2'], ['mines 3']];
const estados = [{}, { mult: '#mm' }, { stake: '#bet', mines: '#mcount', mult: '#mm' },
                 { mult: '#' }, { mult: '#nao-existe' }, { mult: '[' }, { stake: '' }];
let excepcoes = [], combinacoes = 0;
for (const url of urls) for (const rot of rotacoes) for (const campos of estados) {
  combinacoes++;
  global.location.pathname = url;
  P.state.cfg.rotation = rot;
  P.state.cfg.fields = { dice: Object.assign({}, campos), mines: Object.assign({}, campos) };
  try { P.recomendar(); } catch (e) { excepcoes.push('recommend ' + url + ' ' + JSON.stringify(rot) + ' -> ' + e.message); }
  try { P.preencher(); } catch (e) { excepcoes.push('preencher ' + url + ' ' + JSON.stringify(rot) + ' -> ' + e.message); }
}
ok(combinacoes + ' estados testados', combinacoes === urls.length * rotacoes.length * estados.length);
ok('nenhuma combinacao rebenta', excepcoes.length === 0, excepcoes.slice(0, 3).join(' | '));
ok('as rotacoes invalidas sao simplesmente ignoradas',
   (() => { global.location.pathname = '/pt/dice'; P.state.cfg.rotation = ['lixo', 'dice']; return P.rot().length === 0; })());
ok('«DICE 2» em maiusculas e aceite (a rotação não é sensível a maiúsculas)',
   (() => { P.state.cfg.rotation = ['DICE 2']; return P.rot().length === 1; })());
P.state.cfg.rotation = ['mines 3 2'];
global.location.pathname = '/pt/mines';

/* ============================== 13. DESCOBERTA DE CAMPOS ============================== */
seccao('[13] Descoberta automática dos campos (a estratégia já está no código; isto encontra o MAPA)');

/* --- pontuarSaldo: o que é e o que NÃO é um saldo --- */
const saldoBom = { visivel: true, noTopo: true, filhos: 0, chave: 'header .balance-value', mudou: true };
ok('«5 805,80 USD» no topo com chave balance = candidato forte',
   P.pontuarSaldo('5 805,80 USD', saldoBom) >= 12, P.pontuarSaldo('5 805,80 USD', saldoBom));
ok('um saldo escondido perde muitos pontos',
   P.pontuarSaldo('5 805,80 USD', Object.assign({}, saldoBom, { visivel: false })) <
   P.pontuarSaldo('5 805,80 USD', saldoBom) - 8);
ok('um saldo que MUDA vale mais que um rótulo estático',
   P.pontuarSaldo('5,00 USD', Object.assign({}, saldoBom, { mudou: false })) <
   P.pontuarSaldo('5,00 USD', saldoBom));
ok('texto sem número nenhum é descartado', P.pontuarSaldo('Provably fair', saldoBom) < 0);
ok('uma frase longa com um número dentro não é o saldo',
   P.pontuarSaldo('RTP verificado em 2024 pela equipa', saldoBom) < 0);
ok('um botão de depósito não é o saldo',
   P.pontuarSaldo('5,00 USD', Object.assign({}, saldoBom, { interativo: true })) <
   P.pontuarSaldo('5,00 USD', saldoBom) - 3);
ok('texto vazio nunca é candidato', P.pontuarSaldo('', saldoBom) < -50);
ok('o saldo no rodapé (fora do topo) ainda passa, só vale menos',
   P.pontuarSaldo('398,02 USD', Object.assign({}, saldoBom, { noTopo: false })) > 0);

/* --- pontuarCampo: a diferença entre LER e ESCREVER --- */
const campoStake = { valor: '0.30', tipo: 'number', chave: 'bet-amount', visivel: true,
                     legivel: true, editavel: true, juntoDeBotao: true, passo: true };
const campoMultTexto = { valor: '1.29x', tipo: 'texto', chave: 'multiplier-value', visivel: true,
                         legivel: true, editavel: false, aoLadoDeX: true };
const campoMinas = { valor: '3', tipo: 'number', chave: 'mines-count', visivel: true,
                     legivel: true, editavel: true };
ok('input do valor é o melhor candidato a stake',
   P.pontuarCampo(campoStake, 'stake') >= 12, P.pontuarCampo(campoStake, 'stake'));
ok('o multiplicador em TEXTO é aceite para o papel mult',
   P.pontuarCampo(campoMultTexto, 'mult') > 0, P.pontuarCampo(campoMultTexto, 'mult'));
ok('mas esse mesmo texto NÃO serve para stake (não se escreve nele)',
   P.pontuarCampo(campoMultTexto, 'stake') < 0, P.pontuarCampo(campoMultTexto, 'stake'));
ok('um stake invisível vale muito menos que o mesmo campo visível',
   P.pontuarCampo(Object.assign({}, campoStake, { visivel: false }), 'stake') <
   P.pontuarCampo(campoStake, 'stake') - 8);
ok('um campo onde NÃO se escreve é VETADO para o nº de minas (não é só penalizado)',
   P.pontuarCampo(Object.assign({}, campoMinas, { editavel: false }), 'mines') < -50);
ok('um campo onde NÃO se escreve é VETADO para o valor da aposta',
   P.pontuarCampo(Object.assign({}, campoStake, { editavel: false }), 'stake') < -50);
ok('valor sem número nenhum é vetado em qualquer papel',
   ['stake', 'mult', 'mines'].every(p => P.pontuarCampo({ valor: 'x', tipo: 'text',
     chave: 'bet', visivel: true, legivel: true, editavel: true }, p) < -50));
ok('«1.00x» (antes de abrires a primeira casa) ainda é um multiplicador válido',
   P.pontuarCampo(Object.assign({}, campoMultTexto, { valor: '1.00x' }), 'mult') > 0,
   P.pontuarCampo(Object.assign({}, campoMultTexto, { valor: '1.00x' }), 'mult'));
ok('o nº de minas com chave mines e valor 3 é candidato forte',
   P.pontuarCampo(campoMinas, 'mines') >= 12, P.pontuarCampo(campoMinas, 'mines'));
ok('valor 999 para o nº de minas é rejeitado (não existe no jogo)',
   P.pontuarCampo(Object.assign({}, campoMinas, { valor: '999' }), 'mines') <
   P.pontuarCampo(campoMinas, 'mines'));
ok('um multiplicador abaixo de 1 é rejeitado',
   P.pontuarCampo(Object.assign({}, campoMultTexto, { valor: '0.98x' }), 'mult') < 0);
ok('campo sem chave nenhuma perde pontos (procurar não é adivinhar)',
   P.pontuarCampo(Object.assign({}, campoStake, { chave: '' }), 'stake') <
   P.pontuarCampo(campoStake, 'stake'));

/* O erro que a demo apanhou: um campo chamado mines-count era escolhido como VALOR DA
   APOSTA só por estar mais perto do botão de apostar. Neste caso o nome do campo das
   minas tem TODOS os bónus de layout (está junto do botão, tem um «x» ao lado) e o nome
   do valor da aposta não tem nenhum — tem de ganhar na mesma, porque o nome diz o que
   o campo É, e a posição só diz onde ele está. */
const minasComLayoutPerfeito = { valor: '1', tipo: 'text', chave: 'mines-count', visivel: true,
  legivel: true, editavel: true, juntoDeBotao: true, aoLadoDeX: true };
const stakeComLayoutMau = { valor: '0.10', tipo: 'text', chave: 'bet-input', visivel: true,
  legivel: true, editavel: true, juntoDeBotao: false, aoLadoDeX: false };
ok('o campo das minas NÃO é escolhido como valor da aposta',
   P.pontuarCampo(minasComLayoutPerfeito, 'stake') < P.pontuarCampo(stakeComLayoutMau, 'stake'),
   P.pontuarCampo(minasComLayoutPerfeito, 'stake') + ' vs ' + P.pontuarCampo(stakeComLayoutMau, 'stake'));
ok('o campo do valor da aposta NÃO é escolhido como nº de minas',
   P.pontuarCampo(stakeComLayoutMau, 'mines') < P.pontuarCampo(minasComLayoutPerfeito, 'mines'));
ok('o campo «mines-count» continua ganhar o papel das minas',
   P.pontuarCampo(minasComLayoutPerfeito, 'mines') > 0);

/* --- o contrato do API: nada é adoptado sozinho --- */
ok('procurarSaldo existe e devolve uma lista', Array.isArray(P.procurarSaldo()));
ok('procurarCampos existe e devolve um objecto por papel', typeof P.procurarCampos() === 'object');
ok('a lista de saldos num DOM vazio é vazia (não inventa)', P.procurarSaldo().length === 0);
ok('procurarSaldo NÃO mexe no selector configurado',
   (() => { const antes = P.state.cfg.sel; P.procurarSaldo(); return P.state.cfg.sel === antes; })());
ok('a interface tem o botão de descoberta e diz que confirma antes de usar',
   /id="btnAuto"/.test(src) && /não escolho eu/.test(src));

/* ============================== 14. DIAGNOSTICO ==============================
   Um HUD que nao funciona em silencio e pior do que nenhum. Estes testes existem porque a
   pergunta real nao e "funciona?" — e "porque nao funciona?", e as cinco respostas
   possiveis sao avarias diferentes, com remedios diferentes. ================= */
seccao('[14] Diagnóstico: porque é que (não) está a dar');

// 1) sem selector
P.state.cfg.sel = null;
let lig = P.estadoDaLigacao();
igual('sem selector → sem-selector', lig.codigo, 'sem-selector');
igual('e é um erro vermelho, não um aviso', lig.nivel, 'bad');
ok('diz o que fazer', /Procurar o saldo/.test(lig.acao), lig.acao);

// 2) selector que já não existe na página
P.state.cfg.sel = '#nao-existe-mesmo';
igual('selector órfão → nao-encontrado', P.estadoDaLigacao().codigo, 'nao-encontrado');

// 3) elemento encontrado, sem número lá dentro
registry['#rotulo'] = fakeElement('div');
registry['#rotulo'].textContent = 'Provably fair';
P.state.cfg.sel = '#rotulo';
lig = P.estadoDaLigacao();
igual('texto sem número → nao-numerico', lig.codigo, 'nao-numerico');
ok('mostra o texto que leu, para se perceber o engano', /Provably fair/.test(lig.detalhe), lig.detalhe);

// 4) saldo a ZERO — a causa que eu não tratava e que o painel escondia
registry['#zero'] = fakeElement('div');
registry['#zero'].textContent = '0,00 USD';
P.state.cfg.sel = '#zero';
lig = P.estadoDaLigacao();
igual('saldo zero → saldo-zero', lig.codigo, 'saldo-zero');
igual('e é AVISO, não erro: o HUD está bem, a conta é que está vazia', lig.nivel, 'warn');
ok('o texto distingue "não funciona" de "não tens saldo"', /está a funcionar/.test(lig.detalhe), lig.detalhe);

// 5) a funcionar
registry['#bom'] = fakeElement('div');
registry['#bom'].textContent = '5 805,80 USD';
P.state.cfg.sel = '#bom';
lig = P.estadoDaLigacao();
igual('saldo positivo → ligado', lig.codigo, 'ligado');
igual('e é o único estado verde', lig.nivel, 'ok');

/* --- contagem de leituras: distingue "não leio nada" de "leio sempre o mesmo" --- */
P.state.nLeituras = 0; P.state.nMudancas = 0; P.state.leituras = [];
P.registarLeitura('5,00 USD', 5);
P.registarLeitura('5,00 USD', 5);
P.registarLeitura('4,70 USD', 4.7);
igual('conta as leituras todas', P.state.nLeituras, 3);
igual('e só as que trouxeram valor diferente', P.state.nMudancas, 1);
ok('a primeira leitura nunca conta como mudança', P.state.leituras[0].mudou === false);
ok('a leitura igual não conta como mudança', P.state.leituras[1].mudou === false);
ok('a leitura diferente conta', P.state.leituras[2].mudou === true);
P.registarLeitura(null, null);
igual('uma leitura ilegível também conta como mudança', P.state.nMudancas, 2);
ok('o histórico é limitado (não cresce sem fim)', (() => {
  for (let i = 0; i < 40; i++) P.registarLeitura('x' + i, i);
  return P.state.leituras.length <= 12;
})());

/* --- o objecto e o texto para colar --- */
const diag = P.diagnostico();
ok('o diagnóstico traz a versão', typeof diag.versao === 'string' && diag.versao.length >= 3, diag.versao);
ok('traz o estado da ligação', !!diag.ligacao && !!diag.ligacao.codigo);
ok('traz os campos ensinados', !!diag.camposEnsinados && !!diag.campos);
ok('traz as últimas leituras', Array.isArray(diag.ultimas));
const txt = P.textoDiagnostico(diag);
ok('o texto é multi-linha', txt.split('\n').length > 10, txt.split('\n').length + ' linhas');
ok('o texto identifica o estado', /ESTADO: \w/.test(txt));
ok('o texto tem cabeçalho de campos ensinados', /CAMPOS ENSINADOS/.test(txt));
ok('o texto diz quem não existe (✗) sem mentir', /NÃO EXISTE|OK/.test(txt) || /nenhum/.test(txt));
ok('textoDiagnostico aguenta um diagnóstico vazio sem rebentar',
   typeof P.textoDiagnostico({}) === 'string' && typeof P.textoDiagnostico(null) === 'string');
ok('a interface mostra o diagnóstico no topo e uma caixa própria',
   /id="diagBanner"/.test(src) && /id="diagCaixa"/.test(src));
ok('há botão de forçar leitura e de copiar o diagnóstico',
   /id="btnLer"/.test(src) && /id="btnCopiarDiag"/.test(src));
ok('o modo debug é configurável e persistido',
   /debug: false/.test(src) && /S\.cfg\.debug = \$\('debug'\)/.test(src));
ok('a percentagem de P/L não é calculada sem saldo inicial (evitava «NaN%»)',
   !/pnl \/ start \* 100/.test(src) || /temBase/.test(src));

/* ============================== 15. ESCRITA, AVISO E AUTO-CONFIGURACAO ============================== */
seccao('[15] Escrever nos campos, aviso sobre o tabuleiro, configurar a ronda');

/* --- o falso erro do 0.30: escrever «0.3» e o site normalizar para «0,30» --- */
function campoQueNormaliza() {
  const el = fakeElement('input');
  let v = '';
  Object.defineProperty(el, 'value', {
    get() { return v; },
    set(x) { v = String(x).replace('.', ','); }   // o site reformata o que escrevemos
  });
  return el;
}
registry['#normaliza'] = campoQueNormaliza();
P.state.cfg.fields.mines.stake = '#normaliza';
let sv = P.setFieldValue('#normaliza', 0.30);
ok('escrever 0.30 num campo que mostra «0,3» é SUCESSO, não erro', sv.ok === true,
   'depois=' + sv.depois + ' motivo=' + (sv.motivo || '-'));
ok('mas o painel conta a verdade sobre o que ficou lá', sv.depois === '0,3', sv.depois);
ok('e compara por valor, não por texto', Math.abs(parseFloat(sv.depois.replace(',', '.')) - 0.3) < 1e-9);

/* --- o valor escrito é o valor do plano («$0.30», não «0.3»), sem arredondar nada --- */
igual('a aposta escreve-se como o plano a mostra', P.textoDaAposta(0.3), '0.30');
igual('e o mesmo para 0.80', P.textoDaAposta(0.8), '0.80');
igual('um valor redondo ganha as duas casas', P.textoDaAposta(1), '1.00');
igual('um valor que já cabe em duas casas fica igual', P.textoDaAposta(0.07), '0.07');
igual('um valor com três casas NÃO é arredondado (seria uma aposta que não autorizaste)',
      P.textoDaAposta(0.005), '0.005');
igual('um valor que não é número passa tal e qual', P.textoDaAposta('abc'), 'abc');
registry['#stake30'] = fakeInput('0.10', true);
P.state.cfg.fields.mines.stake = '#stake30';
P.state.cfg.rotation = ['mines 3 2'];
P.state.cursor = 0;
P.state.cfg.stake = 0.3;
P.preencher();
igual('e o campo do site fica mesmo com «0.30»', registry['#stake30'].value, '0.30');

/* --- um valor de LEITURA (ex.: «1.29x» num <span>) é reportado como tal, não como erro --- */
registry['#spanMult'] = fakeElement('div');
registry['#spanMult'].textContent = '1.29x';
sv = P.setFieldValue('#spanMult', '1.29');
ok('um <span> não é dado como "falhou a escrever" — é dado como não escrevível, com o porquê',
   sv.ok === false && /não aceita escrita/.test(sv.motivo) && /controlo do SITE/.test(sv.motivo), sv.motivo);
ok('essa explicação não manda o utilizador procurar um erro que não existe',
   !/não confirmou|não reteve/.test(sv.motivo), sv.motivo);

/* --- o setter NATIVO: escrever num campo controlado por framework --- */
function campoReactivo(inicial) {
  const guardado = { v: String(inicial) };
  const proto = {
    get value() { return guardado.v; },
    set value(x) { guardado.v = String(x); }        // setter "nativo" do protótipo
  };
  global.HTMLInputElement = function HTMLInputElement() {};
  global.HTMLInputElement.prototype = proto;
  const el = Object.create(proto);
  el.tagName = 'INPUT';
  el.dispatchEvent = () => true;
  el.focus = () => {};
  el.blur = () => {};
  /* O tracker do framework: propriedade própria que IGNORA a escrita directa. */
  Object.defineProperty(el, 'value', {
    get() { return guardado.v; }, set() {}, configurable: true
  });
  return el;
}
const reativo = campoReactivo('0.10');
const via = P.escreverNoCampo(reativo, '0.30');
igual('num campo controlado, escreve pelo setter nativo do protótipo', via, 'setter-nativo');
ok('e a escrita PEGA (era o que falhava e dava "erro")', reativo.value === '0.30', reativo.value);
ok('a escrita directa .value teria sido ignorada pelo tracker', (() => {
  const r2 = campoReactivo('0.10');
  r2.value = '0.99';                     // caminho ingénuo
  return r2.value === '0.10';
})(), 'o teste não prova nada se a escrita directa funcionar');
delete global.HTMLInputElement;

/* --- auto-configuração da ronda --- */
P.state.cfg.fields = { dice: { stake: '#bet', mult: '#mm' }, mines: { stake: '#bet', mines: '#mcount', mult: '#mm' } };
registry['#bet'] = fakeInput('9.99', true);
registry['#mcount'] = fakeInput('1', true);
registry['#mm'] = fakeInput('1', true);
global.location.pathname = '/pt/mines';
P.state.cfg.rotation = ['mines 3 2'];
P.state.cfg.autoFill = false;
P.state.autoFeito = null;
igual('com a auto-configuração DESLIGADA não escreve nada', P.autoConfigurar().feito, false);
igual('e diz porquê', P.autoConfigurar().motivo, 'desligado');
ok('o valor no campo ficou intocado', registry['#bet'].value === '9.99', registry['#bet'].value);

P.state.cfg.autoFill = true;
P.state.autoFeito = null;
P.state.history = [];
global.location.pathname = '/pt/mines';
let ac = P.autoConfigurar();
ok('ligada, configura a ronda sozinha', ac.feito === true, JSON.stringify(ac));
ok('escreveu o valor da aposta', registry['#bet'].value === '0.3' || registry['#bet'].value === '0.30',
   registry['#bet'].value);
ok('escreveu o nº de minas', registry['#mcount'].value === '3', registry['#mcount'].value);
ok('não escreveu o multiplicador (é valor de leitura)', registry['#mm'].value === '1', registry['#mm'].value);
igual('não repete a configuração do mesmo passo', P.autoConfigurar().motivo, 'já configurado');
P.state.history.push({ i: 1, game: 'Mines', stake: 0.3, mult: 1.29, delta: 0.09, result: 'win', balance: 5.09, at: Date.now(), auto: true });
ok('depois de uma ronda, configura outra vez para a ronda seguinte', P.autoConfigurar().feito === true);

global.location.pathname = '/pt/dice';
P.state.autoFeito = null;
const acDice = P.autoConfigurar();
ok('numa página que não é a do passo, NÃO escreve',
   acDice.feito === false && acDice.motivo.indexOf('não é a página') === 0, acDice.motivo);
global.location.pathname = '/pt/mines';
P.state.autoFeito = null;
P.state.lockKind = 'manual'; P.state.lockUntil = Date.now() + 60000;
igual('em pausa, NÃO escreve — configurar durante um travão seria contrariar o travão',
      P.autoConfigurar().motivo, 'em pausa');
P.state.lockKind = null; P.state.lockUntil = 0;
P.state.cfg.autoFill = false;

/* --- o aviso sobre o tabuleiro --- */
ok('o aviso NÃO bloqueia cliques no jogo (pointer-events:none no contentor)',
   /\.aviso\{[^}]*pointer-events:none/.test(src), 'sem isso tapava o jogo e passava a decidir');
ok('os botões do aviso voltam a aceitar cliques', /pointer-events:auto/.test(src));
ok('o aviso diz a verdade sobre as casas (não inventa uma casa "melhor")',
   /MESMA probabilidade/.test(src) && /não existe casa melhor/i.test(src));
ok('e diz explicitamente que é conselho, não acção',
   /aviso, não um botão de apostar|Zero cliques no site/.test(src));
ok('a decisão é registada em S.decisions (pergunta e resposta, não automação)',
   /S\.decisions\.push/.test(src) && Array.isArray(P.state.decisions));
ok('o aviso encolhe depois de respondido, em vez de insistir', /avisoAck/.test(src));
ok('em pausa o aviso passa a travão e não mostra botões de decisão',
   /LOCK_TEXT\[S\.lockKind\]/.test(src));
ok('o aviso pode ser desligado na configuração', /id="overlay"/.test(src) && /overlay: true/.test(src));
ok('a auto-configuração é opt-in (desligada por padrão)', /autoFill: false/.test(src));
ok('a auto-configuração nunca carrega em nada (só escreve campos)',
   !/\.click\s*\(/.test(stripCommentsAndStrings(src)));
ok('o diagnóstico mostra o estado do aviso e da auto-configuração',
   /avisoSobreOTabuleiro/.test(src) && /configurarSozinho/.test(src));

/* ============================== 16. INSPECCAO DE CAMPOS ==============================
   Quando um campo "não pega", a pergunta certa não e "porque falhou a escrita?" — e
   "o que e este elemento, afinal?". Estas funcoes respondem a ler o DOM, em vez de
   tentarem adivinhar. ============================================================ */
seccao('[16] Inspecção: o que é este campo, afinal');

global.location.pathname = '/pt/mines';
P.state.cfg.fields.mines = { stake: '#bet', mines: '#mcount', mult: '#mm', board: '#tab' };
registry['#bet'] = fakeInput('0.30', true);
registry['#mcount'] = fakeInput('1', true);
registry['#mm'] = fakeElement('div');            // valor de leitura, não campo
registry['#mm'].textContent = '1.29x';
let insp = P.inspecionarCampo('#bet', 'mines.stake');
igual('detecta que o valor da aposta é escrevível', insp.escrevivel, true);
igual('e diz a tag', insp.tag, 'INPUT');
ok('mostra o que lá está', insp.leitura === '0.30', insp.leitura);

insp = P.inspecionarCampo('#mm', 'mines.mult');
igual('um div com texto NÃO é escrevível', insp.escrevivel, false);
ok('mas continua a ser legível (é assim que o HUD lê o multiplicador)', insp.leitura === '1.29x', insp.leitura);
ok('e explica porquê, sem mandar procurar um erro inexistente',
   /controlo do SITE/.test(insp.motivo), insp.motivo);

insp = P.inspecionarCampo('#nao-existe-isto', 'mines.stake');
igual('um selector órfão é reportado como tal', insp.estado, 'não existe nesta página');
insp = P.inspecionarCampo('', 'mines.stake');
igual('um campo não ensinado também', insp.estado, 'não ensinado');

/* --- deteção de framework: as propriedades que o React/Vue deixam nos nós --- */
const reactivo2 = fakeElement('input');
Object.defineProperty(reactivo2, '__reactProps$abc123', { value: {}, enumerable: false });
igual('detecta um campo controlado por React', P.controladoPorFramework(reactivo2), 'React');
const vueEl = fakeElement('div');
vueEl.__vue__ = {};
igual('detecta Vue', P.controladoPorFramework(vueEl), 'Vue');
igual('um campo normal não tem framework nenhum', P.controladoPorFramework(fakeElement('input')), null);

/* --- a inspecção completa, por jogo --- */
const itens = P.inspecionarCampos();
ok('inspeciona todos os campos ensinados do jogo', itens.length === 4, itens.length + ' campos');
ok('inclui o tabuleiro (que serve só para posicionar o aviso)',
   itens.some(i => /\.board$/.test(i.campo)));
ok('um tabuleiro inexistente não rebenta a inspecção',
   itens.every(i => typeof i.estado === 'string'));

const ti = P.textoInspecao(itens, 'mines');
ok('o texto identifica o jogo', /Inspecção dos campos — mines/.test(ti), ti.split('\n')[0]);
ok('o texto diz o tag e a tag está no texto', /INPUT/.test(ti));
ok('o texto diz quem NÃO é escrevível e porquê', /escrevível: NÃO/.test(ti) && /controlo do SITE/.test(ti));
ok('o texto mostra o que cada campo lê', /lê:\s+«/.test(ti));
ok('textoInspecao aguenta lista vazia', typeof P.textoInspecao([], 'dice') === 'string');
ok('textoInspecao aguenta nulo', typeof P.textoInspecao(null) === 'string');

/* --- o que a interface promete --- */
ok('há botão de inspecionar e de copiar a inspecção',
   /id="btnInsp"/.test(src) && /id="btnInspCopiar"/.test(src));
ok('a inspecção aparece junto da descoberta, na configuração',
   src.indexOf('id="btnInsp"') > src.indexOf('id="btnAuto"'), 'a ordem no HTML conta');
ok('a reverificação atrasada existe (apanha o valor desfeito pelo framework)',
   /desfez o valor que eu tinha escrito|desfez o valor que eu escrevi/.test(src));
ok('o preenchimento reporta a tag e o framework de cada campo',
   /\[.*\+ \(x\.framework/.test(src) || /x\.framework \? ', ' \+ x\.framework/.test(src));
ok('os selects também são escrevíveis (era uma causa possível do nº de minas falhar)',
   /HTMLSelectElement\.prototype/.test(src));

/* ============================== 17. SELECT (O CASO DO Nº DE MINAS) ==============================
   No csgo500 o numero de minas e um SELETOR de 1 a 24. Escrever `.value` num select e o tipo
   de coisa que funciona em metade dos casos, e a outra metade falha em silencio. ====== */
seccao('[17] Escolher uma opção num seletor (é assim que as minas funcionam)');

/* Um select como os do site: opções 1..24 sem atributo value — o value é o TEXTO. */
function selectNumerado(min, max, seleccionado) {
  const el = fakeElement('select');
  el.options = [];
  el.selectedIndex = 0;
  for (let n = min; n <= max; n++) {
    el.options.push({ value: String(n), textContent: String(n) });
  }
  const ix = seleccionado != null ? seleccionado - min : 0;
  el.selectedIndex = ix;
  Object.defineProperty(el, 'value', { get() { return el.options[el.selectedIndex].value; }, set() {} });
  return el;
}
global.HTMLSelectElement = function HTMLSelectElement() {};
global.HTMLSelectElement.prototype = {};

registry['#selMinas'] = selectNumerado(1, 24, 1);
P.state.cfg.fields.mines = Object.assign({}, P.state.cfg.fields.mines, { mines: '#selMinas' });
P.state.cfg.rotation = ['mines 3 2'];   // o plano quer 3 minas
global.location.pathname = '/pt/mines';

ok('o HUD LÊ o nº de minas de um seletor', P.lerCampo('mines', 'mines') === 1, P.lerCampo('mines', 'mines'));
ok('e o texto do campo é o da opção escolhida', P.textoDoCampo(registry['#selMinas']) === '1');

const svSel = P.setFieldValue('#selMinas', 3);
ok('escrever «3» num seletor de 1 a 24 FUNCIONA', svSel.ok === true, JSON.stringify(svSel.motivo || svSel.depois));
ok('e escolheu mesmo a opção 3', registry['#selMinas'].selectedIndex === 2, registry['#selMinas'].selectedIndex);
ok('e o HUD lê 3 de volta', P.lerCampo('mines', 'mines') === 3);
ok('o valor que ficou é reportado como texto cru', svSel.depois === '3', JSON.stringify(svSel.depois));
ok('o preenchimento em bloco trata do seletor', (() => {
  const out = P.preencher();
  const m = out.resultados.filter(x => x.campo === 'nº de minas')[0];
  return m && m.ok === true;
})(), JSON.stringify(P.preencher().resultados.map(x => x.campo + ':' + x.ok)));

/* Opções com value que NÃO é o número (value="opt-3", texto «3 minas») */
const selectEstranho = fakeElement('select');
selectEstranho.options = [1, 2, 3, 4].map(n => ({ value: 'opt-' + n, textContent: n + ' minas' }));
selectEstranho.selectedIndex = 0;
Object.defineProperty(selectEstranho, 'value', { get() { return selectEstranho.options[selectEstranho.selectedIndex].value; }, set() {} });
registry['#selEstranho'] = selectEstranho;
let esc = P.escolherOpcao(selectEstranho, 3);
ok('escolhe pela ordem certa mesmo com value="opt-3" e texto «3 minas»', esc.ok === true, JSON.stringify(esc));
ok('e acertou na opção do 3', selectEstranho.selectedIndex === 2, selectEstranho.selectedIndex);
ok('o HUD lê o NÚMERO do texto, não o value', P.lerValorDeCampo(selectEstranho) === 3, P.lerValorDeCampo(selectEstranho));

/* Opção inexistente: não pode fingir que escolheu */
esc = P.escolherOpcao(selectEstranho, 99);
ok('um valor que não existe nas opções NÃO é aceite em silêncio', esc.ok === false);
ok('e a mensagem LISTA as opções disponíveis (para não ficar a adivinhar)',
   /1 minas/.test(esc.motivo) && /4 minas/.test(esc.motivo), esc.motivo);

/* Seletor sem opções (ainda por carregar) */
const vazio = fakeElement('select');
vazio.options = [];
vazio.selectedIndex = -1;
esc = P.escolherOpcao(vazio, 3);
ok('um seletor ainda vazio é reportado como tal', esc.ok === false && /não tem opções/.test(esc.motivo), esc.motivo);

/* A inspecção tem de revelar que é um seletor, e se o valor do plano existe lá dentro */
registry['#selMinas'].selectedIndex = 0;
const iSel = P.inspecionarCampo('#selMinas', 'mines.mines');
ok('a inspecção identifica o SELECT', /SELECT/.test(iSel.tag), iSel.tag);
igual('e conta as opções', iSel.nOpcoes, 24);
ok('e mostra quais as opções', /1 \| 2 \| 3/.test(iSel.opcoes), (iSel.opcoes || '').slice(0, 40));
ok('e diz se o nº que o plano pede existe nas opções', iSel.alvoDoPlanoExiste === true, iSel.alvoDoPlano);
const tSel = P.textoInspecao([iSel], 'mines');
ok('o texto da inspecção explica o seletor (era o "não escolheu o número de minas")',
   /opções:\s+24/.test(tSel) && /do plano:\s+3 existe/.test(tSel), tSel.split('\n').slice(2, 6).join(' / '));

/* A busca automática tem de ENCONTRAR um seletor (antes só olhava para <input>) */
ok('a busca de campos inclui selects, não só inputs',
   /querySelectorAll\('input, textarea, select'\)/.test(src));
ok('e usa o TEXTO da opção para pontuar, não o value',
   /el\.options\[el\.selectedIndex\]\.textContent/.test(src));

/* Um seletor não é um controlo inescrevivel: entra na mesma lógica do "escrevo ou não" */
const iSemEsc = P.inspecionarCampo('#selEstranho', 'mines.mines');
igual('um select é escrevível', iSemEsc.escrevivel, true);

/* ============================== 18. CAPTURA GUIADA ============================== */
seccao('[18] Captura guiada — clicar nos elementos, validado antes de guardar');

/* --- a fila é a ordem em que os problemas aparecem, e depende do jogo --- */
global.location.pathname = '/pt/mines';
igual('nas Minas a captura pede saldo, valor, minas, multiplicador e tabuleiro',
   P.filaDaCaptura().map(p => p.papel).join(','), 'saldo,stake,mines.mines,mines.mult,mines.board');
global.location.pathname = '/pt/dice';
igual('no Dice pede o multiplicador do Dice, não o das minas',
   P.filaDaCaptura().map(p => p.papel).join(','), 'saldo,stake,dice.mult,dice.board');
global.location.pathname = '/';
igual('fora de um jogo só pede o que é da página toda',
   P.filaDaCaptura().map(p => p.papel).join(','), 'saldo,stake');

/* --- validar: um clique no sítio errado é recusado COM MOTIVO --- */
const elDoSaldo = fakeElement('div');
elDoSaldo.textContent = '5 805,80 USD';
ok('o saldo é aceite e interpretado', P.validarCaptura('saldo', elDoSaldo).ok === true);
igual('e a captura diz quanto leu', P.validarCaptura('saldo', elDoSaldo).nota, 'vou lê-lo como $5805.80');

const elSemNumero = fakeElement('div');
elSemNumero.textContent = 'Provably fair';
const vSaldo = P.validarCaptura('saldo', elSemNumero);
ok('um texto sem número nenhum é RECUSADO como saldo', vSaldo.ok === false);
ok('e o motivo mostra o que ele leu, em vez de dizer só «não deu»', /Provably fair/.test(vSaldo.motivo), vSaldo.motivo);

function selectDeMinas(nOpcoes, escolhido) {
  const el = fakeElement('select');
  el.options = Array.from({ length: nOpcoes }, (_, i) => ({ value: String(i + 1), textContent: String(i + 1) }));
  el.selectedIndex = escolhido;
  Object.defineProperty(el, 'value', {
    get() { return el.options[el.selectedIndex] ? el.options[el.selectedIndex].value : ''; }, set() {}
  });
  return el;
}
const selDaCaptura = selectDeMinas(24, 2);
ok('o seletor das minas é aceite para o papel das minas', P.validarCaptura('mines.mines', selDaCaptura).ok === true);
igual('e a captura conta as opções', P.validarCaptura('mines.mines', selDaCaptura).nota, '24 opções');
igual('e lê a opção que está escolhida', P.validarCaptura('mines.mines', selDaCaptura).leitura, 'escolhido «3»');
const vStakeNoSelect = P.validarCaptura('stake', selDaCaptura);
ok('mas o MESMO seletor não serve como campo do valor', vStakeNoSelect.ok === false);
ok('e o motivo explica que o valor é onde se ESCREVE o número', /ESCREVE/.test(vStakeNoSelect.motivo), vStakeNoSelect.motivo);

const selVazioDaCaptura = selectDeMinas(0, -1);
const vVazio = P.validarCaptura('mines.mines', selVazioDaCaptura);
ok('um seletor ainda sem opções é aceite, mas com AVISO (o site ainda não desenhou as minas)',
   vVazio.ok === true && /AVISO/.test(vVazio.nota), vVazio.nota);

const elMultTexto = fakeElement('span');
elMultTexto.textContent = '1.29x';
ok('um multiplicador que só se lê no ecrã serve para o papel do multiplicador',
   P.validarCaptura('mines.mult', elMultTexto).ok === true);
ok('e a captura avisa que é um campo de LEITURA',
   /LEITURA/.test(P.validarCaptura('mines.mult', elMultTexto).nota));
ok('esse mesmo texto não serve para o valor da aposta',
   P.validarCaptura('stake', elMultTexto).ok === false);

const tabuleiroFalso = fakeElement('div');
for (let i = 0; i < 25; i++) tabuleiroFalso.appendChild(fakeElement('div'));
ok('o tabuleiro (25 elementos) é aceite', P.validarCaptura('mines.board', tabuleiroFalso).ok === true);
igual('e a captura conta os elementos', P.validarCaptura('mines.board', tabuleiroFalso).leitura, '25 elementos');
const soUmaCasa = fakeElement('div');
soUmaCasa.appendChild(fakeElement('div'));
const vCasa = P.validarCaptura('mines.board', soUmaCasa);
ok('clicar numa casa e não no tabuleiro é RECUSADO na validação pura', vCasa.ok === false);
ok('e o motivo diz o que se devia ter clicado', /grelha|tabuleiro/.test(vCasa.motivo), vCasa.motivo);

/* Mas na captura a intenção é clara: quem clica numa casa quer o tabuleiro, que é o pai dela.
   O HUD sobe — e di-lo, para não parecer magia. */
const grade = fakeElement('div');
const casaDentro = fakeElement('div');
grade.appendChild(casaDentro);
for (let i = 1; i < 25; i++) grade.appendChild(fakeElement('div'));
casaDentro.parentElement = grade;
grade.nodeType = 1; grade.id = 'grade-9';
casaDentro.nodeType = 1;
const rSubiu = P.capturarElemento('mines.board', casaDentro);
ok('clicar numa casa captura o TABULEIRO (a área que contém as casas)',
   rSubiu.ok === true && rSubiu.sel === '#grade-9', JSON.stringify(rSubiu));
ok('e diz que subiu, em vez de o fazer sem avisar', /subi da casa/.test(rSubiu.nota), rSubiu.nota);
const soCasa = fakeElement('div');
soCasa.appendChild(fakeElement('div'));
soCasa.parentElement = null;
ok('uma casa sem tabuleiro por cima continua a ser recusada',
   P.capturarElemento('mines.board', soCasa).ok === false);

/* --- guardar: o saldo vai para cfg.sel, os campos para o jogo dele --- */
global.location.pathname = '/pt/mines';
P.cfg.fields = {};
const elWallet9 = fakeElement('div');
elWallet9.nodeType = 1; elWallet9.id = 'wallet-9'; elWallet9.textContent = '5,00 USD';
const rSaldo = P.capturarElemento('saldo', elWallet9);
ok('capturar o saldo guarda-o na configuração', rSaldo.ok === true && P.cfg.sel === '#wallet-9', JSON.stringify(rSaldo));
const elMinas9 = selectDeMinas(24, 4);
elMinas9.nodeType = 1; elMinas9.id = 'minas-9';
const rMinas = P.capturarElemento('mines.mines', elMinas9);
ok('capturar o nº de minas guarda-o no jogo mines',
   rMinas.ok === true && P.cfg.fields.mines.mines === '#minas-9', JSON.stringify(P.cfg.fields.mines));
const antesDeRecusar = P.cfg.fields.mines.mult;
const rRecusado = P.capturarElemento('mines.mult', elSemNumero);
ok('uma captura recusada não guarda nada', rRecusado.ok === false && P.cfg.fields.mines.mult === antesDeRecusar);

/* --- a sessão, pelo caminho REAL: um clique na página, apanhado em fase de captura --- */
function cliqueNaPagina(elemento, dentroDoHud) {
  const ev = {
    clientX: 3, clientY: 3,
    preventDefault() { ev.prevenido = true; },
    stopPropagation() { ev.parado = true; },
    composedPath: () => (dentroDoHud ? [shadowDoHud] : [elemento]),
    target: dentroDoHud ? { dentro: 'do hud' } : elemento
  };
  capturado.winListeners.filter(l => l.tipo === 'click' && l.capture).forEach(l => l.fn(ev));
  return ev;
}

global.location.pathname = '/pt/mines';
const inicio = P.iniciarCaptura();
ok('a captura começa pelo saldo', inicio.activa === true && inicio.papel === 'saldo', JSON.stringify(inicio));
igual('e sabe quantos passos tem', inicio.total, 5);

global.document.elementsFromPoint = () => [elSemNumero];
const evMau = cliqueNaPagina(elSemNumero, false);
ok('em modo captura o clique é ENGOVIDO (o casino não vê nada)', evMau.prevenido === true && evMau.parado === true);
igual('e um clique no sítio errado não avança', P.estadoCaptura().papel, 'saldo');
ok('mas diz porquê, com o texto que leu',
   /Provably fair/.test((P.estadoCaptura().rejeitado || {}).motivo || ''), JSON.stringify(P.estadoCaptura().rejeitado));

global.document.elementsFromPoint = () => [elWallet9];
cliqueNaPagina(elWallet9, false);
igual('um clique no elemento certo avança para o passo seguinte', P.estadoCaptura().papel, 'stake');
igual('e o saldo ficou guardado', P.cfg.sel, '#wallet-9');

global.document.elementsFromPoint = () => [elMinas9];
cliqueNaPagina(elMinas9, false);
igual('clicar no sítio errado para o papel pedido não avança', P.estadoCaptura().papel, 'stake');

const evPainel = cliqueNaPagina(elWallet9, true);
ok('um clique DENTRO do painel do HUD não é engolido (os botões da captura funcionam)',
   !evPainel.prevenido, 'a captura engoliu o clique no seu próprio painel');

const fim = P.terminarCaptura('teste');
ok('terminar resume o que ficou feito', Array.isArray(fim.feitos) && fim.feitos.length >= 1, JSON.stringify(fim));
ok('e diz o que ficou por capturar', fim.faltam.length > 0, JSON.stringify(fim.faltam));
const evDepois = cliqueNaPagina(elWallet9, false);
ok('depois de terminar, um clique na página já NÃO é engolido (não fica um modo preso)',
   !evDepois.prevenido);
ok('e a captura está fechada', P.estadoCaptura().activa === false);

/* --- o painel é arrastável e minimizável: um painel fixo tapa sempre o que pediu para clicar --- */
const painelDoHud = () => {
  if (!shadowDoHud) return null;
  const todos = shadowDoHud.children.filter(c => /capPanel/.test(String(c.className)));
  return todos.length ? todos[todos.length - 1] : null;
};
P.iniciarCaptura();
ok('o painel da captura vive DENTRO do Shadow DOM do HUD (é a única forma de ter o CSS dele)',
   !!painelDoHud());
/* O travão de margens, testado como função pura: é ele que impede o painel de fugir do ecrã e
   que o traz de volta quando o painel CRESCE entre fases. */
const travado = P.captura.limitarPosicao(0, 600, 440, 300, 1280, 860);
ok('um painel de 300px posto a 600px numa janela de 860px é puxado para dentro',
   travado.y === 860 - 300 - 6, JSON.stringify(travado));
ok('e do lado esquerdo também não sai', P.captura.limitarPosicao(-50, 0, 440, 300, 1280, 860).x === 6);
ok('e nunca fica com coordenadas negativas',
   P.captura.limitarPosicao(-50, -50, 440, 300, 1280, 860).y === 6);
ok('mas um painel mais alto que a janela fica no topo em vez de fugir para cima',
   P.captura.limitarPosicao(100, 900, 440, 900, 1280, 860).y === 6);
P.captura.posicionar(5000, 5000);
const painelAgora = painelDoHud();
igual('arrastar para fora do ecrã é travado na margem (o painel não se pode perder)',
   painelAgora.style.left, String(1200 - 440 - 6) + 'px');
ok('e o arrasto desliga a centragem por transform', painelAgora.style.transform === 'none');
P.captura.posicionar(-100, -100);
ok('e do outro lado também fica dentro do ecrã', painelAgora.style.left === '6px' && painelAgora.style.top === '6px',
   painelAgora.style.left + '/' + painelAgora.style.top);
P.captura.posicionar(120, 400);
igual('a posição que eu escolhi é respeitada', painelAgora.style.left, '120px');
P.captura.minimizar();
igual('e sobrevive a um redesenho do painel (não salta para o meio do ecrã)', painelAgora.style.left, '120px');
P.captura.minimizar();
igual('dá para minimizar até uma linha só', P.captura.minimizar(), true);
ok('e o painel mostra que está minimizado', /capPanel min/.test(String(painelAgora.className)), painelAgora.className);
igual('e volta a abrir', P.captura.minimizar(), false);
P.terminarCaptura('teste de arrasto');
ok('ao terminar, o painel desaparece do HUD', painelDoHud() === null);

/* O resumo tem de SOBREVIVER ao render. A lista de campos é reescrita a cada 900 ms; escrever
   uma mensagem dentro dela dava uma mensagem que desaparecia antes de ser lida. */
global.location.pathname = '/pt/mines';
global.document.elementsFromPoint = () => [elWallet9];
P.iniciarCaptura();
cliqueNaPagina(elWallet9, false);
const resumoFim = P.terminarCaptura('teste de resumo');
const saida = shadowDoHud.getElementById('capOut');
ok('o resumo da captura fica escrito fora da lista de campos',
   /Capturado/.test(saida.innerHTML) && /#wallet-9/.test(saida.innerHTML), saida.innerHTML.slice(0, 120));
ok('e diz o que ficou por capturar', /Ficou por capturar/.test(saida.innerHTML), saida.innerHTML.slice(0, 200));
capturado.intervals.forEach(f => f());      // o tick de 900 ms que redesenha o HUD
ok('e continua lá depois de o HUD se redesenhar (não é apagado pelo render)',
   /Capturado/.test(saida.innerHTML), saida.innerHTML.slice(0, 120));
ok('a lista de campos continua a ser a lista de campos (as duas zonas não se pisam)',
   /mines: mines ✓/.test(shadowDoHud.getElementById('teachStatus').textContent),
   shadowDoHud.getElementById('teachStatus').textContent);

/* --- a instrução é literal: AGORA clica nesta, depois naquela --- */
const painelTexto = () => (painelDoHud() ? painelDoHud().innerHTML : '');
global.location.pathname = '/pt/mines';
global.document.elementsFromPoint = () => [elWallet9];
P.iniciarCaptura();
ok('o painel diz AGORA o que clicar, em palavras',
   /AGORA: clica em/.test(painelTexto()) && /o teu saldo/.test(painelTexto()), painelTexto().slice(0, 150));
ok('e anuncia o que vem depois, por ordem',
   /depois: o campo do valor → o seletor do nº de minas/.test(painelTexto()), painelTexto().slice(0, 260));
cliqueNaPagina(elWallet9, false);
ok('depois de um passo, o painel passa a apontar ao seguinte',
   /AGORA: clica em/.test(painelTexto()) && /o campo do valor/.test(painelTexto()));
ok('e o que já foi aprendido desaparece da lista do "depois"',
   !/depois: o teu saldo/.test(painelTexto()));

/* --- o fim da aprendizagem NÃO fecha o painel: diz o que fazer agora --- */
/* Só o saldo foi capturado; os restantes são saltados, que é o que o botão «Saltar este» faz. */
[0, 1, 2, 3].forEach(() => P.avancarCaptura());
igual('a aprendizagem acaba na fase de TESTE, não fechada', P.estadoCaptura().fase, 'teste');
ok('e o painel continua aberto a dizer que o mapa foi aprendido', /Mapa aprendido/.test(painelTexto()));
ok('e explica o passo seguinte em vez de fechar em silêncio',
   /Agora testa/.test(painelTexto()) && /Não carrego em Apostar/.test(painelTexto()));
ok('e oferece o botão do teste', /id="capTestar"/.test(painelTexto()));
ok('e o que ficou por aprender é dito, não escondido', /Ficou por aprender/.test(painelTexto()));
const evDepoisDaAprendizagem = cliqueNaPagina(elWallet9, false);
ok('ao acabar a aprendizagem, a página volta a ser tua (já não engole cliques)',
   !evDepoisDaAprendizagem.prevenido);
P.terminarCaptura('teste');
igual('e fechar fecha mesmo', P.estadoCaptura().activa, false);

/* --- o teste do mapa: escreve, confirma, e denuncia o valor desfeito pelo site --- */
global.location.pathname = '/pt/mines';
P.state.cfg.fields = { mines: { stake: '#stakeTeste', mines: '#minasTeste' } };
P.state.cfg.stake = 0.3;
P.state.cfg.rotation = ['mines 3 2'];
P.state.cursor = 0;
const elStakeTeste = fakeInput('9.99', true); elStakeTeste.nodeType = 1; elStakeTeste.id = 'stakeTeste';
const elMinasTeste = selectDeMinas(24, 0); elMinasTeste.nodeType = 1; elMinasTeste.id = 'minasTeste';
registry['#stakeTeste'] = elStakeTeste;
registry['#minasTeste'] = elMinasTeste;
const resultadoTeste = P.testarMapa();
ok('o teste escreve a configuração e confirma campo a campo',
   resultadoTeste.campos.length === 2 && resultadoTeste.campos.every(c => c.ok),
   JSON.stringify(resultadoTeste.campos));
igual('e escreveu mesmo o valor do plano no campo', elStakeTeste.value, '0.30');
igual('e escolheu mesmo as minas do plano no seletor', elMinasTeste.value, '3');
ok('antes de o site responder, o teste ainda não diz que manteve',
   resultadoTeste.desfeitos === null, JSON.stringify(resultadoTeste.desfeitos));
ok('enquanto não há resposta, o texto promete a confirmação em vez de a inventar',
   /a confirmar/.test(P.textoDoTeste(resultadoTeste).join(' ')), P.textoDoTeste(resultadoTeste).join(' | '));

/* Um campo controlado pelo framework reverte DEPOIS de aceitar: é este o caso que interessa. */
elStakeTeste.value = '9.99';                       // o site desfez o que eu escrevi
const desfeitos = P.camposDesfeitos(resultadoTeste.campos.map(c =>
  Object.assign({ sel: /valor/.test(c.campo) ? '#stakeTeste' : '#minasTeste' }, c)));
ok('o HUD deteta o valor que o site desfez',
   desfeitos.length === 1 && desfeitos[0].campo === 'valor da aposta', JSON.stringify(desfeitos.map(d => d.campo)));

/* O teste tem de testar o MAPA DA PÁGINA em que estás, não o passo do plano. */
P.state.cfg.fields = { mines: { stake: '#stakeTeste', mines: '#minasTeste', mult: '#multNaoSeEscreve', board: '#tabNaoSeEscreve' } };
P.state.cfg.rotation = ['dice 2.0'];          // o plano está noutro jogo
P.state.cursor = 0;
const resultadoNoutroJogo = P.testarMapa();
ok('numa página das Mines com o plano no Dice, o nº de minas ainda é testado',
   resultadoNoutroJogo.campos.some(c => c.campo === 'nº de minas' && c.ok),
   JSON.stringify(resultadoNoutroJogo.campos));
ok('e diz que escreveu de volta o MESMO valor, em vez de inventar um',
   /mesmo valor/.test((resultadoNoutroJogo.campos.filter(c => c.campo === 'nº de minas')[0] || {}).nota || ''),
   JSON.stringify(resultadoNoutroJogo.campos));
igual('e o valor que lá estava não foi mudado', elMinasTeste.value, '3', elMinasTeste.value);
ok('o que não se escreve é dito à parte, em vez de contado como falha',
   resultadoNoutroJogo.naoTestados.length === 2 && /multiplicador/.test(resultadoNoutroJogo.naoTestados.join(' ')),
   JSON.stringify(resultadoNoutroJogo.naoTestados));
ok('e o veredicto do teste diz o que não foi testado',
   /não se testa/.test(P.textoDoTeste(resultadoNoutroJogo).join(' ')), P.textoDoTeste(resultadoNoutroJogo).join(' | '));
const comDesfeito = Object.assign({}, resultadoTeste, { desfeitos: ['stake'] });
ok('e o veredicto diz qual foi e o que fazer',
   /DESFEZ/.test(P.textoDoTeste(comDesfeito).join(' ')) && /à mão/.test(P.textoDoTeste(comDesfeito).join(' ')),
   P.textoDoTeste(comDesfeito).join(' | '));
ok('o botão de preencher e o teste do mapa usam a MESMA reverificação (não duas verdades)',
   (src.match(/camposDesfeitos\(/g) || []).length >= 2 &&
   !/const desfeitos = out\.resultados\.filter/.test(src),
   'a lógica de reverificação continua duplicada dentro de um handler');
ok('quando corre bem, o veredicto manda conferir no ecrã e apostar EU',
   /MANTEVE/.test(P.textoDoTeste(Object.assign({}, resultadoTeste, { desfeitos: [] })).join(' ')) &&
   /o clique em Apostar é teu/.test(P.textoDoTeste(Object.assign({}, resultadoTeste, { desfeitos: [] })).join(' ')),
   P.textoDoTeste(Object.assign({}, resultadoTeste, { desfeitos: [] })).join(' | '));

/* O painel tem de dizer a quem está a olhar o que fazer e onde está. */
ok('o painel diz o passo, o que fazer e quanto falta',
   /CAPTURA GUIADA/i.test(src) && /id="capSkip"/.test(src) && /id="capCancel"/.test(src));
ok('e a captura guiada está ligada a um botão do painel de configuração',
   /id="btnCapturar"/.test(src) && /iniciarCaptura\(\)/.test(src));

/* ============================== 19. O Nº DE MINAS QUE O SITE DESENHA ============================== */
seccao('[19] O nº de minas quando o site não o deixa escrever (a caixa desenhada, 1 a 24)');

/* --- 1) o campo de VERDADE escondido dentro da caixa desenhada --- */
const caixaDoSite = fakeElement('div');
caixaDoSite.nodeType = 1;
caixaDoSite.className = 'mines-select dropdown';
caixaDoSite.getAttribute = k => (k === 'role' ? 'combobox' : null);
const selectEscondido = selectDeMinas(24, 2);
selectEscondido.nodeType = 1;
selectEscondido.id = 'minas-escondidas';
caixaDoSite.querySelectorAll = sel => (/input|select/.test(sel) ? [selectEscondido] : []);
caixaDoSite.appendChild(selectEscondido);
selectEscondido.parentElement = caixaDoSite;
caixaDoSite.parentElement = document.body;

const vEscondido = P.validarCaptura('mines.mines', caixaDoSite);
ok('a caixa desenhada é ACEITE quando lá dentro está o campo de verdade', vEscondido.ok === true, vEscondido.nota);
ok('e a nota diz que o campo guardado é o de dentro, não o que se clicou',
   /ESCREVE está dentro do que clicaste/.test(vEscondido.nota || ''), vEscondido.nota);
const rEscondido = P.capturarElemento('mines.mines', caixaDoSite);
igual('e é mesmo o campo de dentro que fica guardado', rEscondido.sel, '#minas-escondidas');
igual('e esse campo continua a ser um campo normal (não fica marcado «à mão»)',
   P.cfg.manual['mines.mines'], undefined);

/* --- 2) sem campo nenhum lá dentro: em vez de recusar, DIZER o número --- */
const soOControlo = fakeElement('div');
soOControlo.nodeType = 1;
soOControlo.className = 'mines-picker';
soOControlo.getAttribute = k => (k === 'role' ? 'listbox' : null);
soOControlo.textContent = '3';
soOControlo.parentElement = document.body;
const vManual = P.validarCaptura('mines.mines', soOControlo);
ok('sem campo nenhum lá dentro, o controlo do site é aceite como «à mão»',
   vManual.ok === true && vManual.manual === true, JSON.stringify(vManual));
ok('e a nota diz que o número passa a ser DITO em vez de escrito',
   /DIZER-TE o número/.test(vManual.nota || ''), vManual.nota);
const rManual = P.capturarElemento('mines.mines', soOControlo);
ok('a captura guarda-o na mesma (o HUD tem de saber onde está para te apontar o sítio)',
   rManual.ok === true && rManual.manual === true && !!P.cfg.fields.mines.mines,
   rManual.sel + ' / manual=' + rManual.manual);
igual('e o campo fica registado como «à mão» na configuração', P.cfg.manual['mines.mines'], true);

/* --- 3) o que continua a ser recusado (aceitar tudo seria pior do que recusar) --- */
const divQualquer = fakeElement('div');
divQualquer.nodeType = 1;
divQualquer.textContent = 'Provably fair';
divQualquer.parentElement = document.body;
const vQualquer = P.validarCaptura('mines.mines', divQualquer);
ok('um div sem cara de controlo continua a ser RECUSADO', vQualquer.ok === false, JSON.stringify(vQualquer));
ok('e o motivo diz o que ele viu, em vez de só «não deu»',
   /sem campos lá dentro/.test(vQualquer.motivo || ''), vQualquer.motivo);

/* --- 4) preencher: em vez de escrever, DIZER --- */
global.location.pathname = '/pt/mines';
P.state.cfg.rotation = ['mines 3 2'];
P.state.cursor = 0;
P.cfg.fields = { mines: { stake: '', mines: '#minas-desenhadas' } };
P.cfg.manual = { 'mines.mines': true };
const elDesenhado = fakeElement('div');
elDesenhado.nodeType = 1;
elDesenhado.id = 'minas-desenhadas';
elDesenhado.textContent = '3';
registry['#minas-desenhadas'] = elDesenhado;
const outPreenche = P.preencher();
const minasRes = outPreenche.resultados.filter(r => r.campo === 'nº de minas')[0] || {};
ok('com o nº de minas «à mão», o preenchimento não escreve — diz o número',
   minasRes.manual === true && /ESCOLHE 3/.test(minasRes.instrucao || ''), JSON.stringify(minasRes));
igual('e não toca no controlo do site (zero eventos no elemento)', elDesenhado._events.length, 0);

/* --- 5) o teste do mapa não conta o que não se escreve como falha --- */
const rTesteManual = P.testarMapa();
ok('o teste do mapa não apresenta o nº de minas «à mão» como campo falhado',
   !rTesteManual.campos.some(c => c.campo === 'nº de minas'), JSON.stringify(rTesteManual.campos));
ok('e diz à parte que esse se escolhe à mão, com o número do plano à frente',
   /o nº de minas \(controlo do site: escolhe 3 na lista\)/.test(rTesteManual.naoTestados.join(' ')),
   JSON.stringify(rTesteManual.naoTestados));

/* --- 6) pelo caminho REAL: o painel da captura mostra a nota do que aprendeu --- */
global.location.pathname = '/pt/mines';
P.cfg.manual = {};
const elStake19 = fakeInput('0.30', true); elStake19.nodeType = 1; elStake19.id = 'stake-19';
P.iniciarCaptura();
global.document.elementsFromPoint = () => [elWallet9];
cliqueNaPagina(elWallet9, false);
global.document.elementsFromPoint = () => [elStake19];
cliqueNaPagina(elStake19, false);
global.document.elementsFromPoint = () => [soOControlo];
cliqueNaPagina(soOControlo, false);
ok('o painel MOSTRA a nota do que acabou de aprender (não a guarda só no objecto)',
   /DIZER-TE o número/.test(painelTexto()), painelTexto().slice(0, 260));
ok('e marca o nº de minas como «à mão» na lista do que ficou aprendido',
   /à mão — eu digo-te o número/.test(painelTexto()), painelTexto().slice(0, 420));
ok('e o painel avisou que esse campo não se escreve, em vez de prometer que o escreve',
   P.estadoCaptura().fase === 'passos' && P.estadoCaptura().papel === 'mines.mult');
P.terminarCaptura('teste do controlo do site');

/* ============================== 20. A FILA QUE PARECIA SALTAR PASSOS ============================== */
seccao('[20] A fila curta, o voltar atrás e as opções da lista');

/* --- 1) porque é que a fila tem só dois passos? O painel tem de o dizer --- */
global.location.pathname = '/';
ok('fora de uma página de jogo o painel explica porque só pede duas coisas',
   /Não reconheço este endereço/.test(String(P.captura.motivoFila())), String(P.captura.motivoFila()));
global.location.pathname = '/pt/mines';
igual('numa página reconhecida não há alarme nenhum (e não se inventa um problema)', P.captura.motivoFila(), null);

global.location.pathname = '/';
const elStake20 = fakeInput('0.30', true); elStake20.nodeType = 1; elStake20.id = 'stake-20';
P.iniciarCaptura();
global.document.elementsFromPoint = () => [elWallet9];
cliqueNaPagina(elWallet9, false);
global.document.elementsFromPoint = () => [elStake20];
cliqueNaPagina(elStake20, false);
igual('sem jogo reconhecido, dois cliques esgotam a fila e o painel vai para o teste',
   P.estadoCaptura().fase, 'teste');
ok('e explica porquê, em vez de anunciar um mapa que nunca pediu',
   /Não reconheço este endereço/.test(painelTexto()), painelTexto().slice(0, 400));
ok('o cabeçalho diz a versão (é assim que se sabe se o userscript está actualizado)',
   new RegExp('v' + P.versao.replace(/\./g, '\\.')).test(painelTexto()), painelTexto().slice(0, 160));
ok('e há botões para juntar os campos do jogo que temos aberto',
   /id="capJuntarmines"/.test(painelTexto()) && /id="capJuntardice"/.test(painelTexto()));

const juntoMinas = P.captura.juntar('mines');
igual('juntar os campos das Minas acrescenta os três à fila', juntoMinas.juntados, 3);
igual('e a captura volta a apontar ao primeiro deles', P.estadoCaptura().papel, 'mines.mines');
igual('e volta ao modo de aprendizagem', P.estadoCaptura().fase, 'passos');
global.document.elementsFromPoint = () => [divQualquer];
const evVoltaAoModo = cliqueNaPagina(divQualquer, false);
ok('e a página volta a ser engolida (o modo de aprendizagem está mesmo ligado)',
   evVoltaAoModo.prevenido === true && P.estadoCaptura().papel === 'mines.mines',
   JSON.stringify({ prevenido: evVoltaAoModo.prevenido, papel: P.estadoCaptura().papel }));
igual('juntar outra vez o mesmo jogo não duplica nada', P.captura.juntar('mines').juntados, 0);
ok('e depois de juntar, o botão dos campos das Minas desaparece do painel',
   !/id="capJuntarmines"/.test(painelTexto()), painelTexto().slice(0, 300));

/* --- 2) voltar atrás: o HUD avança sozinho, e um passo a mais tem de ter caminho de volta --- */
P.captura.voltar();
igual('voltar recua um passo em vez de obrigar a repetir tudo', P.estadoCaptura().papel, 'stake');
P.captura.voltar();
P.captura.voltar();
igual('e não recua para lá do primeiro passo', P.estadoCaptura().papel, 'saldo');
ok('o botão de voltar desaparece no primeiro passo (não promete o que não faz)',
   !/id="capVoltar"/.test(painelTexto()), painelTexto().slice(0, 200));
P.terminarCaptura('teste da fila');

/* --- 3) clicar numa OPÇÃO da lista não pode guardar um caminho que desaparece --- */
const caixaGatilho = fakeElement('div');
caixaGatilho.nodeType = 1;
caixaGatilho.id = 'mines-box';
caixaGatilho.getAttribute = k => (k === 'aria-haspopup' ? 'listbox' : (k === 'role' ? 'combobox' : null));
const listaDaCaixa = fakeElement('div');
listaDaCaixa.nodeType = 1;
listaDaCaixa.getAttribute = k => (k === 'role' ? 'listbox' : null);
const opcao3 = fakeElement('div');
opcao3.nodeType = 1;
opcao3.textContent = '3';
opcao3.getAttribute = k => (k === 'role' ? 'option' : null);
listaDaCaixa.appendChild(opcao3);
listaDaCaixa.appendChild(fakeElement('div'));
const areaDoComponente = fakeElement('div');
areaDoComponente.nodeType = 1;
areaDoComponente.appendChild(caixaGatilho);
areaDoComponente.appendChild(listaDaCaixa);
caixaGatilho.parentElement = areaDoComponente;
listaDaCaixa.parentElement = areaDoComponente;
opcao3.parentElement = listaDaCaixa;
areaDoComponente.parentElement = document.body;

const vOpcao = P.validarCaptura('mines.mines', opcao3);
ok('clicar numa opção da lista é aceite — mas guarda a CAIXA que a abre',
   vOpcao.ok === true && vOpcao.alvo === caixaGatilho, vOpcao.nota);
ok('e a nota explica as duas coisas: que era uma opção e o que ficou guardado',
   /OPÇÃO da lista/.test(vOpcao.nota || '') && /CAIXA que abre a lista/.test(vOpcao.nota || ''), vOpcao.nota);
igual('e o que fica guardado é mesmo a caixa, não a opção',
   P.capturarElemento('mines.mines', opcao3).sel, '#mines-box');
igual('e fica «à mão», porque continua a não haver nada para escrever',
   P.cfg.manual['mines.mines'], true);

const listaSozinha = fakeElement('div');
listaSozinha.nodeType = 1;
listaSozinha.getAttribute = k => (k === 'role' ? 'listbox' : null);
const opcaoSemCaixa = fakeElement('div');
opcaoSemCaixa.nodeType = 1;
opcaoSemCaixa.textContent = '5';
opcaoSemCaixa.getAttribute = k => (k === 'role' ? 'option' : null);
listaSozinha.appendChild(opcaoSemCaixa);
listaSozinha.appendChild(fakeElement('div'));
opcaoSemCaixa.parentElement = listaSozinha;
listaSozinha.parentElement = document.body;
const vOpcaoSem = P.validarCaptura('mines.mines', opcaoSemCaixa);
ok('uma opção sem caixa nenhuma à vista é RECUSADA, com o que fazer a seguir',
   vOpcaoSem.ok === false && /OPÇÃO da lista/.test(vOpcaoSem.motivo || '') && /CAIXA que mostra/.test(vOpcaoSem.motivo || ''),
   vOpcaoSem.motivo);
ok('e num div sem cara de nada o HUD continua a recusar (não passou a aceitar tudo)',
   P.validarCaptura('mines.mines', divQualquer).ok === false);
P.cfg.manual = {};

/* --- 4) o HUD a tapar o site: o clique que morria em silêncio --- */
/* Um clique que cai no PANO do painel do HUD não é um clique na ferramenta: é o HUD a tapar o site,
   e o site nunca recebe esse clique. A versão anterior engolia-o sem dizer nada; parecia «recusa». */
global.location.pathname = '/pt/mines';
P.cfg.collapsed = false;
P.iniciarCaptura();
igual('ao entrar em captura o painel do HUD encolhe (deixa de tapar o que vamos clicar)',
   P.cfg.collapsed, true);
shadowDoHud.elementsFromPoint = () => [fakeElement('div')];   // o pano do painel: nada interactivo
const evPano = cliqueNaPagina(elWallet9, true);
ok('um clique no pano do HUD é DENUNCIADO, em vez de engolido em silêncio',
   !!P.estadoCaptura().tapado, JSON.stringify(P.estadoCaptura().tapado));
ok('e o painel diz o que fazer (afastar o painel), em vez de só não acontecer nada',
   /TAPAR/.test(painelTexto()) && /clica outra vez/.test(painelTexto()), painelTexto().slice(-420));
ok('e diz também o que está POR BAIXO do painel — que era o que se queria clicar',
   /por baixo dele está/.test(painelTexto()), painelTexto().slice(-420));
ok('e não aprende nada de um clique que o site não recebeu (nem avança de passo)',
   P.estadoCaptura().papel === 'saldo' && P.estadoCaptura().feito.length === 0);

shadowDoHud.elementsFromPoint = () => [fakeElement('button')];   // um botão do HUD
const evBotao = cliqueNaPagina(elWallet9, true);
ok('um clique num CONTROL0 do HUD não é denúncia nenhuma (os botões continuam a funcionar)',
   !P.estadoCaptura().tapado && !evBotao.prevenido, JSON.stringify(P.estadoCaptura().tapado));

/* Um clique na página limpa a denúncia: a mensagem é sobre o clique anterior, não uma alcatifa. */
global.document.elementsFromPoint = () => [elWallet9];
cliqueNaPagina(elWallet9, false);
ok('e o aviso desaparece assim que uma captura boa acontece',
   !P.estadoCaptura().tapado && P.estadoCaptura().papel === 'stake');
P.terminarCaptura('teste do pano');
igual('ao terminar, o painel do HUD volta ao tamanho que tinha', P.cfg.collapsed, false);
const jaEstavaEncolhido = (() => {
  P.cfg.collapsed = true;
  P.iniciarCaptura();
  const durante = P.cfg.collapsed;
  P.terminarCaptura('teste');
  const depois = P.cfg.collapsed;
  P.cfg.collapsed = false;
  return { durante: durante, depois: depois };
})();
ok('e quem já tinha o HUD encolhido não o vê abrir sozinho por causa da captura',
   jaEstavaEncolhido.durante === true && jaEstavaEncolhido.depois === true,
   JSON.stringify(jaEstavaEncolhido));

/* ============================== RESUMO ============================== */
console.log('\n' + '='.repeat(60));
console.log(falhou === 0 ? `TODOS OS ${passou} TESTES PASSARAM` : `${passou} passaram, ${falhou} FALHARAM`);
console.log('='.repeat(60));
if (avisos.length) console.log('\navisos capturados:\n  ' + avisos.join('\n  '));
process.exit(falhou === 0 ? 0 : 1);
