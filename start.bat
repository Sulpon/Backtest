@echo off
REM Starts both servers the terminal needs and opens the app in your browser.
REM Just double-click this file. Leave the two windows it opens running in
REM the background - closing either one stops that server (and the charts
REM stop loading again).

cd /d "%~dp0"

start "Backtest - Backend (port 8000)" cmd /k "cd terminal\backend && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
start "Backtest - Frontend (port 5173)" cmd /k "cd terminal && npm run dev"

timeout /t 4 /nobreak >nul
start "" "http://localhost:5173"
