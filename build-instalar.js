/* build-instalar.js — gera instalar.html, uma página que resolve o problema real de
 * instalação do userscript.
 *
 * Porquê isto existir: abrir um .js do disco (duplo clique) NÃO abre a página de instalação
 * do Tampermonkey — o browser mostra o código como texto e nada acontece. E instalar a
 * partir de file:// é pouco fiável. A alternativa que funciona sempre é copiar o texto
 * completo e colar no editor do Tampermonkey — mas copiar 1000 linhas à mão é onde as
 * pessoas perdem a primeira linha da metadata block (a causa nº1 de "erro de userscript").
 *
 * Esta página dá um botão que copia o ficheiro EXACTO, e verifica que o que está na página
 * é byte-a-byte o que está no ficheiro: um hash calculado igual dos dois lados.
 *
 *   node build-instalar.js
 */
const fs = require('fs');
const path = require('path');

const USER = path.join(__dirname, 'painel-500.user.js');
const OUT = path.join(__dirname, 'instalar.html');

const user = fs.readFileSync(USER, 'utf8');
/* O ficheiro está em CRLF, mas `.value` de um <textarea> NORMALIZA as quebras de linha
 * para LF (é o que a especificação diz, não é um bug do browser). O texto que o botão
 * copia é portanto o conteúdo com LF — que é exactamente o que o Tampermonkey quer.
 * O hash tem de ser calculado sobre a mesma coisa dos dois lados, senão a verificação
 * de integridade acusa corrupção onde só há duas convenções de fim de linha. */
const userNormalizado = user.replace(/\r\n/g, '\n');
const linhas = userNormalizado.split('\n').length;

/* Hash igual ao da página (djb2). Serve para provar, sem bibliotecas, que o texto copiado
 * é o mesmo do ficheiro — se alguém editar o html à mão, isto passa a falhar. */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* A metadata block TEM de começar na primeira linha, sem BOM e sem nada antes — é a causa
 * mais comum de "não instala". Falhar aqui é melhor do que descobrir no browser. */
const problemas = [];
if (!user.startsWith('// ==UserScript==')) problemas.push('a metadata block não está na linha 1');
if (user.charCodeAt(0) === 0xFEFF) problemas.push('o ficheiro começa com BOM');
if (!/\/\/ ==\/UserScript==/.test(user)) problemas.push('falta o fecho // ==/UserScript==');
['@name', '@version', '@match', '@grant'].forEach(k => {
  if (user.indexOf('// ' + k) === -1) problemas.push('falta ' + k);
});
if (problemas.length) {
  console.error('build-instalar: a metadata do userscript tem problemas:\n  - ' + problemas.join('\n  - '));
  process.exit(1);
}

const h = hash(userNormalizado);
/* Dentro de um <textarea> o conteudo e RCDATA: as referencias de caracter SÃO descodificadas,
   por isso `&` tem de virar `&amp;` e `<` tem de virar `&lt;`. O .value devolve o texto
   original — é o parser que desfaz o escape, e é por isso que o hash dos dois lados bate. */
const escapado = userNormalizado.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/* O userscript contém `</textarea` no seu próprio HTML de configuração (o campo da
 * rotação). Dentro de um <textarea> isso fecharia a caixa a meio — e o texto copiado
 * ficaria truncado, em silêncio. Por isso é que se escapa `<`, e por isso é que se
 * verifica depois de escapar, não antes. */
['</textarea', '</script', '</pre'].forEach(t => {
  if (escapado.indexOf(t) !== -1) problemas.push('o texto escapado ainda contém ' + t);
});
if (problemas.length) {
  console.error('build-instalar: o texto a copiar ficaria truncado:\n  - ' + problemas.join('\n  - '));
  process.exit(1);
}
const versao = (/\/\/ @version\s+(\S+)/.exec(user) || [, '?'])[1];
const matches = (user.match(/^\/\/ @match\s+(\S+)/gm) || []).map(l => l.split(/\s+/)[2]);

