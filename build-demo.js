/* build-demo.js — gera demo-hud.html a partir de mock-casino.html + painel-500.user.js.
 *
 * Porquê existir: o mock carrega o userscript por <script src>, o que só funciona se os
 * dois ficheiros forem servidos do mesmo sítio. Em ambientes que servem UM ficheiro só
 * (é o caso do preview desta app) o src dá 404 e a demo fica em branco. Inlinar resolve
 * isso sem duplicar o userscript: a fonte continua a ser um único ficheiro, e esta demo
 * é regenerável a qualquer momento.
 *
 *   node build-demo.js
 */
const fs = require('fs');
const path = require('path');

const MOCK = path.join(__dirname, 'mock-casino.html');
const USER = path.join(__dirname, 'painel-500.user.js');
const OUT = path.join(__dirname, 'demo-hud.html');

const mock = fs.readFileSync(MOCK, 'utf8');
const user = fs.readFileSync(USER, 'utf8');
const linhasUser = user.split('\n').length;
const linhasMock = mock.split('\n').length;

const TAG = '<script src="painel-500.user.js"></script>';
if (mock.indexOf(TAG) === -1) {
  console.error('build-demo: o mock já não tem "' + TAG + '". Nada a inlinar.');
  process.exit(1);
}

/* Uma string do userscript poderia conter "</script>" e fechar a tag cedo. */
const seguro = user.replace(/<\/script/gi, '<\\/script');

/* ATENCAO: a substituicao TEM de ser feita com uma FUNCAO, nunca com a string final.
 * String.replace interpreta padroes $ no texto de substituicao, e o userscript contem
 * `+ '$' + Math.abs(...)` — cujo `$'` significa "tudo o que vem depois do match".
 * Com a string directa, o `$'` era expandido e o ficheiro saía cortado a meio, com o
 * resto do userscript colado no fim do documento. A funcao devolve o texto literal. */
const bloco = '<!-- painel-500.user.js inlinado por build-demo.js (' + linhasUser +
              ' linhas). -->\n<script>\n' + seguro + '\n</script>';
const demo = mock.replace(TAG, () => bloco);

/* Verificacao do proprio artefacto: se o bloco inlinado nao for exactamente o que
 * pedimos, o ficheiro fica corrompido e a demo falha em silencio no browser.
 * Falhar aqui é muito mais barato do que descobrir isto a olhar para uma pagina branca. */
if (demo.indexOf(bloco) === -1) {
  console.error('build-demo: o bloco inlinado nao aparece inteiro na saida.');
  process.exit(1);
}
const outrosScripts = (demo.match(/<script/g) || []).length;
if (outrosScripts !== 3) {
  console.error('build-demo: esperava 3 tags <script> na saida, encontrei ' + outrosScripts + '.');
  process.exit(1);
}
/* A unica sequencia que consegue terminar a tag <script> a meio e `</script`. */
const fechos = (seguro.match(/<\/script/gi) || []).length;
if (fechos !== 0) {
  console.error('build-demo: ' + fechos + ' `</script` sem escape dentro do userscript.');
  process.exit(1);
}

fs.writeFileSync(OUT, demo);
console.log('demo-hud.html escrita: ' + demo.split('\n').length + ' linhas ' +
            '(mock ' + linhasMock + ' + userscript ' + linhasUser + ', 1 tag substituída).');
