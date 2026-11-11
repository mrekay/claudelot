@echo off
rem Starts Claudelot without leaving a console window open.
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
