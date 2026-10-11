@echo off
setlocal
set "PATHEXT=.COM;.EXE;.BAT;.CMD"
cd /d "%~dp0"
title Atlas Soft Water - ERP et POS Traitement d'Eau
echo ===============================================================================
echo            ATLAS SOFT WATER - ERP, CAISSE POS ET SAV
echo             Logiciel Commercial Specialise Traitement d'Eau
echo ===============================================================================
echo.

echo [1/3] Verification de l'environnement Node.js...
where node.exe >nul 2>nul
if errorlevel 1 goto NoNode

if exist "node_modules\vite\bin\vite.js" goto StartApp
echo [2/3] Premier lancement detecte : Installation des dependances npm...
call npm.cmd install --legacy-peer-deps
if errorlevel 1 goto NpmError

:StartApp
echo.
echo [2/3] Preparation de la fenetre autonome (Mode Application)...
start "" cmd /c "timeout /t 3 /nobreak >nul & start msedge.exe --app=http://localhost:3000 --start-maximized 2>nul || start chrome.exe --app=http://localhost:3000 --start-maximized 2>nul || start http://localhost:3000"

echo [3/3] Demarrage du serveur local Atlas Soft Water (http://localhost:3000)...
echo.
echo IMPORTANT : Gardez cette fenetre ouverte pendant l'utilisation de l'application.
echo Appuyez sur Ctrl+C dans cette fenetre pour arreter le serveur.
echo ===============================================================================
echo.
if exist "node_modules\tsx\dist\cli.mjs" (
    node.exe "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0server.ts"
) else (
    node.exe "%~dp0node_modules\vite\bin\vite.js" --port=3000 --host=0.0.0.0
)
if errorlevel 1 goto DevError
goto End

:NoNode
echo.
echo [ERREUR] Node.js n'est pas installe ou introuvable dans le PATH Windows.
echo Veuillez telecharger et installer Node.js (LTS) depuis : https://nodejs.org/
echo Puis relancez Demarrer.bat
goto End

:NpmError
echo.
echo [ERREUR] Echec de l'installation des dependances (npm install).
echo Verifiez votre connexion Internet et reessayez.
goto End

:DevError
echo.
echo [ERREUR] Le serveur local s'est arrete avec une erreur.
goto End

:End
echo.
echo Appuyez sur une touche pour fermer cette fenetre...
pause >nul
