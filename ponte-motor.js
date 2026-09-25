/**
 * Ponte de paridade: corre o motor REAL do userscript em Node e imprime os números em JSON.
 *
 * Existe por uma razão só: o vigia-500 é um PORTE em Python do motor que vive em
 * `painel-500.user.js`. Dois motores para a mesma decisão divergem em silêncio — e uma
 * recomendação errada nas Minas custa dinheiro a sério. Aqui não se testa o Python contra
 * valores escritos à mão: testa-se contra o motor que já está em produção no HUD.
 *
 * Uso:  node ponte-motor.js            -> JSON para o stdout
 */

const fs = require('fs');
const path = require('path');

// --- stub mínimo de browser (o mesmo padrão do teste-hud.js, reduzido ao que o motor precisa) ---
const anyProxy = new Proxy(function () {}, {
  get(t, k) {
    if (k === Symbol.toPrimitive) return () => '';
    if (k === 'then') return undefined;
    if (k === 'toString') return () => '';
    if (k === 'length') return 0;
    return anyProxy;
  },
  set() { return true; },
  apply() { return anyProxy; }
});

global.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, __PAINEL500_HUD__: undefined };
global.document = {
  readyState: 'complete',
  body: anyProxy, documentElement: anyProxy,
  createElement: () => anyProxy,
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
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
global.setInterval = () => 0;
global.clearInterval = () => {};
global.location = { pathname: '/', href: 'https://csgo500.com/' };

/* O userscript escreve uma linha de arranque no console. Aqui isso sujaria o JSON, por isso o
   console.log fica em silêncio durante o carregamento — e volta depois. */
const logReal = console.log;
console.log = () => {};
const src = fs.readFileSync(path.join(__dirname, 'painel-500.user.js'), 'utf8');
new Function('window', 'document', 'localStorage', 'CSS', 'setInterval', 'clearInterval', 'alert', 'confirm', src)(
  global.window, global.document, global.localStorage, global.CSS,
  global.setInterval, global.clearInterval, global.alert, global.confirm
);

console.log = logReal;
const P = global.window.PAINEL500;
if (!P) { console.error('o userscript não expôs PAINEL500'); process.exit(1); }

/* --- as mesmas entradas que o teste em Python usa --- */
const formatos = ['199 999,91 USD', '5 805,80', '398,02', '1 177,30', '0,72 USD', '22,00',
                  '5,805.80 USD', '1.234,56', '1,234.56', '5.80 USD', '1.234', '', 'abc',
                  '−3,50 USD', '-0,30'];

const rot = P.rot().map(r => ({ label: r.label, game: r.game, mult: r.mult, winChance: r.winChance,
                                mines: r.mines || 0, tiles: r.tiles || 0 }));

const reversos = [];
for (const minas of [1, 2, 3, 5, 10, 24]) {
  for (const mult of [1.01, 1.13, 1.29, 1.5, 2, 3.7, 12.5]) {
    if (25 - minas >= 0) reversos.push([minas, mult, P.reverterCasas(minas, mult, 0.01)]);
  }
}

const multiplicadores = [];
for (const minas of [1, 3, 5, 24]) {
  for (const casas of [0, 1, 2, 3]) {
    if (casas <= 25 - minas) {
      const p = P.parse ? null : null;
      multiplicadores.push([minas, casas, (1 - 0.01) / (comb(25 - minas, casas) / comb(25, casas))]);
    }
  }
}
function comb(n, k) { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); }

const jogos = Object.keys(P.jogos).map(k => ({ chave: k, edge: P.jogos[k].edge, nome: P.jogos[k].nome, tipo: P.jogos[k].tipo }));

process.stdout.write(JSON.stringify({
  versao: P.versao,
  parse: formatos.map(f => [f, P.parse(f)]),
  rotacao: rot,
  reversos: reversos,
  multiplicadores: multiplicadores,
  jogos: jogos,
  textoDaAposta: [0.3, 0.005, 2, 0.1].map(v => [v, P.textoDaAposta(v)]),
}, null, 1));
