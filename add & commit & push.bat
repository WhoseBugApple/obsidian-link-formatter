@ECHO OFF
for /f "usebackq tokens=2 delims=: " %%a in (`chcp`) do (
	IF NOT "%%a" == "65001" (
		CHCP 65001
	)
	GOTO CHCP_BREAK_FOR
)
:CHCP_BREAK_FOR
SET "BAT_DIR=%~dp0"
CD /d "%BAT_DIR%"

REM DATE TIME
	SET "MESSAGE_DATETIME="
		REM deprecated solution
		REM FOR /f "usebackq tokens=2" %%i in (`date^<nul^|findstr /i /c:/`) do (SET "MESSAGE_DATETIME=%%i")
		REM FOR /f "usebackq tokens=2" %%i in (`time^<nul`) do (SET "MESSAGE_DATETIME=%MESSAGE_DATETIME% %%i")
		REM FOR /f "usebackq tokens=1" %%i in (`DATE /t`) do (SET "MESSAGE_DATETIME=%%i")
		REM FOR /f "usebackq tokens=1" %%i in (`TIME /t`) do (SET "MESSAGE_DATETIME=%MESSAGE_DATETIME% %%i")
	FOR /f "usebackq tokens=2, 3" %%i in (`ECHO %DATE% %TIME%`) do (SET "MESSAGE_DATETIME=%%i %%j")
	REM replace / with -
	SET "MESSAGE_DATETIME=%MESSAGE_DATETIME:/=-%"
	REM remove .xx in hour:minute:second.xx
	ECHO %MESSAGE_DATETIME%|FINDSTR /i /c:.>nul
	IF NOT ERRORLEVEL 1 (  REM if no error
		SET "MESSAGE_DATETIME=%MESSAGE_DATETIME:~0,-3%"
	)
	ECHO %MESSAGE_DATETIME%
REM DATE TIME

REM Confirm
	set isRun=y
	@set /p isRun=Confirm running (y/n)(default: y) : 
	if /i "%isRun%"=="y" (
		set isRun=y
	) else (
		exit
	)
REM Confirm

REM Remove Before Add Confirm
	set isRemoveBeforeAdd=n
	@set /p isRemoveBeforeAdd=Remove before add (y/n)(default: n) : 
	if /i "%isRemoveBeforeAdd%"=="n" (
		set isRemoveBeforeAdd=n
	) else (
		set isRemoveBeforeAdd=y
	)
REM Remove Before Add Confirm

if /i "%isRemoveBeforeAdd%"=="y" (
	ECHO git remove
	git rm --cached . -r
	SET "LAST_ERRORLEVEL=%ERRORLEVEL%" & CALL :CHECK_ERROR_LEVEL 2
	ECHO git add
	git add .
	SET "LAST_ERRORLEVEL=%ERRORLEVEL%" & CALL :CHECK_ERROR_LEVEL 1
) else (
	ECHO git add
	git add --all
	SET "LAST_ERRORLEVEL=%ERRORLEVEL%" & CALL :CHECK_ERROR_LEVEL 2
)
ECHO git commit
git commit -m "KORC BACKUP: %MESSAGE_DATETIME%"
SET "LAST_ERRORLEVEL=%ERRORLEVEL%" & CALL :CHECK_ERROR_LEVEL 2
ECHO git push
git push
SET "LAST_ERRORLEVEL=%ERRORLEVEL%" & CALL :CHECK_ERROR_LEVEL 1

IF /i "%1"=="NO_EXIT_WHEN_SUCCESS" (
	CD /d "%BAT_DIR%"
	GOTO EOF
)
ECHO.
ECHO Exit in 10 seconds. Press any key to exit now.
CHOICE /t 10 /d y /n /c abcdefghijklmnopqrstuvwxyz1234567890>nul
EXIT




:: FUNCTIONS
:CHECK_ERROR_LEVEL
	IF %LAST_ERRORLEVEL% GEQ %1 (
		ECHO.
		ECHO Error. Check last step.
		ECHO Error Level %LAST_ERRORLEVEL%
		ECHO.
		CD /d "%BAT_DIR%"
		CMD
		EXIT
	)
	GOTO EOF




:: EOF
:EOF
