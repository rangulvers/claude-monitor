# Claude Code Activity Monitor

Real-time monitoring dashboard for Claude Code sessions. Automatically monitors all Claude Code sessions on the local machine with a beautiful web interface.

## Features

### Core Monitoring
- **Automatic Detection**: Watches Claude's session files - no configuration needed
- **Real-time Updates**: WebSocket-based live monitoring
- **Multiple Sessions**: Track concurrent Claude Code executions
- **Sub-agent Tracking**: See spawned Task agents linked to parent sessions
- **Model & Token Tracking**: Shows which model (Opus/Sonnet/Haiku) and token usage
- **Cost Estimation**: Real-time API cost tracking per session

### Dashboard Features
- **Expandable Session Cards**: Click to see full conversation history
- **Search & Filter**: Filter by status (Active/Idle/Done) or search by prompt
- **Timeline View**: Visual tool execution timeline with duration bars
- **Statistics Panel**: Tool usage charts, token breakdown, model distribution
- **Toast Notifications**: Alerts for session completions and errors
- **Sound Alerts**: Optional audio notifications (toggle in UI)
- **Auto-scroll**: Keep newest activity in view
- **Export JSON**: Download full session data for debugging
- **Copy Session ID**: Quick copy to clipboard

### Session Information
- User prompts and Claude's responses
- Current and historical tool executions (Read, Edit, Bash, Grep, etc.)
- Todo list progress
- Working directory and git branch
- Session duration and tool timing

## Architecture

```
Claude Code → Writes ~/.claude/projects/**/*.jsonl
                ↓
File Watcher (chokidar with polling) → Detects changes
                ↓
Parse JSONL → Extract tools, messages, tokens, sub-agents
                ↓
WebSocket → Update dashboard in real-time
```

## Quick Start

### Option 1: Docker Compose (Recommended)

Create a `docker-compose.yaml`:

```yaml
services:
  claude-monitor:
    build: .
    container_name: claude-monitor
    restart: always
    ports:
      - "3002:3002"
    volumes:
      - ~/.claude:/home/node/.claude:ro
    environment:
      - NODE_ENV=production
      - PORT=3002
      - SESSION_TIMEOUT_MS=300000
      - IDLE_THRESHOLD_MS=30000
```

Then run:

```bash
docker compose up -d --build
```

### Option 2: Run Directly with Node.js

```bash
npm install
node src/server.js
```

### Access the Dashboard

Open your browser to: **http://localhost:3002**

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3002 | HTTP server port |
| `SESSION_TIMEOUT_MS` | 300000 | Remove inactive sessions after 5 minutes |
| `IDLE_THRESHOLD_MS` | 30000 | Mark sessions idle after 30 seconds |
| `MAX_TOOL_HISTORY` | 10 | Tools to keep in history per session |
| `MAX_MESSAGES` | 20 | Messages to keep per session |
| `CLEANUP_INTERVAL_MS` | 60000 | Cleanup check interval |
| `WS_HEARTBEAT_MS` | 30000 | WebSocket heartbeat interval |

## API Endpoints

### Health Check
```bash
curl http://localhost:3002/health
```

```json
{
  "status": "ok",
  "uptime": 123.45,
  "activeSessions": 2,
  "totalSessions": 3
}
```

### Get All Sessions
```bash
curl http://localhost:3002/api/sessions
```

Returns detailed session data including:
- Session ID and status
- Model and token usage
- Conversation history
- Tool execution history
- Sub-agent relationships
- Cost estimates

## Screenshots

The dashboard shows:
- **Header**: Connection status, session counts, total cost
- **Toolbar**: Search, filters, collapse all, auto-scroll, stats toggle, clear
- **Statistics Panel**: Tool usage chart, token breakdown, model usage
- **Session Cards**: Expandable cards with full session details
- **Timeline**: Visual tool execution history with duration bars

## Container Management

```bash
# View logs
docker logs claude-monitor -f

# Restart
docker restart claude-monitor

# Stop
docker compose down

# Rebuild
docker compose up -d --build
```

## Troubleshooting

### No sessions appearing
1. Check Claude directory is mounted:
   ```bash
   docker exec claude-monitor ls -la /home/node/.claude/projects/
   ```
2. Verify Claude is creating session files:
   ```bash
   ls -la ~/.claude/projects/*/*.jsonl
   ```
3. Check logs for errors:
   ```bash
   docker logs claude-monitor | grep -i error
   ```

### Dashboard shows "Disconnected"
- Verify container is running: `docker ps | grep claude-monitor`
- Check health endpoint: `curl http://localhost:3002/health`
- Check container logs for errors

### Sessions not updating
- The monitor uses polling (500ms interval) for Docker volume compatibility
- Check if file watcher is detecting changes in logs

## Project Structure

```
claude-monitor/
├── Dockerfile
├── package.json
├── README.md
└── src/
    ├── server.js           # Express + WebSocket server
    ├── sessionManager.js   # Session state management
    ├── fileWatcher.js      # Claude file monitoring
    ├── streamParser.js     # JSONL parsing utilities
    └── public/
        └── index.html      # Dashboard UI (single-file)
```

## How It Works

1. **File Watching**: Monitors `~/.claude/projects/**/*.jsonl` for new/modified session files
2. **JSONL Parsing**: Extracts message types (user, assistant, tool_use, tool_result, result)
3. **Session Management**: Tracks session state, tools, tokens, and sub-agents in memory
4. **Real-time Updates**: Pushes changes to connected dashboards via WebSocket
5. **Auto-cleanup**: Removes stale sessions after configurable timeout

## Resource Usage

- **Idle**: ~50MB RAM, <1% CPU
- **Active (5 sessions)**: ~150MB RAM, ~5% CPU
- **Docker image**: ~100MB

## Security Notes

- All data is in-memory only (no persistence)
- Read-only access to Claude's session files
- No authentication (designed for local/trusted networks)
- Sessions auto-cleanup to prevent memory leaks

## License

MIT
