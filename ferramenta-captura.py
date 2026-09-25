"""ferramenta-captura.py — tirar um PNG de uma página e as coordenadas dos elementos.

Para que serve, dito sem rodeios: o vigia-500 lê PIXELS, e para o testar é preciso uma imagem
com números dentro. Esta ferramenta renderiza a página da demo (ou qualquer URL) num browser de
verdade, guarda o PNG e imprime as caixas de alguns elementos (`#wallet`, `#grid`, `#mines-mult`…).

O DOM é usado AQUI e só aqui — para eu saber onde as coisas estão NA IMAGEM de teste. O programa
que lê o ecrã nunca fala com o DOM de casino nenhum: é essa separação que o torna imune às
mudanças do site.

    python ferramenta-captura.py --url http://127.0.0.1:8123/demo-hud.html \
        --saida capturas/demo.png --elementos "#wallet,#grid,#mines-mult" --altura 1000
"""

from __future__ import annotations

import argparse
import json
import os
import sys

def main() -> int:
    p = argparse.ArgumentParser(prog="ferramenta-captura")
    p.add_argument("--url", required=True)
    p.add_argument("--saida", required=True)
    p.add_argument("--elementos", default="#wallet,#grid,#mines-mult")
    p.add_argument("--largura", type=int, default=900)
    p.add_argument("--altura", type=int, default=1000)
    p.add_argument("--espera", type=int, default=1800, help="ms a esperar antes de capturar")
    p.add_argument("--antes", default=None,
                   help="JavaScript a correr antes de capturar (ex.: abrir uma casa das minas)")
    p.add_argument("--texto", action="store_true",
                   help="mede a caixa JUSTA do texto de cada elemento (Range), e não a caixa da div")
    args = p.parse_args()

    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --no-sandbox")
    from PyQt6.QtCore import QTimer, QUrl, QSize
    from PyQt6.QtWidgets import QApplication
    from PyQt6.QtWebEngineWidgets import QWebEngineView

    app = QApplication(sys.argv)
    vista = QWebEngineView()
    vista.resize(QSize(args.largura, args.altura))
    vista.show()
    vista.load(QUrl(args.url))
    resultado: dict = {"url": args.url, "elementos": {}, "saida": args.saida}

    def guardar():
        os.makedirs(os.path.dirname(args.saida) or ".", exist_ok=True)
        img = vista.grab()
        ok = img.save(args.saida)
        resultado["guardado"] = bool(ok)
        resultado["tamanho"] = [img.width(), img.height()]
        print(json.dumps(resultado, ensure_ascii=False, indent=1))
        app.quit()

    def medir():
        seletor = args.elementos
        js = """
        (function(sel, justo){
          const saida = {};
          const zoom = window.devicePixelRatio || 1;
          const caixa = r => [Math.round(r.left*zoom), Math.round(r.top*zoom),
                              Math.round(r.width*zoom), Math.round(r.height*zoom)];
          document.querySelectorAll(sel).forEach(function(el, i){
            const chave = (el.id ? '#' + el.id : sel + '[' + i + ']');
            saida[chave] = caixa(el.getBoundingClientRect());
            if (justo) {
              const faixa = document.createRange();
              faixa.selectNodeContents(el);
              const r = faixa.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) saida[chave + '.texto'] = caixa(r);
            }
          });
          return JSON.stringify(saida);
        })(%s, %s)
        """ % (json.dumps(seletor), 'true' if args.texto else 'false')

        def recebido(texto):
            try:
                resultado["elementos"] = json.loads(texto)
            except Exception as e:
                resultado["elementos"] = {"erro": f"{type(e).__name__}: {e}", "bruto": texto[:200]}
            QTimer.singleShot(250, guardar)

        vista.page().runJavaScript(js, recebido)

    if args.antes:
        QTimer.singleShot(args.espera // 2, lambda: vista.page().runJavaScript(args.antes))
    QTimer.singleShot(args.espera, medir)
    app.exec()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
