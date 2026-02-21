// automate_trading/workers/modules/historical_message_loader.js

const SteamID = require('steamid');
const SteamSessionManager = require('../../shared/steam_session_manager');

/**
 * Loads historical messages using existing active Steam sessions
 * 
 * Features:
 * - Reuses active Steam sessions from SteamSessionManager
 * - Processes raw Steam messages into negotiation format
 * - Handles Steam API errors and rate limits
 * - No connection overhead - leverages existing sessions
 */
class HistoricalMessageLoader {
  constructor(logger) {
    this.logger = logger;
    this.sessionManager = SteamSessionManager;
  }

  /**
   * Load historical messages for a specific friend using active session
   */
  async loadHistoricalMessages(task) {
    const { accountId, friendSteamId, accountSteamId } = task;
    
    try {
      this.logger.info(`Loading historical messages: account ${accountId} with friend ${friendSteamId}`);
      
      // Get active session for this account
      const sessionResult = this.sessionManager.getSessionForInvites(accountId);
      
      if (!sessionResult.available) {
        throw new Error(`No active session available for account ${accountId}: ${sessionResult.reason}`);
      }
      
      const { steamClient, accountInfo } = sessionResult;
      
      // Verify Steam client is properly logged in
      if (!steamClient.steamID || steamClient.steamID.getSteamID64() !== accountSteamId) {
        throw new Error(`Steam client session mismatch for account ${accountId}`);
      }
      
      // Mark session as recently used
      this.sessionManager.markSessionUsed(accountId);
      
      // Get chat history using active session
      const history = await this.getFriendChatHistory(steamClient, friendSteamId);
      
      // Process messages into negotiation format
      const processedMessages = this.processMessages(history.messages, accountSteamId, friendSteamId);
      
      this.logger.info(`✓ Loaded ${processedMessages.length} historical messages for account ${accountId} friend ${friendSteamId}`);
      
      return {
        success: true,
        messages: processedMessages,
        totalCount: processedMessages.length,
        moreAvailable: history.moreAvailable,
        accountInfo: {
          steamId: accountInfo.steamId,
          username: accountInfo.username
        }
      };
      
    } catch (error) {
      this.logger.error(`Failed to load historical messages for account ${accountId}: ${error.message}`);
      
      // Classify error for retry logic
      const shouldRetry = this.shouldRetryError(error);
      
      return {
        success: false,
        error: error.message,
        shouldRetry: shouldRetry,
        messages: []
      };
    }
  }

  /**
   * Get chat history with a friend using existing Steam client
   */
  async getFriendChatHistory(steamClient, friendSteamId) {
    return new Promise((resolve, reject) => {
      const friendID = new SteamID(friendSteamId);
      
      const timeout = setTimeout(() => {
        reject(new Error('Chat history request timeout after 30 seconds'));
      }, 30000);
      
      try {
        steamClient.chat.getFriendMessageHistory(friendID, (err, result) => {
          clearTimeout(timeout);
          
          if (err) {
            reject(new Error(`Steam chat history error: ${err.message}`));
          } else {
            resolve({
              messages: result.messages || [],
              moreAvailable: result.more_available || false
            });
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(new Error(`Steam chat API error: ${error.message}`));
      }
    });
  }

  /**
   * Process raw Steam messages into negotiation format
   */
  processMessages(rawMessages, accountSteamId, friendSteamId) {
    if (!rawMessages || rawMessages.length === 0) {
      return [];
    }

    return rawMessages.map(msg => {
      const senderSteamId = msg.sender.getSteamID64();
      const isFromMe = senderSteamId === accountSteamId;
      
      // Create unique message ID using timestamp + direction
      const messageId = `hist_${msg.server_timestamp.getTime()}_${isFromMe ? 'out' : 'in'}`;
      
      return {
        id: messageId,
        timestamp: msg.server_timestamp.toISOString(),
        direction: isFromMe ? 'outgoing' : 'incoming',
        message: msg.message,
        sender_steam_id: senderSteamId,
        source: 'historical', // Mark source for debugging
        ordinal: msg.ordinal,
        unread: msg.unread || false,
        // Additional Steam-specific data (optional)
        bbcodeParsed: msg.message_bbcode_parsed || null,
        // Processing metadata
        processed_at: new Date().toISOString(),
        friend_steam_id: friendSteamId, // For context
        account_steam_id: accountSteamId
      };
    });
  }

  /**
   * Determine if an error should trigger a retry
   */
  shouldRetryError(error) {
    const message = error.message.toLowerCase();
    
    // Session availability errors - should retry (session might become available)
    const sessionAvailabilityPatterns = [
      'no active session available',
      'session exists but is offline',
      'session is stale',
      'steam client is not logged in'
    ];
    
    // Steam API rate limit errors - should retry
    const rateLimitPatterns = [
      'rate limit',
      'too many requests',
      'temporarily unavailable',
      'service unavailable'
    ];
    
    // Connection/network errors - should retry
    const networkPatterns = [
      'timeout',
      'network',
      'econnreset',
      'enotfound',
      'chat history request timeout'
    ];
    
    // Steam-specific retryable errors
    const steamRetryablePatterns = [
      'steam chat history error',
      'steam chat api error',
      'logonsessionreplaced',
      'noconnection'
    ];
    
    // Non-retryable errors (logic errors, invalid data, etc.)
    const nonRetryablePatterns = [
      'steam client session mismatch',
      'invalid steam id',
      'friend not found'
    ];
    
    // Check non-retryable first
    if (nonRetryablePatterns.some(pattern => message.includes(pattern))) {
      return false;
    }
    
    // Check retryable patterns
    if (sessionAvailabilityPatterns.some(pattern => message.includes(pattern)) ||
        rateLimitPatterns.some(pattern => message.includes(pattern)) ||
        networkPatterns.some(pattern => message.includes(pattern)) ||
        steamRetryablePatterns.some(pattern => message.includes(pattern))) {
      return true;
    }
    
    // Default: retry unknown errors (conservative approach)
    return true;
  }

  /**
   * Verify that a session is available for historical message loading
   */
  async verifySessionAvailable(accountId) {
    const sessionResult = this.sessionManager.getSessionForInvites(accountId);
    
    if (!sessionResult.available) {
      return { 
        ready: false, 
        reason: sessionResult.reason 
      };
    }

    const { steamClient, accountInfo } = sessionResult;
    
    if (!steamClient.steamID || steamClient.steamID.getSteamID64() === '0') {
      return { 
        ready: false, 
        reason: 'Steam client has invalid Steam ID' 
      };
    }

    return {
      ready: true,
      steamId: steamClient.steamID.getSteamID64(),
      username: accountInfo.username,
      sessionType: 'shared'
    };
  }

  /**
   * Get diagnostic info for debugging
   */
  getDiagnosticInfo() {
    const sessionStats = this.sessionManager.getStats();
    const activeSessions = this.sessionManager.listActiveSessions();
    
    return {
      loaderType: 'shared_session_historical',
      sessionManagerStats: sessionStats,
      availableSessionsForHistory: activeSessions
        .filter(session => session.isOnline && session.sessionAge < 300) // Fresh sessions
        .map(session => ({
          accountId: session.accountId,
          username: session.username,
          steamId: session.steamId,
          sessionAge: session.sessionAge
        }))
    };
  }

  /**
   * No cleanup needed - sessions are managed by HandleFriendsWorker
   */
  async cleanup() {
    // No cleanup needed for shared sessions
    this.logger.debug('HistoricalMessageLoader cleanup completed (no cleanup needed for shared sessions)');
  }
}

module.exports = HistoricalMessageLoader;