#!/bin/sh
# Rebuild and restart `vite preview` on 5175 (Windows / Git Bash).
cd "$(dirname "$0")/.."
pid=$(netstat -ano | grep ':5175 ' | grep LISTENING | awk '{print $5}' | head -1)
[ -n "$pid" ] && taskkill //PID "$pid" //F > /dev/null
npm run build 2>&1 | grep -E 'error|\.js ' 
(npm run preview > /dev/null 2>&1 &)
sleep 3
