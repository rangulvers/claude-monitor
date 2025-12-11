/**
 * Session Manager - Manages in-memory state for active Claude Code sessions
 * Enhanced with model tracking, token usage, messages, and sub-agent support
 */

const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MS) || 300000; // 5 minutes
const MAX_TOOL_HISTORY = parseInt(process.env.MAX_TOOL_HISTORY) || 10;
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES) || 20;
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS) || 60000; // 1 minute
const IDLE_THRESHOLD_MS = parseInt(process.env.IDLE_THRESHOLD_MS) || 30000; // 30 seconds

// Model pricing per 1M tokens (approximate, Jan 2025)
const MODEL_PRICING = {
  'Opus 4.5':   { input: 15.00, output: 75.00 },
  'Sonnet 4.5': { input: 3.00,  output: 15.00 },
  'Haiku 4.5':  { input: 0.25,  output: 1.25 },
  'default':    { input: 3.00,  output: 15.00 }
};

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.changeListeners = [];
    this.agentToSession = new Map(); // Maps short agentId to full sessionId

    // Start auto-cleanup timer
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, CLEANUP_INTERVAL_MS);

    console.log(`SessionManager initialized with ${SESSION_TIMEOUT_MS}ms timeout`);
  }

  /**
   * Get or create a session
   * @param {string} sessionId - The session ID
   * @param {number|null} initialTimestamp - Optional timestamp to use for startTime/lastActivity (for loading old sessions)
   */
  getOrCreateSession(sessionId, initialTimestamp = null) {
    if (!this.sessions.has(sessionId)) {
      const timestamp = initialTimestamp || Date.now();
      const session = {
        id: sessionId,
        startTime: timestamp,
        lastActivity: timestamp,
        status: 'active',
        currentTool: null,
        toolHistory: [],
        // Enhanced fields
        model: null,
        modelShort: null,
        cwd: null,
        version: null,
        gitBranch: null,
        tokens: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreation: 0,
          total: 0
        },
        estimatedCost: 0,
        messages: [],
        // Sub-agent tracking
        parentSessionId: null,
        agentId: null,
        subAgents: [],
        isSubAgent: false
      };
      this.sessions.set(sessionId, session);
      this.notifyChange('session_created', session);
      console.log(`Session created: ${sessionId}`);
    } else {
      // Update last activity only if not loading from old data
      if (!initialTimestamp) {
        const session = this.sessions.get(sessionId);
        session.lastActivity = Date.now();
      }
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Parse model name to friendly short format
   */
  parseModelName(model) {
    if (!model) return null;
    const modelLower = model.toLowerCase();
    if (modelLower.includes('opus')) return 'Opus 4.5';
    if (modelLower.includes('sonnet')) return 'Sonnet 4.5';
    if (modelLower.includes('haiku')) return 'Haiku 4.5';
    // Fallback: extract meaningful part
    return model.split('-').slice(1, 3).join(' ');
  }

  /**
   * Update model information
   */
  updateModelInfo(sessionId, model, version = null) {
    const session = this.getOrCreateSession(sessionId);
    if (model && !session.model) {
      session.model = model;
      session.modelShort = this.parseModelName(model);
      console.log(`Session ${sessionId} using model: ${session.modelShort}`);
    }
    if (version && !session.version) {
      session.version = version;
    }
    this.notifyChange('session_updated', session);
  }

  /**
   * Update working directory
   */
  updateCwd(sessionId, cwd) {
    const session = this.getOrCreateSession(sessionId);
    if (cwd && !session.cwd) {
      session.cwd = cwd;
      this.notifyChange('session_updated', session);
    }
  }

  /**
   * Update git branch
   */
  updateGitBranch(sessionId, branch) {
    const session = this.getOrCreateSession(sessionId);
    if (branch && !session.gitBranch) {
      session.gitBranch = branch;
      this.notifyChange('session_updated', session);
    }
  }

  /**
   * Update token usage (cumulative)
   */
  updateTokenUsage(sessionId, usage) {
    const session = this.sessions.get(sessionId);
    if (!session || !usage) return;

    session.tokens.input += usage.input_tokens || 0;
    session.tokens.output += usage.output_tokens || 0;
    session.tokens.cacheRead += usage.cache_read_input_tokens || 0;
    session.tokens.cacheCreation += usage.cache_creation_input_tokens || 0;
    session.tokens.total = session.tokens.input + session.tokens.output;
    session.estimatedCost = this.estimateCost(session);
    session.lastActivity = Date.now();

    this.notifyChange('session_updated', session);
  }

  /**
   * Estimate cost based on model and token usage
   */
  estimateCost(session) {
    const rates = MODEL_PRICING[session.modelShort] || MODEL_PRICING['default'];
    return (
      (session.tokens.input * rates.input / 1_000_000) +
      (session.tokens.output * rates.output / 1_000_000)
    );
  }

  /**
   * Add a text message to session history
   */
  addMessage(sessionId, role, content, timestamp = null) {
    const session = this.sessions.get(sessionId);
    if (!session || !content) return;

    // Don't add duplicate messages
    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg && lastMsg.content === content && lastMsg.role === role) {
      return;
    }

    session.messages.push({
      role,
      content: this.truncate(content, 1000),
      timestamp: timestamp || new Date().toISOString(),
      id: Date.now()
    });

    // Keep only last N messages
    if (session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES);
    }

    session.lastActivity = Date.now();
    this.notifyChange('session_updated', session);
  }

  /**
   * Create a sub-agent session linked to parent
   */
  createSubAgent(agentId, parentSessionId, isSidechain = false) {
    // Use agentId as the session key for sub-agents
    let session = this.sessions.get(agentId);

    if (!session) {
      session = this.getOrCreateSession(agentId);
      session.agentId = agentId;
      session.parentSessionId = parentSessionId;
      session.isSubAgent = true;

      // Map agentId to session
      this.agentToSession.set(agentId, agentId);

      // Link to parent
      this.linkSubAgent(parentSessionId, agentId);

      console.log(`Sub-agent ${agentId} linked to parent ${parentSessionId}`);
    }

    return session;
  }

  /**
   * Link a sub-agent to its parent session
   */
  linkSubAgent(parentSessionId, agentId) {
    const parent = this.sessions.get(parentSessionId);
    if (parent && !parent.subAgents.includes(agentId)) {
      parent.subAgents.push(agentId);
      this.notifyChange('session_updated', parent);
    }
  }

  /**
   * Get session by either sessionId or agentId
   */
  getSession(id) {
    return this.sessions.get(id) || this.sessions.get(this.agentToSession.get(id));
  }

  /**
   * Truncate string helper
   */
  truncate(str, maxLength = 100) {
    if (!str) return '';
    str = String(str);
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  /**
   * Update session with tool start
   */
  startTool(sessionId, toolName, details = {}) {
    const session = this.getOrCreateSession(sessionId);

    // Complete previous tool if exists
    if (session.currentTool && session.currentTool.status === 'running') {
      this.completeTool(sessionId, session.currentTool.name, 'completed');
    }

    session.currentTool = {
      name: toolName,
      startTime: Date.now(),
      status: 'running',
      ...details
    };
    session.status = 'active';
    session.lastActivity = Date.now();

    this.notifyChange('tool_started', session);
    console.log(`Tool started in session ${sessionId}: ${toolName}`);
  }

  /**
   * Complete a tool execution
   */
  completeTool(sessionId, toolName, status = 'completed', details = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentTool) return;

    const duration = Date.now() - session.currentTool.startTime;

    // Add to history
    const historyEntry = {
      name: toolName,
      duration,
      status,
      completedAt: Date.now(),
      ...details
    };

    session.toolHistory.unshift(historyEntry);

    // Keep only last N tools
    if (session.toolHistory.length > MAX_TOOL_HISTORY) {
      session.toolHistory = session.toolHistory.slice(0, MAX_TOOL_HISTORY);
    }

    // Clear current tool
    session.currentTool = null;
    session.lastActivity = Date.now();

    this.notifyChange('tool_completed', session);
    console.log(`Tool completed in session ${sessionId}: ${toolName} (${duration}ms)`);
  }

  /**
   * Mark session as completed
   */
  completeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Complete any running tool
    if (session.currentTool && session.currentTool.status === 'running') {
      this.completeTool(sessionId, session.currentTool.name, 'completed');
    }

    session.status = 'completed';
    session.lastActivity = Date.now();

    this.notifyChange('session_completed', session);
    console.log(`Session completed: ${sessionId}`);
  }

  /**
   * Update session status
   */
  updateSessionStatus(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = status;
    session.lastActivity = Date.now();

    this.notifyChange('session_updated', session);
  }

  /**
   * Update session prompt
   */
  updateSessionPrompt(sessionId, prompt) {
    const session = this.getOrCreateSession(sessionId);
    session.prompt = prompt;
    session.lastActivity = Date.now();

    this.notifyChange('session_updated', session);
  }

  /**
   * Update session todos
   */
  updateTodos(sessionId, todos) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.todos = todos;
    session.lastActivity = Date.now();

    this.notifyChange('session_updated', session);
  }

  /**
   * Get all sessions
   */
  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * Get active sessions only
   */
  getActiveSessions() {
    return this.getAllSessions().filter(s => s.status === 'active');
  }

  /**
   * Remove stale sessions (inactive for more than timeout)
   */
  cleanupStaleSessions() {
    const now = Date.now();
    let cleanedCount = 0;
    let idledCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const inactiveTime = now - session.lastActivity;

      // Remove sessions that have been inactive for too long
      if (inactiveTime > SESSION_TIMEOUT_MS) {
        this.sessions.delete(sessionId);
        this.notifyChange('session_removed', { id: sessionId });
        cleanedCount++;
        console.log(`Removed stale session: ${sessionId} (inactive for ${Math.round(inactiveTime/1000)}s)`);
        continue;
      }

      // Mark as idle if no activity for IDLE_THRESHOLD_MS and no current tool running
      if (session.status === 'active' && !session.currentTool && inactiveTime > IDLE_THRESHOLD_MS) {
        session.status = 'idle';
        this.notifyChange('session_updated', session);
        idledCount++;
        console.log(`Session ${sessionId} marked as idle (inactive for ${Math.round(inactiveTime/1000)}s)`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`Cleanup: removed ${cleanedCount} stale session(s)`);
    }
    if (idledCount > 0) {
      console.log(`Cleanup: marked ${idledCount} session(s) as idle`);
    }
  }

  /**
   * Register a change listener
   */
  onChange(callback) {
    this.changeListeners.push(callback);
  }

  /**
   * Notify all listeners of a change
   */
  notifyChange(eventType, data) {
    for (const listener of this.changeListeners) {
      try {
        listener(eventType, data);
      } catch (error) {
        console.error('Error in change listener:', error);
      }
    }
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    this.changeListeners = [];
  }
}

export default SessionManager;
