@echo off
REM ── MealFast one-click push ──────────────────────────────────
REM Place this file inside your cloned repo folder and double-click
REM it after editing your files. It stages all changes, asks for a
REM commit message, commits, and pushes to GitHub (Pages redeploys).

cd /d "%~dp0"

echo.
echo === Changes to be committed ===
git status --short
echo.

set /p msg="Commit message (describe what you changed): "
if "%msg%"=="" set msg=Update MealFast

git add -A
git commit -m "%msg%"
git push

echo.
echo Done. GitHub Pages will redeploy in about 1-2 minutes.
pause
