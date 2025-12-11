/**
 * Stream Parser - Parses Claude Code's stream-json output
 */

/**
 * Parse a stream-json chunk and extract relevant information
 */
export function parseStreamChunk(jsonData, sessionManager) {
  try {
    // Handle different message types from Claude Code stream-json
    const type = jsonData.type;

    // Extract session ID (might be in different places depending on message type)
    const sessionId = jsonData.session_id ||
                      jsonData.sessionId ||
                      jsonData.metadata?.session_id ||
                      'unknown';

    switch (type) {
      case 'init':
        // Initial system message
        console.log(`Init message for session ${sessionId}`);
        sessionManager.getOrCreateSession(sessionId);
        break;

      case 'user':
        // User message/prompt
        console.log(`User prompt in session ${sessionId}`);
        sessionManager.updateSessionStatus(sessionId, 'active');
        break;

      case 'assistant':
        // Assistant message (Claude's response)
        if (jsonData.content && Array.isArray(jsonData.content)) {
          for (const contentBlock of jsonData.content) {
            if (contentBlock.type === 'tool_use') {
              // Tool use started
              handleToolUse(sessionId, contentBlock, sessionManager);
            } else if (contentBlock.type === 'text') {
              // Claude is responding with text
              console.log(`Text response in session ${sessionId}`);
            }
          }
        }
        break;

      case 'tool_result':
        // Tool execution result
        handleToolResult(sessionId, jsonData, sessionManager);
        break;

      case 'result':
        // Final result message (session completed)
        console.log(`Session ${sessionId} completed`);
        sessionManager.completeSession(sessionId);
        break;

      case 'error':
        // Error occurred
        console.error(`Error in session ${sessionId}:`, jsonData.error);
        sessionManager.updateSessionStatus(sessionId, 'error');
        break;

      default:
        // Unknown type - just update activity
        console.log(`Unknown message type "${type}" in session ${sessionId}`);
        sessionManager.getOrCreateSession(sessionId);
    }

  } catch (error) {
    console.error('Error parsing stream chunk:', error, 'Data:', jsonData);
  }
}

/**
 * Handle tool_use content block
 */
function handleToolUse(sessionId, toolUse, sessionManager) {
  const toolName = toolUse.name;
  const toolId = toolUse.id;
  const input = toolUse.input || {};

  // Extract relevant details based on tool type
  const details = extractToolDetails(toolName, input);

  sessionManager.startTool(sessionId, toolName, {
    toolId,
    ...details
  });
}

/**
 * Handle tool_result message
 */
function handleToolResult(sessionId, result, sessionManager) {
  const toolId = result.tool_use_id;
  const isError = result.is_error || false;
  const content = result.content;

  // Determine status
  const status = isError ? 'failed' : 'completed';

  // Extract tool name if available (might need to track tool_use_id -> tool_name mapping)
  const session = sessionManager.sessions.get(sessionId);
  const toolName = session?.currentTool?.name || 'Unknown';

  sessionManager.completeTool(sessionId, toolName, status, {
    toolId,
    output: truncateOutput(content)
  });
}

/**
 * Extract relevant details from tool input based on tool type
 */
function extractToolDetails(toolName, input) {
  const details = {};

  switch (toolName) {
    case 'Bash':
      details.command = truncateString(input.command, 100);
      break;

    case 'Read':
      details.file = input.file_path;
      break;

    case 'Edit':
      details.file = input.file_path;
      break;

    case 'Write':
      details.file = input.file_path;
      break;

    case 'Glob':
      details.pattern = input.pattern;
      break;

    case 'Grep':
      details.pattern = input.pattern;
      break;

    case 'Task':
      details.description = input.description;
      details.agentType = input.subagent_type;
      break;

    case 'WebFetch':
      details.url = input.url;
      break;

    case 'WebSearch':
      details.query = input.query;
      break;

    default:
      // For unknown tools, try to extract any useful info
      if (input.description) details.description = truncateString(input.description, 100);
      if (input.file_path) details.file = input.file_path;
      if (input.command) details.command = truncateString(input.command, 100);
  }

  return details;
}

/**
 * Truncate a string to max length
 */
function truncateString(str, maxLength = 100) {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

/**
 * Truncate output content (could be string or array)
 */
function truncateOutput(content, maxLength = 200) {
  if (!content) return '';

  if (Array.isArray(content)) {
    content = content.map(c => c.text || c).join('\n');
  }

  if (typeof content === 'object') {
    content = JSON.stringify(content);
  }

  return truncateString(String(content), maxLength);
}

export default {
  parseStreamChunk
};
