// automate_trading/shared/steam_session_manager.js

/**
 * Singleton service for managing shared Steam sessions between workers
 * 
 * This allows HandleFriendsWorker to maintain persistent connections
 * while FriendInvitesWorker reuses those same sessions for sending invites
 */
class SteamSessionManager {
  constructor() {
    if (SteamSessionManager.instance) {
      return SteamSessionManager.instance;
    }
    
    // Map of accountId -> session data
    this.activeSessions = new Map();

    // Event listeners for session changes
    this.listeners = new Map();

    // Priority connection requests - Set of Steam IDs that need connecting ASAP
    // Used by MessageWorker to request priority connections when messages can't be sent
    this.priorityConnectionRequests = new Set();

    // Optional publisher callback for cross-service session status.
    // Set via setPublisher() in main.js after workers are initialised.
    // Signature: async (steamId: string, status: object) => void
    this._publisher = null;

    // Current sync interval tracking for smart re-queue delays
    this.currentSyncInterval = 60000; // Default 60s, updated by HandleFriendsWorker

    SteamSessionManager.instance = this;
  }

  /**
   * Register an active Steam session
   * Called by HandleFriendsWorker when a session is established
   */
  registerSession(accountId, sessionData) {
    const existingSession = this.activeSessions.get(accountId);

    this.activeSessions.set(accountId, {
      accountId: accountId,
      steamClient: sessionData.steamClient,
      account: sessionData.account,
      credentials: sessionData.credentials,
      isOnline: sessionData.isOnline || false,
      lastSeen: Date.now(),
      sessionType: 'persistent', // vs 'adhoc'
      registeredBy: 'HandleFriendsWorker'
    });

    // Notify listeners if this is a new or updated session
    if (!existingSession || existingSession.isOnline !== sessionData.isOnline) {
      this.notifyListeners('session_updated', accountId, this.activeSessions.get(accountId));
    }

    // Publish to cross-service status store
    const steamId = sessionData.steamClient?.steamID?.getSteamID64();
    this._publish(steamId || accountId, {
      isOnline:  sessionData.isOnline || false,
      accountId,
      lastSeen:  Date.now()
    });
  }

  /**
   * Update session status (online/offline)
   * Called by HandleFriendsWorker when connection status changes
   */
  updateSessionStatus(accountId, isOnline) {
    const session = this.activeSessions.get(accountId);

    if (session) {
      session.isOnline = isOnline;
      session.lastSeen = Date.now();

      this.notifyListeners('session_status_changed', accountId, session);

      // Publish to cross-service status store
      const steamId = session.steamClient?.steamID?.getSteamID64();
      this._publish(steamId || accountId, {
        isOnline,
        accountId,
        lastSeen: Date.now()
      });
    }
  }

  /**
   * Get an active session for friend invites
   * Called by FriendInvitesWorker to get a working session
   */
  getSessionForInvites(accountId) {
    const session = this.activeSessions.get(accountId);

    if (!session) {
      return {
        available: false,
        reason: 'No session found for this account'
      };
    }

    if (!session.isOnline) {
      return {
        available: false,
        reason: 'Session exists but is offline'
      };
    }

    if (!session.steamClient || !session.steamClient.steamID) {
      return {
        available: false,
        reason: 'Session exists but Steam client is not logged in'
      };
    }

    // Check if session is fresh (within last 5 minutes)
    const sessionAge = Date.now() - session.lastSeen;
    const maxAge = 5 * 60 * 1000; // 5 minutes

    if (sessionAge > maxAge) {
      return {
        available: false,
        reason: `Session is stale (${Math.round(sessionAge / 1000)}s old)`
      };
    }

    return {
      available: true,
      session: session,
      steamClient: session.steamClient,
      accountInfo: {
        accountId: session.accountId,
        steamId: session.steamClient.steamID.getSteamID64(),
        username: session.account.username || session.account.steam_login
      }
    };
  }

  /**
   * Get an active session for messaging by Steam ID
   * Called by MessageWorker to get a working session for sending messages
   * @param {string} steamId - The Steam ID to search for
   * @returns {Object} Result object with availability status and session data
   */
  getSessionForMessaging(steamId) {
    // Search through all sessions to find the one with matching Steam ID
    for (const [accountId, session] of this.activeSessions) {
      if (!session.steamClient || !session.steamClient.steamID) {
        continue;
      }

      const sessionSteamId = session.steamClient.steamID.getSteamID64();

      if (sessionSteamId === steamId) {
        // Found matching session, now validate it
        if (!session.isOnline) {
          return {
            available: false,
            reason: 'Session exists but is offline'
          };
        }

        if (!session.steamClient.chat) {
          return {
            available: false,
            reason: 'Session exists but chat functionality is not initialized'
          };
        }

        // Check if session is fresh (within last 5 minutes)
        const sessionAge = Date.now() - session.lastSeen;
        const maxAge = 5 * 60 * 1000; // 5 minutes

        if (sessionAge > maxAge) {
          return {
            available: false,
            reason: `Session is stale (${Math.round(sessionAge / 1000)}s old)`
          };
        }

        // Session is valid and ready for messaging
        return {
          available: true,
          session: session,
          steamClient: session.steamClient,
          accountInfo: {
            accountId: session.accountId,
            steamId: sessionSteamId,
            username: session.account.username || session.account.steam_login
          }
        };
      }
    }

    // No session found for this Steam ID
    return {
      available: false,
      reason: `No session found for Steam ID ${steamId}`
    };
  }

