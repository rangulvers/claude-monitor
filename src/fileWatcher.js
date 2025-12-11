/**
 * File Watcher - Monitors Claude's session files for activity
 */

import chokidar from 'chokidar';
import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = join(CLAUDE_DIR, 'history.jsonl');
const TODOS_DIR = join(CLAUDE_DIR, 'todos');

// Only load session files modified within this time window on startup
const MAX_FILE_AGE_MS = 10 * 60 * 1000; // 10 minutes

class FileWatcher {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
    this.filePositions = new Map(); // Track file read positions
    this.watchers = [];
    this.sessionFiles = new Map(); // sessionId -> filePath
    this.fileModTimes = new Map(); // filePath -> last modification time
  }

  /**
   * Start watching Claude's files
   */
  start() {
    console.log('Starting file watchers...');

    // Scan existing session files first
    this.scanExistingSessions();

    // Watch for new/modified session files in all project subdirectories
    // ignoreInitial: false so we can detect existing active sessions
    // usePolling: true is required for Docker volume mounts
    const projectWatcher = chokidar.watch(`${PROJECTS_DIR}/**/*.jsonl`, {
      persistent: true,
      ignoreInitial: false,
      usePolling: true,
      interval: 500,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    projectWatcher
      .on('add', (path) => this.handleFileAdded(path))
      .on('change', (path) => this.handleFileChanged(path))
      .on('error', (error) => console.error('Project watcher error:', error));

    this.watchers.push(projectWatcher);

    // Watch history file for new sessions
    const historyWatcher = chokidar.watch(HISTORY_FILE, {
      persistent: true,
      ignoreInitial: false
    });

    historyWatcher
      .on('change', () => this.handleHistoryChanged())
      .on('error', (error) => console.error('History watcher error:', error));

    this.watchers.push(historyWatcher);

    // Watch todos directory
    const todosWatcher = chokidar.watch(`${TODOS_DIR}/*.json`, {
      persistent: true,
      ignoreInitial: false
    });

    todosWatcher
      .on('change', (path) => this.handleTodoChanged(path))
      .on('error', (error) => console.error('Todos watcher error:', error));

    this.watchers.push(todosWatcher);

    console.log(`Watching: ${PROJECTS_DIR}/**/*.jsonl`);
    console.log(`Watching: ${HISTORY_FILE}`);
    console.log(`Watching: ${TODOS_DIR}/*.json`);
  }

  /**
   * Scan existing session files on startup
   * Only loads files modified within MAX_FILE_AGE_MS to avoid showing stale sessions
   */
  scanExistingSessions() {
    try {
      if (!existsSync(PROJECTS_DIR)) {
        console.log('Projects directory does not exist yet');
        return;
      }

      const files = readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.jsonl'));
      console.log(`Found ${files.length} existing session file(s)`);

      if (files.length === 0) return;

      const now = Date.now();

      // Get file stats and sort by modification time (most recent first)
      const fileStats = files.map(file => {
        const filePath = join(PROJECTS_DIR, file);
        const stats = statSync(filePath);
        return {
          path: filePath,
          file: file,
          mtime: stats.mtime,
          mtimeMs: stats.mtime.getTime(),
          size: stats.size
        };
      }).sort((a, b) => b.mtimeMs - a.mtimeMs);

      // Filter to only recent files (modified within MAX_FILE_AGE_MS)
      const recentFiles = fileStats.filter(({ mtimeMs }) =>
        (now - mtimeMs) < MAX_FILE_AGE_MS
      );

      console.log(`Loading ${recentFiles.length} recent session(s) (< ${MAX_FILE_AGE_MS / 60000} min old)`);

      // Track which parent sessions we're loading (for sub-agent filtering)
      const loadedParentSessions = new Set();

      // First pass: identify parent sessions
      for (const { file } of recentFiles) {
        if (!file.startsWith('agent-')) {
          // This is a parent session file (UUID.jsonl)
          const sessionId = file.replace('.jsonl', '');
          loadedParentSessions.add(sessionId);
        }
      }

      // Process each recent file
      for (const { path: filePath, file, mtime, mtimeMs, size } of recentFiles) {
        this.fileModTimes.set(filePath, mtime);

        // Read the file to extract session ID
        const sessionId = this.extractSessionIdFromFile(filePath);
        if (sessionId) {
          this.sessionFiles.set(sessionId, filePath);

          // Create session with file's mtime as initial lastActivity
          const session = this.sessionManager.getOrCreateSession(sessionId, mtimeMs);

          // Mark the most recent file's session as active
          if (filePath === recentFiles[0].path && size > 0) {
            console.log(`Detected current active session: ${sessionId}`);
            session.status = 'active';
          }

          // Process all existing content (but don't update lastActivity for old content)
          this.filePositions.set(filePath, 0);
          this.processNewLines(filePath, true); // true = isStartupScan
        }
      }
    } catch (error) {
      console.error('Error scanning existing sessions:', error.message);
    }
  }

  /**
   * Extract session ID from a session file
   */
  extractSessionIdFromFile(filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // Try to find session ID from first few lines
      for (const line of lines.slice(0, 10)) {
        try {
          const data = JSON.parse(line);
          const sessionId = data.sessionId || data.agentId;
          if (sessionId) {
            return sessionId;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      // Fallback: extract from filename if it matches UUID pattern
      const filename = filePath.split('/').pop();
      const match = filename.match(/^([a-f0-9-]{36})/);
      if (match) {
        return match[1];
      }

      return null;
    } catch (error) {
      console.error(`Error extracting session ID from ${filePath}:`, error.message);
      return null;
    }
  }

  /**
   * Handle new session file
   * Filters out old files to avoid showing stale sessions
   */
  handleFileAdded(filePath) {
    try {
      const stats = statSync(filePath);
      const fileAge = Date.now() - stats.mtime.getTime();

      // Skip files older than MAX_FILE_AGE_MS
      if (fileAge > MAX_FILE_AGE_MS) {
        console.log(`Skipping old session file: ${filePath} (${Math.round(fileAge / 60000)} min old)`);
        return;
      }

      console.log(`New session file: ${filePath}`);
      this.filePositions.set(filePath, 0);
      this.processNewLines(filePath);
    } catch (error) {
      console.error(`Error handling file added ${filePath}:`, error.message);
    }
  }

  /**
   * Handle session file change
   * If file wasn't tracked before (old file now active), start tracking from current position
   */
  handleFileChanged(filePath) {
    // If we don't have a position for this file, it was filtered as old but is now active
    if (!this.filePositions.has(filePath)) {
      console.log(`Previously inactive session now active: ${filePath}`);
      // Start from current size so we only see new content
      try {
        const stats = statSync(filePath);
        this.filePositions.set(filePath, stats.size);
      } catch (error) {
        this.filePositions.set(filePath, 0);
      }
    }
    this.processNewLines(filePath);
  }

  /**
   * Handle history file change (new sessions started)
   */
  handleHistoryChanged() {
    // Could track new sessions starting, but session files are more reliable
    console.log('History file updated');
  }

  /**
   * Handle todo file change
   */
  handleTodoChanged(filePath) {
    try {
      const todoContent = readFileSync(filePath, 'utf-8');
      const todos = JSON.parse(todoContent);

      // Extract session ID from filename
      const filename = filePath.split('/').pop();
      const match = filename.match(/^([a-f0-9-]+)/);
      if (match && todos.length > 0) {
        const sessionId = match[1];
        this.sessionManager.updateTodos(sessionId, todos);
      }
    } catch (error) {
      // Ignore errors (file might be empty or invalid JSON)
    }
  }

  /**
   * Process new lines in a session file
   */
  processNewLines(filePath) {
    try {
      const stats = statSync(filePath);
      const currentSize = stats.size;
      const lastPosition = this.filePositions.get(filePath) || 0;

      // If file shrunk, reset position
      if (currentSize < lastPosition) {
        this.filePositions.set(filePath, 0);
        return;
      }

      // No new content
      if (currentSize === lastPosition) {
        return;
      }

      // Read new content
      const content = readFileSync(filePath, 'utf-8');
      const newContent = content.substring(lastPosition);

      // Update position
      this.filePositions.set(filePath, currentSize);

      // Parse new lines
      const lines = newContent.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          this.processMessage(data, filePath);
        } catch (error) {
          // Ignore invalid JSON lines
        }
      }
    } catch (error) {
      console.error(`Error processing file ${filePath}:`, error.message);
    }
  }

  /**
   * Process a message from session file
   */
  processMessage(data, filePath) {
    const sessionId = data.sessionId;
    const agentId = data.agentId;

    // Determine the effective session ID
    // For sub-agents: agentId is their own ID, sessionId is parent's ID
    const isSubAgent = filePath.includes('/agent-') ||
                       (agentId && sessionId && agentId !== sessionId);

    const effectiveSessionId = isSubAgent ? agentId : (sessionId || agentId);
    if (!effectiveSessionId) return;

    // Handle sub-agent creation and linking
    if (isSubAgent && sessionId && agentId) {
      this.sessionManager.createSubAgent(agentId, sessionId, data.isSidechain);
    }

    // Track session file
    this.sessionFiles.set(effectiveSessionId, filePath);

    // Extract metadata from any message type
    if (data.cwd) {
      this.sessionManager.updateCwd(effectiveSessionId, data.cwd);
    }
    if (data.gitBranch) {
      this.sessionManager.updateGitBranch(effectiveSessionId, data.gitBranch);
    }

    const type = data.type;
    const timestamp = data.timestamp;

    switch (type) {
      case 'user':
        this.handleUserMessage(effectiveSessionId, data);
        break;

      case 'assistant':
        this.handleAssistantMessage(effectiveSessionId, data, timestamp);
        break;

      case 'tool_result':
        this.handleToolResult(effectiveSessionId, data);
        break;

      case 'result':
        // Session completed successfully
        console.log(`Session completed: ${effectiveSessionId}`);
        this.sessionManager.completeSession(effectiveSessionId);
        break;

      case 'queue-operation':
        if (data.operation === 'dequeue') {
          this.sessionManager.getOrCreateSession(effectiveSessionId);
        }
        break;
    }
  }

  /**
   * Handle user message
   */
  handleUserMessage(sessionId, data) {
    const content = data.message?.content;

    // Handle string content (user prompt)
    if (typeof content === 'string' && content.trim() && content !== 'Warmup') {
      this.sessionManager.updateSessionPrompt(sessionId, content.substring(0, 200));
      this.sessionManager.addMessage(sessionId, 'user', content, data.timestamp);
    }
  }

  /**
   * Handle assistant message - extract model, tokens, and text content
   */
  handleAssistantMessage(sessionId, data, timestamp) {
    const message = data.message;
    const content = message?.content;

    // Extract model info (only set once)
    if (message?.model) {
      this.sessionManager.updateModelInfo(sessionId, message.model, data.version);
    }

    // Extract token usage (cumulative)
    if (message?.usage) {
      this.sessionManager.updateTokenUsage(sessionId, message.usage);
    }

    // Process content blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          // Capture Claude's text response
          this.sessionManager.addMessage(sessionId, 'assistant', block.text, timestamp);
        } else if (block.type === 'tool_use') {
          this.handleToolUse(sessionId, block, timestamp);
        }
      }
    }
  }

  /**
   * Handle tool use
   */
  handleToolUse(sessionId, toolUse, timestamp) {
    const toolName = toolUse.name;
    const toolId = toolUse.id;
    const input = toolUse.input || {};

    const details = this.extractToolDetails(toolName, input);

    this.sessionManager.startTool(sessionId, toolName, {
      toolId,
      timestamp,
      ...details
    });
  }

  /**
   * Handle tool result
   */
  handleToolResult(sessionId, data) {
    // Tool results don't always have clear tool names
    // We rely on the session manager tracking current tool
    const session = this.sessionManager.sessions.get(sessionId);
    if (session?.currentTool) {
      const isError = data.is_error || false;
      const status = isError ? 'failed' : 'completed';

      this.sessionManager.completeTool(
        sessionId,
        session.currentTool.name,
        status
      );
    }
  }

  /**
   * Extract tool details from input
   */
  extractToolDetails(toolName, input) {
    const details = {};

    switch (toolName) {
      case 'Bash':
        details.command = this.truncate(input.command, 100);
        break;

      case 'Read':
        details.file = input.file_path;
        break;

      case 'Edit':
        details.file = input.file_path;
        details.preview = this.truncate(input.new_string, 50);
        break;

      case 'Write':
        details.file = input.file_path;
        break;

      case 'Glob':
        details.pattern = input.pattern;
        details.path = input.path;
        break;

      case 'Grep':
        details.pattern = input.pattern;
        details.path = input.path;
        break;

      case 'Task':
        details.description = this.truncate(input.description, 100);
        details.agentType = input.subagent_type;
        break;

      case 'WebFetch':
        details.url = input.url;
        break;

      case 'WebSearch':
        details.query = input.query;
        break;

      case 'TodoWrite':
        details.count = input.todos?.length || 0;
        break;

      default:
        if (input.description) details.description = this.truncate(input.description, 100);
        if (input.file_path) details.file = input.file_path;
        if (input.command) details.command = this.truncate(input.command, 100);
    }

    return details;
  }

  /**
   * Truncate string
   */
  truncate(str, maxLength = 100) {
    if (!str) return '';
    str = String(str);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  /**
   * Stop all watchers
   */
  stop() {
    console.log('Stopping file watchers...');
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.filePositions.clear();
    this.sessionFiles.clear();
  }
}

export default FileWatcher;
