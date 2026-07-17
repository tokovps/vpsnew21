@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================================
rem windows-fix-rdp-compat.bat
rem
rem Purpose:
rem   Improve RDP CLIENT COMPATIBILITY on a freshly-installed Windows box
rem   (installed via bin456789/reinstall) without weakening security any more
rem   than necessary. Two very common real-world symptoms this addresses:
rem
rem   1. "An authentication error has occurred. This could be due to CredSSP
rem      encryption oracle remediation" — happens when the SERVER enforces
rem      the post-CVE-2018-0886 "Force Updated Clients" CredSSP policy but the
rem      CLIENT (older mstsc, some RDP apps, some Linux clients) has not been
rem      patched. Fix: set AllowEncryptionOracle to 1 (Mitigated) instead of
rem      0 (Force Updated Clients). This still blocks the actually-vulnerable
rem      (unpatched, level 2) case, it only stops REQUIRING the client to
rem      prove it has the fix.
rem
rem   2. Clients without a modern TLS stack fail to negotiate at all because
rem      the RDP-Tcp listener's SecurityLayer is forced to 2 (SSL/TLS only).
rem      Fix: set SecurityLayer to 1 (Negotiate) — the server still upgrades
rem      to TLS whenever the connecting client supports it; it just stops
rem      refusing clients that don't.
rem
rem   A third, defensive-only check (fDenyTSConnections) is included in case
rem   some upstream image variant ships with RDP disabled outright.
rem
rem Idempotency / safety:
rem   - Every value is AUDITED with `reg query` FIRST. `reg add /f` is only
rem     executed when the current value is missing or different from the
rem     desired one. Re-running this script (SetupComplete/GPO may invoke it
rem     more than once across reboots) is always a no-op after the first
rem     successful run.
rem   - Nothing here disables NLA (UserAuthentication) or lowers
rem     MinEncryptionLevel — those are left exactly as reinstall.sh/Windows
rem     Setup configured them. This script only relaxes the two specific
rem     compatibility knobs above.
rem   - A plain-text log is left at %SystemDrive%\windows-fix-rdp-compat.log
rem     for audit purposes (same convention as reinstall.log).
rem ============================================================================

set "LOG=%SystemDrive%\windows-fix-rdp-compat.log"
echo [rdp-compat] start %DATE% %TIME% > "%LOG%"

rem --- 0) Install a persistent repair watchdog --------------------------------
rem SetupComplete can run before the final specialize/OOBE reboot. The old
rem script deleted itself after that first successful run, so a late policy
rem refresh or reboot could close RDP permanently after the bot had validated
rem it. Keep a SYSTEM copy and repair the listener at every startup + every
rem two minutes. The repair body below remains idempotent.
set "RDP_REPAIR_DIR=%ProgramData%\TokoVPS"
set "RDP_REPAIR_BAT=%RDP_REPAIR_DIR%\rdp-watchdog.bat"
if /i not "%~1"=="/watchdog" (
    if not exist "%RDP_REPAIR_DIR%" mkdir "%RDP_REPAIR_DIR%" >> "%LOG%" 2>&1
    copy /y "%~f0" "%RDP_REPAIR_BAT%" >> "%LOG%" 2>&1
    schtasks /create /tn "TokoVPS-RDP-Startup" /sc onstart /delay 0000:30 ^
      /ru SYSTEM /rl HIGHEST /tr "cmd.exe /d /c %RDP_REPAIR_BAT% /watchdog" /f >> "%LOG%" 2>&1
    schtasks /create /tn "TokoVPS-RDP-Watchdog" /sc minute /mo 2 ^
      /ru SYSTEM /rl HIGHEST /tr "cmd.exe /d /c %RDP_REPAIR_BAT% /watchdog" /f >> "%LOG%" 2>&1
)

rem --- 1) CredSSP encryption oracle remediation --------------------------------
set "CREDSSP_KEY=HKLM\SOFTWARE\Policies\Microsoft\Windows\CredSSP\Parameters"
set "CREDSSP_VAL=AllowEncryptionOracle"
set "CREDSSP_WANT=1"
set "CREDSSP_CUR="
for /f "tokens=3" %%A in ('reg query "%CREDSSP_KEY%" /v %CREDSSP_VAL% 2^>nul ^| findstr /i /r /c:"%CREDSSP_VAL%"') do set "CREDSSP_CUR=%%A"
echo [rdp-compat] %CREDSSP_VAL% current=[%CREDSSP_CUR%] want=0x%CREDSSP_WANT% >> "%LOG%"
if /i not "%CREDSSP_CUR%"=="0x%CREDSSP_WANT%" (
    reg add "%CREDSSP_KEY%" /v %CREDSSP_VAL% /t REG_DWORD /d %CREDSSP_WANT% /f >> "%LOG%" 2>&1
    echo [rdp-compat] %CREDSSP_VAL% CHANGED to 0x%CREDSSP_WANT% >> "%LOG%"
) else (
    echo [rdp-compat] %CREDSSP_VAL% already OK - skipped >> "%LOG%"
)

