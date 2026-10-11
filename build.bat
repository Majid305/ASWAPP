@echo off
setlocal
set "PATHEXT=.COM;.EXE;.BAT;.CMD"
cd /d "%~dp0"
title Atlas Soft Water - Windows Desktop Builder
echo ===============================================================================
echo            ATLAS SOFT WATER - GENERATEUR EXECUTABLE WINDOWS
echo                      Gestion Commerciale, Caisse POS et SAV
echo ===============================================================================
echo.

:: 1. Verifier Node.js
echo [1/3] Verification de l'environnement Node.js...
where node.exe >nul 2>nul
if errorlevel 1 goto NoNode

:: 2. Verifier si les modules sont installes
if exist "node_modules\vite\bin\vite.js" goto DoBuild
echo [*] Installation des dependances npm...
call npm.cmd install --legacy-peer-deps
if errorlevel 1 goto NpmError

:DoBuild
:: 3. Compiler la web app
echo.
echo [2/3] Compilation de l'application (Vite Build)...
node.exe "%~dp0node_modules\vite\bin\vite.js" build
if errorlevel 1 goto BuildError
if not exist "dist\index.html" goto DistMissing
echo [OK] Dossier dist compile avec succes.
echo.

:: 4. Compiler l'executable C# Windows
echo [3/3] Creation de l'executable Windows AtlasSoftWater.exe...
set "CSC_EXE="
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
    set "CSC_EXE=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
)
if "%CSC_EXE%"=="" (
    if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
        set "CSC_EXE=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    )
)
if "%CSC_EXE%"=="" goto NoCsc

echo [*] Compilation de l'executable avec csc.exe...
"%CSC_EXE%" /target:winexe /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:"AtlasSoftWater.exe" "desktop\launcher.cs" >nul 2>&1
if not exist "AtlasSoftWater.exe" goto CompileFailed

echo.
echo ===============================================================================
echo   SUCCES : AtlasSoftWater.exe a ete genere avec succes !
echo ===============================================================================
echo.
echo Vous pouvez desormais double-cliquer directement sur :
echo   AtlasSoftWater.exe (ou sur Demarrer.bat)
echo.
echo Ce fichier ouvre l'application dans sa fenetre autonome de bureau (Local-First).
echo.
goto AskRun

:NoCsc
echo [!] Compilateur .NET non detecte. Utilisation du lanceur Demarrer.bat...
goto AskRun

:CompileFailed
echo [!] Compilation C# ignoree. Utilisation du lanceur Demarrer.bat...
goto AskRun

:AskRun
echo Voulez-vous lancer l'application maintenant ?
set /p RUN_NOW="Taper O pour Oui ou N pour Non : "
if /i "%RUN_NOW%"=="O" goto LaunchApp
goto End

:LaunchApp
if exist "AtlasSoftWater.exe" (
    start "" "AtlasSoftWater.exe"
) else (
    start "" "Demarrer.bat"
)
echo Application lancee.
goto End

:NoNode
echo.
echo [ERREUR] Node.js n'a pas ete detecte sur ce PC Windows.
echo Veuillez telecharger et installer Node.js depuis : https://nodejs.org/
echo Puis relancez build.bat
goto End

:NpmError
echo.
echo [ERREUR] L'installation npm install a echoue.
goto End

:BuildError
echo.
echo [ERREUR] La compilation npm run build a echoue.
goto End

:DistMissing
echo.
echo [ERREUR] Le dossier dist/index.html n'a pas ete genere.
goto End

:End
echo.
echo Appuyez sur une touche pour fermer...
pause >nul