  /**
   * List all available sessions for debugging
   */
  listActiveSessions() {
    const sessions = [];
    
    for (const [accountId, session] of this.activeSessions) {
      sessions.push({
        accountId: accountId,
        username: session.account.username || session.account.steam_login,
        isOnline: session.isOnline,
        steamId: session.steamClient?.steamID?.getSteamID64() || 'unknown',
        lastSeen: session.lastSeen,
        sessionAge: Math.round((Date.now() - session.lastSeen) / 1000),
        registeredBy: session.registeredBy
      });
    }
    
    return sessions;
  }

  /**
   * Remove a session (when HandleFriendsWorker disconnects)
   */
  removeSession(accountId) {
    const session = this.activeSessions.get(accountId);

    if (session) {
      // Publish removal before deleting from local map so we still have steamId
      const steamId = session.steamClient?.steamID?.getSteamID64();
      this._publish(steamId || accountId, {
        isOnline:  false,
        removed:   true,
        accountId,
        lastSeen:  Date.now()
      });

      this.activeSessions.delete(accountId);
      this.notifyListeners('session_removed', accountId, session);
    }
  }

  /**
   * Add event listener for session changes
   */
  addEventListener(eventType, callback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    
    this.listeners.get(eventType).push(callback);
  }

  /**
   * Remove event listener
   */
  removeEventListener(eventType, callback) {
    const callbacks = this.listeners.get(eventType);
    
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Notify all listeners of session events
   */
  notifyListeners(eventType, accountId, sessionData) {
    const callbacks = this.listeners.get(eventType);
    
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(accountId, sessionData);
        } catch (error) {
          console.error(`Error in session manager listener: ${error.message}`);
        }
      });
    }
  }

  /**
   * Mark session as recently used (called by FriendInvitesWorker)
   */
  markSessionUsed(accountId) {
    const session = this.activeSessions.get(accountId);
    
    if (session) {
      session.lastSeen = Date.now();
    }
  }

  /**
   * Get statistics for monitoring
   */
  getStats() {
    const total = this.activeSessions.size;
    let online = 0;
    let offline = 0;
    let stale = 0;
    
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    
    for (const session of this.activeSessions.values()) {
      if (session.isOnline) {
        const age = now - session.lastSeen;
        if (age > staleThreshold) {
          stale++;
        } else {
          online++;
        }
      } else {
        offline++;
      }
    }
    
    return {
      total: total,
      online: online,
      offline: offline,
      stale: stale,
      available: online // Sessions that are online and fresh
    };
  }

  /**
   * Clear all sessions (for cleanup)
   */
  clearAllSessions() {
    this.activeSessions.clear();
    this.listeners.clear();
    this.priorityConnectionRequests.clear();
  }

  /**
   * Update current sync interval (called by HandleFriendsWorker)
   * @param {number} intervalMs - Current sync interval in milliseconds
   */
  updateSyncInterval(intervalMs) {
    this.currentSyncInterval = intervalMs;
  }

  /**
   * Get current sync interval
   * @returns {number} Current sync interval in milliseconds
   */
  getCurrentSyncInterval() {
    return this.currentSyncInterval;
  }

  /**
   * Calculate recommended re-queue delay with hybrid safety margin
   * Formula: currentInterval + Math.max(30000, currentInterval * 0.5)
   * @returns {number} Recommended delay in milliseconds
   */
  getRecommendedRequeueDelay() {
    const safetyMargin = Math.max(30000, this.currentSyncInterval * 0.5);
    return this.currentSyncInterval + safetyMargin;
  }

  /**
   * Request priority connection for a Steam ID
   * Called by MessageWorker when it needs to send messages but account is offline
   * @param {string} steamId - Steam ID that needs priority connection
   */
  requestPriorityConnection(steamId) {
    this.priorityConnectionRequests.add(steamId);
  }

  /**
   * Get all priority connection requests and optionally clear them
   * Called by AccountConnectionManager to get accounts that need connecting ASAP
   * @param {boolean} clear - Whether to clear the request after getting it
   * @returns {Array<string>} Array of Steam IDs requesting priority connection
   */
  getPriorityConnectionRequests(clear = false) {
    const requests = Array.from(this.priorityConnectionRequests);
    if (clear) {
      this.priorityConnectionRequests.clear();
    }
    return requests;
  }

  /**
   * Remove a priority connection request (called when account connects)
   * @param {string} steamId - Steam ID to remove from priority list
   */
  clearPriorityRequest(steamId) {
    this.priorityConnectionRequests.delete(steamId);
  }

  /**
   * Register a callback that is invoked whenever session status changes.
   * Called once from main.js after the HttpClient is available.
   * The callback receives (steamId, { isOnline, accountId, lastSeen, removed? })
   * and should POST the status to node_api_service /sessions/:steamId.
   * @param {Function} fn - async (steamId, status) => void
   */
  setPublisher(fn) {
    this._publisher = fn;
  }

  /**
   * Fire-and-forget: call the publisher without blocking or throwing.
   * Only publishes when a real Steam64 ID is available and publisher is wired.
   * @param {string} steamId
   * @param {object} status
   */
  _publish(steamId, status) {
    if (!this._publisher || !steamId || steamId === 'unknown') return;
    this._publisher(steamId, status).catch(e => {
      console.error(`[SteamSessionManager] Failed to publish session status for ${steamId}: ${e.message}`);
    });
  }

  /**
   * Get priority connection statistics
   * @returns {Object} Stats about priority requests
   */
  getPriorityStats() {
    return {
      pendingRequests: this.priorityConnectionRequests.size,
      requestedSteamIds: Array.from(this.priorityConnectionRequests)
    };
  }
}

// Export singleton instance
module.exports = new SteamSessionManager();