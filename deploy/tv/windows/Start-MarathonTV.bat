@echo off
REM ============================================================================
REM  Marathon TV launcher - opens the queue board full-screen with the pickup
REM  voice on, and keeps it open (reopens after a crash, restarts nightly).
REM  Install-Startup.bat makes this run at every login.
REM ============================================================================
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0MarathonTV-Launch.ps1"
