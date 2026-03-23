#!/bin/bash

# Synodic Services Startup Script (macOS)
# This script launches FalkorDB, Backend, and Frontend in separate windows.

PROJECT_ROOT="/Volumes/ASMT ASM246X Media/univiz/synodic"

echo "------------------------------------------------"
echo "🚀 Starting Synodic Platform..."
echo "------------------------------------------------"

# 1. Ensure FalkorDB is running
echo "📦 Checking FalkorDB (Docker)..."
if [ ! "$(docker ps -q -f name=falkordb)" ]; then
    if [ "$(docker ps -aq -f status=exited -f name=falkordb)" ]; then
        echo "   -> Starting existing falkordb container..."
        docker start falkordb
    else
        echo "   -> Running new falkordb container..."
        docker run -d -p 6379:6379 --name falkordb falkordb/falkordb
    fi
else
    echo "   -> FalkorDB is already running."
fi

# 2. Launch Backend (FastAPI) in a new Terminal window
echo "⚙️  Launching Backend..."
osascript <<EOF
tell application "Terminal"
    do script "cd '$PROJECT_ROOT' && source .venv/bin/activate && GRAPH_PROVIDER=falkordb uvicorn backend.app.main:app --port 8001 --reload"
end tell
EOF

# 3. Launch Frontend (Vite) in a new Terminal window
echo "💻 Launching Frontend..."
osascript <<EOF
tell application "Terminal"
    do script "cd '$PROJECT_ROOT/frontend' && npm run dev"
end tell
EOF

echo "------------------------------------------------"
echo "✅ All services initiated."
echo "   - Backend: http://localhost:8001/docs"
echo "   - Frontend: http://localhost:5173"
echo "------------------------------------------------"
