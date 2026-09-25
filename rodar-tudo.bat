@echo off
REM rodar-tudo.bat — corre TUDO de uma vez, com o máximo de logs
REM Usa fixtures (sem precisar abrir o site) + testes unitários + vigia com --debug
setlocal
set PYTHONIOENCODING=utf-8
mkdir capturas 2>nul

echo ============================================================
echo [1/4] teste-vigia.py  (209 testes)
echo ============================================================
python teste-vigia.py
if errorlevel 1 goto :erro

echo.
echo ============================================================
echo [2/4] teste-hud.js  (414 testes)
echo ============================================================
node teste-hud.js
if errorlevel 1 goto :erro

echo.
echo ============================================================
echo [3/4] vigia ver --png  (debug maximo em stderr + capturas/vigia-debug.log)
echo ============================================================
python vigia-500.py ver --png capturas/demo.png --debug --ascii 2>&1 | more

echo.
echo ============================================================
echo [4/4] vigia ler --png demo-3abertas.png  (ciclo completo, debug maximo)
echo ============================================================
python vigia-500.py ler --png capturas/demo-3abertas.png --debug --sem-perguntas

echo.
echo ============================================================
echo TUDO PASSOU  — logs em capturas/vigia-debug.log
echo Para o MODO REAL (com o site aberto):  python vigia-500.py --debug
echo ============================================================
goto :eof
:erro
echo.
echo FALHOU — ve o erro acima
exit /b 1
