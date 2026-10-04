@echo off
rem Starts gtnh-agent playing on the live server and listening for its owners' commands
rem (cli play --live --listen), for up to 8 hours, in this window. Start the server first.
rem   In game: whisper the bot (/tell <bot> !help) or say "!help" in chat; !stop pauses it.
rem   Elsewhere: "corepack pnpm cli command ""!status""" queues a command for it.
rem   To stop it: Ctrl+C here, or "corepack pnpm cli halt" (then "cli unhalt" before the next run).
rem Settings (owners, abilities) come from .env; see .env.example and README.md.
cd /d "%~dp0.."
title gtnh-agent: playing and listening
call corepack pnpm cli play --live --listen --minutes 480
pause