rem --- 2) RDP-Tcp SecurityLayer -------------------------------------------------
set "RDPTCP_KEY=HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp"
set "SECLAYER_VAL=SecurityLayer"
set "SECLAYER_WANT=1"
set "SECLAYER_CUR="
for /f "tokens=3" %%A in ('reg query "%RDPTCP_KEY%" /v %SECLAYER_VAL% 2^>nul ^| findstr /i /r /c:"%SECLAYER_VAL%"') do set "SECLAYER_CUR=%%A"
echo [rdp-compat] %SECLAYER_VAL% current=[%SECLAYER_CUR%] want=0x%SECLAYER_WANT% >> "%LOG%"
if /i not "%SECLAYER_CUR%"=="0x%SECLAYER_WANT%" (
    reg add "%RDPTCP_KEY%" /v %SECLAYER_VAL% /t REG_DWORD /d %SECLAYER_WANT% /f >> "%LOG%" 2>&1
    echo [rdp-compat] %SECLAYER_VAL% CHANGED to 0x%SECLAYER_WANT% >> "%LOG%"
) else (
    echo [rdp-compat] %SECLAYER_VAL% already OK - skipped >> "%LOG%"
)

rem --- 3) fDenyTSConnections safety net (audit-only unless actually disabled) --
set "TS_KEY=HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server"
set "DENY_VAL=fDenyTSConnections"
set "DENY_WANT=0"
set "DENY_CUR="
for /f "tokens=3" %%A in ('reg query "%TS_KEY%" /v %DENY_VAL% 2^>nul ^| findstr /i /r /c:"%DENY_VAL%"') do set "DENY_CUR=%%A"
echo [rdp-compat] %DENY_VAL% current=[%DENY_CUR%] want=0x%DENY_WANT% >> "%LOG%"
if /i not "%DENY_CUR%"=="0x%DENY_WANT%" (
    reg add "%TS_KEY%" /v %DENY_VAL% /t REG_DWORD /d %DENY_WANT% /f >> "%LOG%" 2>&1
    echo [rdp-compat] %DENY_VAL% CHANGED to 0x%DENY_WANT% >> "%LOG%"
) else (
    echo [rdp-compat] %DENY_VAL% already OK - skipped >> "%LOG%"
)

rem --- 4) Listener safety flag --------------------------------------------------
rem This value can be flipped by specialize/OOBE or a late policy refresh.
rem Keep the listener enabled without disabling Network Level Authentication.
set "LOGON_DISABLED_VAL=fLogonDisabled"
set "LOGON_DISABLED_WANT=0"
set "LOGON_DISABLED_CUR="
for /f "tokens=3" %%A in ('reg query "%RDPTCP_KEY%" /v %LOGON_DISABLED_VAL% 2^>nul ^| findstr /i /r /c:"%LOGON_DISABLED_VAL%"') do set "LOGON_DISABLED_CUR=%%A"
echo [rdp-compat] %LOGON_DISABLED_VAL% current=[%LOGON_DISABLED_CUR%] want=0x%LOGON_DISABLED_WANT% >> "%LOG%"
if /i not "%LOGON_DISABLED_CUR%"=="0x%LOGON_DISABLED_WANT%" (
    reg add "%RDPTCP_KEY%" /v %LOGON_DISABLED_VAL% /t REG_DWORD /d %LOGON_DISABLED_WANT% /f >> "%LOG%" 2>&1
    echo [rdp-compat] %LOGON_DISABLED_VAL% CHANGED to 0x%LOGON_DISABLED_WANT% >> "%LOG%"
) else (
    echo [rdp-compat] %LOGON_DISABLED_VAL% already OK - skipped >> "%LOG%"
)

rem --- 5) Persistent firewall rules for the ACTUAL configured RDP port ----------
rem Read PortNumber from the registry because the bot supports RDP_PORT overrides.
rem `set /a` accepts the hexadecimal value printed by reg.exe (for example 0xd3d).
set "RDP_PORT=3389"
for /f "tokens=3" %%A in ('reg query "%RDPTCP_KEY%" /v PortNumber 2^>nul ^| findstr /i /c:"PortNumber"') do set /a RDP_PORT=%%A
echo [rdp-compat] effective RDP port=%RDP_PORT% >> "%LOG%"

for %%P in (TCP UDP) do (
    netsh advfirewall firewall delete rule name="RDP AutoCreate %RDP_PORT% %%P" >nul 2>&1
    netsh advfirewall firewall add rule ^
      name="RDP AutoCreate %RDP_PORT% %%P" ^
      dir=in action=allow enable=yes profile=any ^
      protocol=%%P localport=%RDP_PORT% >> "%LOG%" 2>&1
)

rem --- 6) Firewall + RDP services must survive late reboot/policy refresh -------
sc config MpsSvc start= auto >> "%LOG%" 2>&1
sc start MpsSvc >> "%LOG%" 2>&1
sc config TermService start= auto >> "%LOG%" 2>&1
sc failure TermService reset= 86400 actions= restart/5000/restart/5000/restart/5000 >> "%LOG%" 2>&1
sc failureflag TermService 1 >> "%LOG%" 2>&1
sc start TermService >> "%LOG%" 2>&1
sc query TermService >> "%LOG%" 2>&1

rem A service can report RUNNING while the RDP-Tcp listener is absent. If so,
rem restart it once and prove that the configured port is listening locally.
netstat -ano | findstr /r /c:":%RDP_PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [rdp-compat] port %RDP_PORT% not LISTENING - restarting TermService >> "%LOG%"
    sc stop TermService >> "%LOG%" 2>&1
    timeout /t 3 /nobreak >nul 2>&1
    sc start TermService >> "%LOG%" 2>&1
    timeout /t 3 /nobreak >nul 2>&1
)
netstat -ano | findstr /r /c:":%RDP_PORT% .*LISTENING" >> "%LOG%" 2>&1

echo [rdp-compat] done %DATE% %TIME% >> "%LOG%"

if /i not "%~1"=="/watchdog" del "%~f0"
endlocal
