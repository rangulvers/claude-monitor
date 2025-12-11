/**
 * Claude Monitor Server
 * Real-time monitoring dashboard for Claude Code activity
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import SessionManager from './sessionManager.js';
import FileWatcher from './fileWatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT) || 3002;
const WS_HEARTBEAT_MS = parseInt(process.env.WS_HEARTBEAT_MS) || 30000;

// Initialize Express app
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Initialize session manager
const sessionManager = new SessionManager();

// Initialize file watcher
const fileWatcher = new FileWatcher(sessionManager);
fileWatcher.start();

// Middleware
app.use(express.json({ limit: '10kb' })); // Limit payload size
app.use(express.static(join(__dirname, 'public')));

// CORS headers (if needed)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  }
  next();
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeSessions: sessionManager.getActiveSessions().length,
    totalSessions: sessionManager.getAllSessions().length
  });
});

/**
 * Ingest endpoint - DEPRECATED: File watcher is now primary method
 * Kept for backwards compatibility
 */
app.post('/ingest', (req, res) => {
  res.status(200).json({
    status: 'deprecated',
    message: 'File watcher is now monitoring Claude sessions automatically. No need to POST data.'
  });
});

/**
 * Get all sessions (REST API)
 */
app.get('/api/sessions', (req, res) => {
  const sessions = sessionManager.getAllSessions();
  res.json({ sessions });
});

/**
 * WebSocket connection handling
 */
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  clients.add(ws);

  // Send current state immediately on connection
  const sessions = sessionManager.getAllSessions();
  ws.send(JSON.stringify({
    type: 'initial_state',
    sessions
  }));

  // Set up heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data);

      // Handle any client messages here if needed
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

/**
 * WebSocket heartbeat interval
 */
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating inactive WebSocket client');
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, WS_HEARTBEAT_MS);

/**
 * Broadcast updates to all connected WebSocket clients
 */
function broadcastToClients(message) {
  const messageStr = JSON.stringify(message);

  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(messageStr);
      } catch (error) {
        console.error('Error sending to WebSocket client:', error);
      }
    }
  });
}

/**
 * Listen for session changes and broadcast to clients
 */
sessionManager.onChange((eventType, data) => {
  // Broadcast different message types based on event
  switch (eventType) {
    case 'session_created':
    case 'tool_started':
    case 'tool_completed':
    case 'session_updated':
      broadcastToClients({
        type: 'session_update',
        session: data
      });
      break;

    case 'session_completed':
      broadcastToClients({
        type: 'session_completed',
        session: data
      });
      break;

    case 'session_removed':
      broadcastToClients({
        type: 'session_removed',
        sessionId: data.id
      });
      break;
  }
});

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');

  clearInterval(heartbeatInterval);
  fileWatcher.stop();

  server.close(() => {
    console.log('HTTP server closed');
    sessionManager.destroy();

    wss.close(() => {
      console.log('WebSocket server closed');
      process.exit(0);
    });
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  process.exit(0);
});

/**
 * Start server
 */
server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Claude Code Activity Monitor');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  HTTP Server:     http://0.0.0.0:${PORT}`);
  console.log(`  Dashboard:       http://0.0.0.0:${PORT}/`);
  console.log(`  Health Check:    http://0.0.0.0:${PORT}/health`);
  console.log(`  WebSocket:       ws://0.0.0.0:${PORT}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Mode: File Watcher (Automatic)');
  console.log('  Monitoring: ~/.claude/projects/**/*.jsonl');
  console.log(`  Session Timeout: ${process.env.SESSION_TIMEOUT_MS || 300000}ms`);
  console.log(`  Max Tool History: ${process.env.MAX_TOOL_HISTORY || 10}`);
  console.log('═══════════════════════════════════════════════════════');
});