const html = `<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<title>Instalar o HUD — Sessão 500</title>
<style>
  :root{ color-scheme:dark }
  body{margin:0;background:#141220;color:#e8e6f0;font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;padding:26px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:21px;margin:0 0 4px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:1.3px;color:#f5c451;margin:26px 0 8px}
  .sub{color:#8b8798;font-size:13.5px;margin-bottom:8px}
  .card{background:#1b1826;border:1px solid #2e2a3f;border-radius:12px;padding:18px;margin-bottom:14px}
  ol,ul{margin:8px 0 0;padding-left:22px}
  li{margin:5px 0}
  code,kbd{background:#232032;padding:2px 6px;border-radius:5px;font:12.5px ui-monospace,monospace;color:#e8e6f0}
  button{font:600 14px/1 inherit;color:#e8e6f0;background:#232032;border:1px solid #2e2a3f;border-radius:9px;
         padding:12px 16px;cursor:pointer;margin:6px 6px 0 0}
  button:hover{border-color:#4a4463}
  .primaria{background:#3ddc97;border-color:#3ddc97;color:#0f2a1f;font-weight:700;font-size:15px;padding:14px 18px}
  .flag{font-size:13px;border-radius:9px;padding:10px 12px;margin-top:10px;border:1px solid #2e2a3f}
  .flag.ok{border-color:#3ddc97;color:#bff0dc;background:rgba(61,220,151,.08)}
  .flag.bad{border-color:#ff6b6b;color:#ffd0d0;background:rgba(255,107,107,.08)}
  .flag.warn{border-color:#f5c451;color:#f7e2b0;background:rgba(245,196,81,.08)}
  textarea{width:100%;height:190px;background:#111020;color:#b9b4c9;border:1px solid #2e2a3f;border-radius:10px;
           font:12px/1.5 ui-monospace,monospace;padding:10px;box-sizing:border-box}
  details{margin-top:14px}
  summary{cursor:pointer;color:#8b8798;font-size:13px}
  table{border-collapse:collapse;font-size:13.5px;width:100%}
  td{padding:5px 8px 5px 0;border-bottom:1px solid #262238;vertical-align:top}
  td:first-child{color:#8b8798;white-space:nowrap}
  .k{color:#3ddc97;font-weight:700}
  .n{color:#ff8fa3}
</style>
</head>
<body>
<div class="wrap">
  <h1>Instalar o HUD — Sessão 500</h1>
  <div class="sub">Versão ${versao} · ${linhas} linhas · zero dependências. Lê o saldo, detecta rondas e o jogo,
  recomenda a jogada e aplica travões. <b>Nunca aposta.</b></div>

  <div class="card">
    <h2 style="margin-top:0">Porque é que o ficheiro não instalou</h2>
    <div class="sub" style="margin-bottom:6px">Se abriste o <code>.user.js</code> com duplo clique, o browser limitou-se a
    <i>mostrar</i> o código como texto — o Tampermonkey só oferece instalação quando o URL termina em
    <code>.user.js</code> e vem por <code>http://</code> ou <code>https://</code>. A partir de
    <code>file:///</code> isso é pouco fiável, e é a razão mais provável para não ter aparecido
    nenhum botão de instalar.</div>
    <div class="sub" style="margin-top:8px">Se apareceu um erro <b>ao guardar</b>, há três causas
    possíveis, por ordem de frequência: a primeira linha do texto colado deixou de ser
    <code>// ==UserScript==</code>; colaste num campo que não é o editor; ou estás a usar
    <b>Utilitários → Importar</b>, que só aceita backups.</div>
    <table>
      <tr><td>Não uses</td><td><b>Utilitários → Importar</b> — isso é só para backups <code>.zip</code>/<code>.json</code>, e dá erro com um <code>.js</code></td></tr>
      <tr><td>Não uses</td><td>Editar o ficheiro à mão em vez de copiar: perder a primeira linha
      (<code>// ==UserScript==</code>) é a causa nº1 de «userscript inválido»</td></tr>
    </table>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Passo 1 — O método que funciona sempre</h2>
    <ol>
      <li>Abre o <b>painel de controlo</b> do Tampermonkey (ícone da extensão → <b>Dashboard</b>).</li>
      <li>No separador <b>Installed</b>, clica no <b><code>+</code></b> (canto superior direito) — <i>Create a new script</i>.</li>
      <li>No editor, <kbd>Ctrl</kbd>+<kbd>A</kbd> e <kbd>Delete</kbd>, para tirar o script de exemplo que ele põe lá.</li>
      <li>Carrega no botão grande aqui em baixo, volta ao editor e cola com <kbd>Ctrl</kbd>+<kbd>V</kbd>.</li>
      <li>Guarda com <kbd>Ctrl</kbd>+<kbd>S</kbd>. Confirma que a primeira linha do editor continua a ser <code>// ==UserScript==</code> — se o texto colado começar a meio, foi a cópia que falhou.</li>
    </ol>
    <button class="primaria" id="copiar">📋 Copiar o script completo (${linhas} linhas)</button>
    <div id="estado"></div>
    <details>
      <summary>Se a cópia automática não funcionar: seleccionar à mão</summary>
      <p class="sub">Clica dentro da caixa abaixo, <kbd>Ctrl</kbd>+<kbd>A</kbd>, <kbd>Ctrl</kbd>+<kbd>C</kbd>.</p>
      <textarea id="fonte" spellcheck="false" readonly>${escapado}</textarea>
    </details>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Passo 2 — Alternativa: instalar por URL (mais limpa)</h2>
    <div class="sub">Num terminal, nesta pasta (ou <code>bash servidor.sh</code>, que faz o mesmo e mostra os
    endereços):</div>
    <div><code>python3 -m http.server 8123 --bind 127.0.0.1</code></div>
    <div class="sub" style="margin-top:8px">e abre no browser:</div>
    <div><code>http://127.0.0.1:8123/painel-500.user.js</code></div>
    <div class="sub" style="margin-top:8px">Como o URL termina em <code>.user.js</code>, o Tampermonkey mostra a
    página de instalação dele. Para parar o servidor: <kbd>Ctrl</kbd>+<kbd>C</kbd> no terminal onde corre, ou
    <code>bash parar-servidor.sh</code> a partir de qualquer terminal.</div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Passo 2b — Sem Tampermonkey nenhum (via consola)</h2>
    <div class="sub">Dá para usar o HUD sem instalar extensão nenhuma. O script não usa nenhuma API do
    Tampermonkey (<code>@grant none</code>), por isso corre igual dentro da consola do browser:</div>
    <ol>
      <li>Abre o csgo500.com <b>com a sessão iniciada</b>.</li>
      <li><kbd>F12</kbd> (ou <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>) → separador <b>Console</b>.</li>
      <li>Na primeira vez, o Chrome avisa que colar código no console é perigoso e pede que escrevas
      <code>permitir colagem</code> (ou <code>allow pasting</code>) e primes <kbd>Enter</kbd>. É normal.</li>
      <li>Copia o script com o botão do Passo 1, cola no Console e prime <kbd>Enter</kbd>. O painel aparece.</li>
    </ol>
    <div class="flag warn" style="margin-top:12px">O que perdes sem a extensão: isto deixa de acontecer sozinho.
    <b>A cada recarregamento da página tens de voltar a colar</b> — e ao fechar o browser, também. A extensão existe
    exactamente para não teres esse trabalho.</div>
    <div class="sub" style="margin-top:8px">Vantagem real do método: nada instalado, e é o caminho para
    experimentar antes de decidir. A configuração (stake, rotação, campos ensinados) fica guardada no
    <code>localStorage</code> do site nos dois casos, por isso mudar de método não te faz perder nada.</div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Passo 3 — Ligar o HUD ao site (uma vez)</h2>
    <div class="sub">O script corre em <code>${matches.join('</code> · <code>')}</code>. Entra no csgo500.com com a sessão
    iniciada e abre o painel <b>SESSÃO 500</b>. Depois:</div>
    <ol>
      <li><b>Clicar no saldo no site</b> — para o HUD saber ler o teu saldo. Ele mostra a string crua lida e o valor
      interpretado; confirma que o número está certo.</li>
      <li><b>Valor da aposta</b> — clica no campo do valor, no jogo (serve para Dice e Mines de uma vez).</li>
      <li><b>Nº de minas</b> e <b>multiplicador</b> — nas Minas, os dois campos do ecrã.</li>
      <li><b>Stake fixo</b> (ex.: <code>0.30</code>), <b>orçamento</b> (ex.: <code>5</code>) e a
      <b>rotação</b>, uma por linha: <code>dice 1.5</code>, <code>mines 3 2</code>.</li>
      <li><b>Guardar configuração.</b></li>
    </ol>
    <div class="flag warn" style="margin-top:12px">A primeira vez que ensinas um campo, ele fica guardado no
    <code>localStorage</code> — não voltas a repetir isto.</div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Passo 4 — Como usar durante a sessão</h2>
    <table>
      <tr><td>Painel</td><td>Mostra o jogo detectado, o <b>edge</b> e o que recomenda: <span class="k">APOSTAR 1.10x · $0.30</span>,
        <span class="k">ABRIR MAIS 1</span>, <span class="k">RETIRAR</span>, ou <span class="n">FORA DO PLANO · RETIRAR</span>.</td></tr>
      <tr><td>Preencher</td><td><b>Preencher a configuração no site</b> escreve o valor, o multiplicador e o nº de minas.
        Verifica lendo de volta. <b>O clique em Apostar é teu</b> — e é de propósito.</td></tr>
      <tr><td>Rondas</td><td>Apostas normalmente no site. O HUD detecta o resultado sozinho, pela variação do saldo —
        não tens de registar nada.</td></tr>
      <tr><td>Frenos</td><td>Micro-pausa a cada 25 rondas, cooldown após 5 derrotas seguidas, cooldown após um ganho
        grande, e pausa voluntária no botão.</td></tr>
      <tr><td>Impulso</td><td><b>⚡ Impulso de fugir ao plano</b> regista a vontade em vez de a seguires, e mostra-te o preço
        dela em rondas de sessão.</td></tr>
      <tr><td>Confirmação</td><td>Se algo se portar mal, escreve <code>PAINEL500</code> na consola do browser.</td></tr>
    </table>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Limite de desenho</h2>
    <div class="sub">Faz: ler o saldo · detectar o jogo pelo URL · detectar rondas pela variação de saldo · mostrar edge e
    recomendação · escrever a configuração nos campos e confirmar por leitura de volta · aplicar pausas · exportar.</div>
    <div class="sub" style="margin-top:8px">Não faz: clicar em Apostar · abrir casa ou retirar nas Minas · fazer login ·
    chamar qualquer API · falar com a rede de qualquer forma. Há um teste (<code>node teste-hud.js</code>) que falha se
    alguma dessas proibições for quebrada no código.</div>
  </div>

  <div class="sub" style="text-align:center;margin:22px 0 10px">
    Fonte: <code>painel-500.user.js</code> · hash djb2 <code>${h}</code> · 18+/21+
  </div>
</div>

<script>
  /* Verificacao de integridade dentro da propria pagina: o texto que o botao copia tem de
     dar o MESMO hash que o build calculou sobre o ficheiro. Se alguem editar este html a
     mao, deixa de bater — e mais vale saber isso aqui do que ao colar no Tampermonkey. */
  function hash(s){
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }
  const ESPERADO = '${h}';
  const fonte = document.getElementById('fonte');
  const estado = document.getElementById('estado');

  const obtido = hash(fonte.value);
  if (obtido !== ESPERADO) {
    estado.innerHTML = '<div class="flag bad">O texto nesta página não corresponde ao ficheiro ' +
      '(hash ' + obtido + ' em vez de ' + ESPERADO + '). Não copies: usa a via do URL no Passo 2.</div>';
  }

  document.getElementById('copiar').onclick = () => {
    const t = fonte.value;
    const sucesso = () => {
      estado.innerHTML = '<div class="flag ok">✓ Copiado: ' + t.split('\\n').length + ' linhas, ' + t.length +
        ' caracteres, hash ' + ESPERADO + '. Agora cola no editor do Tampermonkey e guarda com Ctrl+S. ' +
        'Confirma que a primeira linha é <code>// ==UserScript==</code>.</div>';
    };
    const fallback = () => {
      /* execCommand esta obsoleto mas continua a ser o unico caminho sem permissao —
         e aqui e o fallback, nao o caminho principal. */
      try {
        fonte.removeAttribute('readonly');
        fonte.focus(); fonte.select();
        const ok = document.execCommand('copy');
        fonte.setAttribute('readonly', 'readonly');
        if (ok) sucesso();
        else estado.innerHTML = '<div class="flag warn">O browser não deixou copiar automaticamente. ' +
          'A caixa está seleccionada: prime Ctrl+C.</div>';
      } catch (e) {
        estado.innerHTML = '<div class="flag warn">Selecciona o texto da caixa e prime Ctrl+C (' + e.message + ').</div>';
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(sucesso, fallback);
    } else fallback();
  };
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
console.log('instalar.html escrita: ' + html.split('\n').length + ' linhas · userscript v' + versao +
            ' · ' + linhas + ' linhas de codigo · hash ' + h + ' · matches: ' + matches.join(' '));
