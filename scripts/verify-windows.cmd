@echo off
setlocal DisableDelayedExpansion
set "QISHUI_NATIVE_ROOT=%~dp0.."
set "QISHUI_TEST_WINDOWS=1"
set "QISHUI_WINDOWS_RUNNER=%~dp0..\runtime\native\windows-runner.exe"
set "FAILED=0"
"%~dp0..\test\windows-runner.test.exe" -test.v -test.timeout=180s
if errorlevel 1 set "FAILED=1"
"%~dp0..\test\native-worker.test.exe" -test.v -test.timeout=180s
if errorlevel 1 set "FAILED=1"
exit /b %FAILED%
