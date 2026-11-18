@echo off
title LOCAR - Gerador de Atas de Indicadores (DIE)
cd /d "%~dp0"
echo Iniciando servidor local do sistema LOCAR...
python server.py
pause
