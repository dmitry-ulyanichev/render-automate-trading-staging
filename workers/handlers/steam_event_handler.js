// automate_trading/workers/handlers/steam_event_handler.js

const HttpClient = require('../../utils/http_client');
const config = require('../../config/config');

/**
 * SIMPLIFIED: Steam event handler for persistent connections
 *
 * Removed:
 * - Priority queue logic (no rotation)
 * - Prioritization manager dependency
 * - Complex reconnection logic (handled by AccountConnectionManager)
 *
 * Focus:
 * - Token generation and saving
 * - Friend relationship monitoring
 * - Session management registration
 * - Historical message queue integration
 * - Trade offer manager initialization
 * - Real-time trade offer event processing
 */
class SteamEventHandler {
  constructor(djangoClient, sessionManager, logger) {
    this.djangoClient = djangoClient;
    this.sessionManager = sessionManager;
    this.logger = logger;

    // Dependencies (set via dependency injection)
    this.connectionManager = null;
    this.djangoOperationHandler = null;
    this.negotiationManager = null;
    this.historicalMessageQueue = null;
    this.tradeOfferQueue = null;
    this.orchestrationQueue = null;

    // Import SteamTradeManager singleton
    this.steamTradeManager = require('../../utils/steam_trade_manager');

    // HttpClient for updating negotiation JSON (requires config AND logger)
    this.httpClient = new HttpClient(config, logger);

    // Track sync operations per account to prevent double-sync
    this.pendingSyncs = new Map(); // accountId -> { count, timers: [] }
    this.syncCounter = 0; // Global counter for unique sync IDs

    // Track if event handlers are already setup for an account
    this.setupEventHandlers = new Map(); // accountId -> { setup: boolean, timestamp: number }

    // Track initial historical message sync per account to prevent redundant syncs
    // Key: accountId, Value: { synced: boolean, syncedAt: timestamp }
    this.initialHistoricalSyncCompleted = new Map();
  }

  /**
   * Set historical message queue dependency
   */
  setHistoricalMessageQueue(historicalMessageQueue) {
    this.historicalMessageQueue = historicalMessageQueue;
  }

  /**
   * Set trade offer queue dependency
   */
  setTradeOfferQueue(tradeOfferQueue) {
    this.tradeOfferQueue = tradeOfferQueue;
  }

  /**
   * Set orchestration queue dependency
   */
  setOrchestrationQueue(orchestrationQueue) {
    this.orchestrationQueue = orchestrationQueue;
  }

  /**
   * Set negotiation manager dependency
   */
  setNegotiationManager(negotiationManager) {
    this.negotiationManager = negotiationManager;
  }

  /**
   * Set connection manager dependency
   */
  setConnectionManager(connectionManager) {
    this.connectionManager = connectionManager;
  }

  /**
   * Set Django operation handler dependency
   */
  setDjangoOperationHandler(djangoOperationHandler) {
    this.djangoOperationHandler = djangoOperationHandler;
  }

  /**
   * Setup event handlers for a Steam client with duplicate protection
   */
  setupClientEventHandlers(client, account, credentials) {
    const accountId = account.id;
    const username = account.username || account.steam_login;
    
    // Check if handlers are already setup for this account
    const existingSetup = this.setupEventHandlers.get(accountId);
    if (existingSetup && existingSetup.setup) {
      const ageMs = Date.now() - existingSetup.timestamp;
      if (ageMs < 10000) { // Less than 10 seconds ago
        this.logger.debug(`[${username}] Event handlers already setup recently (${Math.round(ageMs/1000)}s ago), skipping duplicate setup`);
        return;
      }
    }
    
    this.logger.debug(`[${username}] Setting up event handlers${existingSetup ? ' (re-setup after cleanup)' : ''}`);
    
    // Mark handlers as setup
    this.setupEventHandlers.set(accountId, {
      setup: true,
      timestamp: Date.now()
    });
    
    // Login successful
    client.on('loggedOn', async () => {
      await this.handleLoggedOn(client, account);
    });

    // Web session received - extract and save auth token + register with session manager
    client.on('webSession', async (sessionId, cookies) => {
      await this.handleWebSession(client, account, sessionId, cookies);
    });

    // Friend relationship changed
    client.on('friendRelationship', async (steamID, relationship) => {
      await this.handleFriendRelationshipChange(account, steamID, relationship);
    });

    // SIMPLIFIED: Disconnection and error handlers removed
    // (handled by AccountConnectionManager's reconnection logic)
    
    this.logger.debug(`[${username}] Event handlers setup completed`);
  }

  /**
   * Handle successful login event
   */
  async handleLoggedOn(client, account) {
    try {
      this.logger.debug(`[${account.username || account.steam_login}] Logged on to Steam`);
      
      // Set persona state to online
      client.setPersona(1); // 1 = Online
      
      // Request web cookies to get auth token
      client.webLogOn();
      
    } catch (error) {
      this.logger.error(`[${account.username || account.steam_login}] Error in loggedOn handler: ${error.message}`);
    }
  }

  /**
   * Handle web session event with duplicate protection
   */
  async handleWebSession(client, account, sessionId, cookies) {
    const accountId = account.id;
    const username = account.username || account.steam_login;
    
    // Get client data to check if already processing
    const clientData = this.connectionManager ? this.connectionManager.getClient(accountId) : null;
    if (!clientData) {
      this.logger.warn(`[${username}] No client data found for web session`);
      return;
    }
    
    // Prevent concurrent processing with atomic flag check
    if (clientData.isProcessingWebSession) {
      this.logger.debug(`[${username}] Already processing web session, skipping duplicate`);
      return;
    }
    
    // Set processing flag immediately
    this.connectionManager.updateClientStatus(accountId, { isProcessingWebSession: true });
    
    try {
      this.logger.debug(`[${username}] Processing web session...`);
      
      // Extract auth token from cookies
      const authToken = this.extractAuthTokenFromCookies(cookies);
      
      if (authToken) {
        // Save token to database
        await this.saveAuthTokenToDatabase(accountId, authToken);
      }
      
      // Handle web session successfully
      if (!clientData.isOnline) {
        // Update client status to online
        this.connectionManager.updateClientStatus(accountId, { isOnline: true });
        
        // Register session with shared session manager
        this.registerSessionWithManager(accountId, clientData);
        
        // Reset global rate limit on successful connection (if resilience manager available)
        if (this.connectionManager.resilienceManager) {
          this.connectionManager.resilienceManager.resetGlobalRateLimit();
        }
        
        // Setup message handlers now that we have steamID
        if (this.negotiationManager && client.steamID) {
          this.negotiationManager.setupMessageEventHandlers(client, account);
          this.logger.debug(`[${username}] Message handlers setup completed (steamID: ${client.steamID.getSteamID64()})`);
        }

        // Initialize TradeOfferManager now that we have webSession
        try {
          const identitySecret = clientData.credentials ? clientData.credentials.identitySecret : null;
          this.initializeTradeOfferManager(accountId, client, account, cookies, identitySecret);
        } catch (error) {
          this.logger.error(`[${username}] Failed to initialize TradeOfferManager: ${error.message}`);
          // Don't fail the whole webSession handler if trade manager fails
        }

        // REMOVED: Deprecated automatic trade offer sync on connection
        // Trade offers are now synced intelligently based on [tradeoffer] messages in historical_message_worker.js
        // and via periodic sync (every 24 hours) in trade_offer_worker.js

        this.logger.info(`${username} connected successfully`);

        // Sync friends list only on initial connection (not on token refresh)
        // Real-time friendRelationship events handle all changes while connected
        if (client.steamID) {
          await this.scheduleSmartFriendsSync(accountId, account, username);
        } else {
          this.logger.warn(`[${username}] No steamID available for friends sync`);
        }
      } else {
        // Just update the session status
        this.sessionManager.updateSessionStatus(accountId, true);
        this.logger.debug(`[${username}] Web session refreshed (no friend sync needed - real-time monitoring active)`);
      }

    } catch (error) {
      this.logger.error(`[${username}] Error handling web session: ${error.message}`);
    } finally {
      // Always clear the processing flag
      this.connectionManager.updateClientStatus(accountId, { isProcessingWebSession: false });
    }
  }

  /**
   * Smart sync scheduling with better protection (unchanged)
   */
  async scheduleSmartFriendsSync(accountId, account, username) {
    // Check if there's already a sync pending for this account
    const currentPendingSync = this.pendingSyncs.get(accountId);
    if (currentPendingSync && currentPendingSync.count > 0) {
      this.logger.debug(`[${username}] Skipping sync - already has ${currentPendingSync.count} pending`);
      return; // Early return - don't schedule another sync
    }
    
    const syncId = ++this.syncCounter;
    this.logger.debug(`[${username}] Scheduling friends list sync in 2 seconds (syncId: ${syncId})...`);
    
    // Track this sync operation
    if (!this.pendingSyncs.has(accountId)) {
      this.pendingSyncs.set(accountId, { count: 0, timers: [] });
    }
    
    const pendingSync = this.pendingSyncs.get(accountId);
    pendingSync.count++;
    
    const timer = setTimeout(async () => {
      try {
        // Remove this timer from tracking
        const timerIndex = pendingSync.timers.indexOf(timer);
        if (timerIndex > -1) {
          pendingSync.timers.splice(timerIndex, 1);
        }
        
        await this.syncFriendsList(accountId, syncId);
        
        // Decrement counter
        pendingSync.count--;
        if (pendingSync.count <= 0) {
          this.pendingSyncs.delete(accountId);
        }
        
      } catch (error) {
        this.logger.error(`[${username}] Error syncing friends list: ${error.message}`);
        
        // Decrement counter even on error
        pendingSync.count--;
        if (pendingSync.count <= 0) {
          this.pendingSyncs.delete(accountId);
        }
      }
    }, 2000);
    
    // Track the timer
    pendingSync.timers.push(timer);
  }

  /**
   * Handle friend relationship changes
   * ENHANCED: Now includes negotiation cleanup when friendships are lost
   */
  async handleFriendRelationshipChange(account, steamID, relationship) {
    const friendSteamId = steamID.getSteamID64();

    // Skip our own accounts (no need to negotiate with ourselves)
    const baseAccountIds = config.baseAccounts?.ids || [];
    if (baseAccountIds.includes(friendSteamId)) {
      this.logger.debug(`[${account.username || account.steam_login}] Ignoring friend relationship change for own account ${friendSteamId}`);
      return;
    }

    try {
      // Map Steam relationship to our database values
      let dbRelationship;
      let friendshipLost = false;
      
      switch (relationship) {
        case 3: // Friend (invite accepted)
          dbRelationship = 'friend';
          break;
        case 2: // Request sent (legacy/alternative code)
          dbRelationship = 'invite_sent';
          break;
        case 4: // Request sent and pending (we sent invite, awaiting response)
          dbRelationship = 'invite_sent';
          break;
        case 1: // Request received (they sent invite to us)
          dbRelationship = 'invite_received';
          break;
        case 0: // No relationship (invite declined/removed)
          dbRelationship = null;
          friendshipLost = true; // Mark that we lost this friendship
          break;
        default:
          this.logger.debug(`[${account.username || account.steam_login}] Unknown friend relationship: ${relationship} for ${friendSteamId}`);
          return;
      }
      
      this.logger.debug(`[${account.username || account.steam_login}] Friend relationship change: ${friendSteamId} -> ${dbRelationship || 'none'}`);
      
      // Update the friend relationship in database with error handling
      try {
        await this.djangoClient.updateFriendRelationship(account.id, friendSteamId, dbRelationship);
      } catch (error) {
        this.logger.error(`Django API error updating friend relationship: ${error.message}`);
        // Queue for retry if Django operation handler is available
        if (this.djangoOperationHandler) {
          this.djangoOperationHandler.queueFailedOperation('updateFriendRelationship', {
            accountId: account.id,
            friendSteamId,
            relationship: dbRelationship,
            timestamp: Date.now()
          });
        }
      }
      
      // NEW: Clean negotiation JSON when friendship is lost
      if (friendshipLost && this.negotiationManager) {
        try {
          const accountSteamId = account.steam_id;
          
          this.logger.debug(`[${account.username || account.steam_login}] Cleaning negotiation for lost friendship: ${friendSteamId}`);
          
          const success = await this.negotiationManager.removeFriendNegotiation(
            accountSteamId, 
            friendSteamId, 
            account
          );
          
          if (success) {
            this.logger.info(`[${account.username || account.steam_login}] Successfully cleaned negotiation for ex-friend ${friendSteamId}`);
          } else {
            this.logger.warn(`[${account.username || account.steam_login}] Failed to clean negotiation for ex-friend ${friendSteamId}`);
          }
        } catch (negotiationError) {
          this.logger.error(`[${account.username || account.steam_login}] Error cleaning negotiation for lost friendship ${friendSteamId}: ${negotiationError.message}`);
          // Don't fail the entire operation if negotiation cleanup fails
        }
      }
      
      // If friend was accepted, update corresponding Link status
      if (relationship === 3) {
        try {
          await this.djangoClient.updateLinkStatus(friendSteamId, account.id, 'INVITE_ACCEPTED');
          this.logger.debug(`[${account.username || account.steam_login}] Updated link status to INVITE_ACCEPTED for ${friendSteamId}`);
        } catch (error) {
          this.logger.error(`Django API error updating link status (accepted): ${error.message}`);
          // Queue for retry if Django operation handler is available
          if (this.djangoOperationHandler) {
            this.djangoOperationHandler.queueFailedOperation('updateLinkStatus', {
              friendSteamId,
              accountId: account.id,
              status: 'INVITE_ACCEPTED',
              timestamp: Date.now()
            });
          }
        }
      }
      
      // If relationship was removed (declined), update Link status
      if (relationship === 0) {
        try {
          await this.djangoClient.updateLinkStatus(friendSteamId, account.id, 'INVITE_DECLINED');
          this.logger.debug(`[${account.username || account.steam_login}] Updated link status to INVITE_DECLINED for ${friendSteamId}`);
        } catch (error) {
          this.logger.error(`Django API error updating link status (declined): ${error.message}`);
          // Queue for retry if Django operation handler is available
          if (this.djangoOperationHandler) {
            this.djangoOperationHandler.queueFailedOperation('updateLinkStatus', {
              friendSteamId,
              accountId: account.id,
              status: 'INVITE_DECLINED',
              timestamp: Date.now()
            });
          }
        }
      }
      
    } catch (error) {
      this.logger.error(`[${account.username || account.steam_login}] Error handling friend relationship change for ${friendSteamId}: ${error.message}`);
    }
  }

  /**
   * Handle bulk negotiation cleanup for removed friends during sync
   * This is called when friends are detected as removed during reconnection sync
   */
  async handleBulkNegotiationCleanup(accountId, accountSteamId, username, stats) {
    if (!this.negotiationManager || !stats.removed_friend_ids || stats.removed_friend_ids.length === 0) {
      return;
    }

    try {
      const removedFriendIds = stats.removed_friend_ids;
      this.logger.info(`[${username}] Cleaning negotiations for ${removedFriendIds.length} removed friends: ${removedFriendIds.join(', ')}`);
      
      // Get account object for the negotiation manager
      const clientData = this.connectionManager.getClient(accountId);
      if (!clientData) {
        this.logger.warn(`[${username}] Cannot clean negotiations - no client data available`);
        return;
      }

      // Use bulk negotiation removal
      const result = await this.negotiationManager.removeFriendNegotiations(
        accountSteamId, 
        removedFriendIds, 
        clientData.account
      );

      if (result.success) {
        const cleanedCount = result.removed_count || 0;
        this.logger.info(`[${username}] Successfully cleaned ${cleanedCount} negotiations for removed friends`);
        
        if (cleanedCount < removedFriendIds.length) {
          this.logger.debug(`[${username}] ${removedFriendIds.length - cleanedCount} removed friends had no existing negotiations`);
        }
      } else {
        this.logger.warn(`[${username}] Failed to clean negotiations for removed friends: ${result.error}`);
      }
      
    } catch (error) {
      this.logger.error(`[${username}] Error during bulk negotiation cleanup: ${error.message}`);
      // Don't fail the entire sync operation if negotiation cleanup fails
    }
  }

  /**
   * Register session with shared session manager
   */
  registerSessionWithManager(accountId, clientData) {
    try {
      this.sessionManager.registerSession(accountId, {
        steamClient: clientData.client,
        account: clientData.account,
        credentials: clientData.credentials,
        isOnline: clientData.isOnline
      });
      
      this.logger.debug(`Registered session for account ${accountId} with session manager`);
    } catch (error) {
      this.logger.error(`Error registering session with manager: ${error.message}`);
    }
  }

  /**
   * Extract auth token from Steam cookies
   */
  extractAuthTokenFromCookies(cookies) {
    for (const cookie of cookies) {
      if (cookie.includes('steamLoginSecure=')) {
        const matches = cookie.match(/steamLoginSecure=(\d+)%7C%7C([^;]+)/);
        if (matches && matches.length >= 3) {
          return matches[2]; // Return the token part
        }
      }
    }
    return null;
  }

  /**
   * Save auth token to database
   */
  async saveAuthTokenToDatabase(accountId, tokenValue) {
    try {
      await this.djangoClient.updateAuthToken(accountId, tokenValue, true);
      this.logger.debug(`Auth token saved for account ${accountId}`);
    } catch (error) {
      this.logger.error(`Failed to save auth token for account ${accountId}: ${error.message}`);
    }
  }

  /**
   * Sync friends list with database and handle negotiations cleanup
   * ENHANCED: Now includes negotiation cleanup for removed friends
   */
  async syncFriendsList(accountId, syncId = 'unknown') {
    try {
      const clientData = this.connectionManager ? 
        this.connectionManager.getClient(accountId) : null;
      if (!clientData || !clientData.client.steamID) {
        this.logger.warn(`Cannot sync friends - no active client for account ${accountId}`);
        return;
      }
      
      const accountSteamId = clientData.client.steamID.getSteamID64();
      const friends = clientData.client.myFriends;
      const username = clientData.account.username || clientData.account.steam_login;
      
      this.logger.info(`[${username}] Starting friends sync (syncId: ${syncId}) - raw friends count: ${Object.keys(friends).length}`);
      
      if (Object.keys(friends).length === 0) {
        this.logger.warn(`[${username}] No friends found in Steam client - account may be new or friends list not loaded yet`);
        return;
      }
      
      const friendUpdates = [];
      const newAcceptedFriends = [];
      
      // Process each friend relationship
      for (const [steamID, relationship] of Object.entries(friends)) {
        const friendSteamId = steamID;
        
        // Map Steam relationship to our database values
        let dbRelationship;
        switch (relationship) {
          case 3: // Friend (confirmed friendship)
            dbRelationship = 'friend';
            newAcceptedFriends.push(friendSteamId);
            break;
          case 2: // Request sent (we sent invite) - may be deprecated/unused
            dbRelationship = 'invite_sent';
            break;
          case 4: // Request sent and pending (we sent invite, awaiting response)
            dbRelationship = 'invite_sent';
            break;
          case 1: // Request received (they sent invite) - NOT a confirmed friend
            dbRelationship = 'invite_received';
            break;
          default:
            this.logger.debug(`[${username}] Unknown friend relationship: ${relationship} for ${friendSteamId}`);
            continue; // Skip unknown relationships
        }
        
        friendUpdates.push({
          friend_steam_id: friendSteamId,
          relationship: dbRelationship
        });
      }
      
      // Update database with current friends list
      const updateResult = await this.djangoClient.updateFriendsList(accountId, friendUpdates);
      
      const confirmedFriends = friendUpdates.filter(f => f.relationship === 'friend');

      // Filter out our own accounts (no need to negotiate with ourselves)
      const baseAccountIds = config.baseAccounts?.ids || [];
      let filteredFriends = confirmedFriends;
      if (baseAccountIds.length > 0) {
        filteredFriends = filteredFriends.filter(f => !baseAccountIds.includes(f.friend_steam_id));
        const skipped = confirmedFriends.length - filteredFriends.length;
        if (skipped > 0) {
          this.logger.debug(`[${username}] Skipped ${skipped} own accounts from friend processing`);
        }
      }

      // 🧪 TESTING: Filter to specific friend when TEST_MODE_SINGLE_FRIEND env var is set
      if (process.env.TEST_MODE_SINGLE_FRIEND) {
        const TEST_FRIEND_FILTER = process.env.TEST_MODE_SINGLE_FRIEND;
        filteredFriends = filteredFriends.filter(f => f.friend_steam_id === TEST_FRIEND_FILTER);
        this.logger.info(`[${username}] 🧪 TEST MODE: Filtered down to ${filteredFriends.length} (only ${TEST_FRIEND_FILTER})`);
      }

      this.logger.info(`[${username}] Synced ${friendUpdates.length} friends (${filteredFriends.length} confirmed) - syncId: ${syncId}`);

      // NEW: Clean negotiations for removed friends if any were removed
      if (updateResult && updateResult.stats && updateResult.stats.removed_friends > 0) {
        await this.handleBulkNegotiationCleanup(accountId, accountSteamId, username, updateResult.stats);
      }

      // Create negotiations for confirmed friends
      if (this.negotiationManager && filteredFriends.length > 0) {
        await this.negotiationManager.createNegotiationsForFriends(
          accountSteamId,
          filteredFriends,
          clientData.account
        );
      }

      // Enqueue historical message tasks for confirmed friends
      if (this.historicalMessageQueue && filteredFriends.length > 0) {
        await this.enqueueHistoricalMessageTasks(accountId, accountSteamId, filteredFriends, clientData.account);
      }
      
      // Check if any of the confirmed friends should update Link status - BATCH UPDATE
      if (newAcceptedFriends.length > 0) {
        try {
          // Prepare batch update data
          const updates = newAcceptedFriends.map(friendSteamId => ({
            friendSteamId,
            steamAccountId: accountId,
            status: 'INVITE_ACCEPTED'
          }));

          // Perform batch update
          const result = await this.djangoClient.batchUpdateLinkStatus(updates);

          if (result.success) {
            const { stats } = result;
            this.logger.info(`[${username}] Batch updated ${stats.updated_count} links, ${stats.skipped_count} skipped, ${stats.error_count} errors`);

            // Log individual results for transparency
            result.results.forEach(res => {
              if (res.success && !res.skipped) {
                this.logger.info(`Updated Link ${res.link_id} status: ${res.old_status} -> INVITE_ACCEPTED for Steam ID ${res.steam_id}`);
              } else if (res.skipped) {
                this.logger.debug(`Skipped Link for Steam ID ${res.steam_id}: ${res.message || 'already processed'}`);
              } else if (!res.success) {
                this.logger.error(`Failed to update Link for Steam ID ${res.steam_id}: ${res.error}`);
              }
            });
          } else {
            this.logger.error(`Batch update failed: ${result.error}`);
          }
        } catch (error) {
          this.logger.error(`Error in batch updating Links: ${error.message}`);
          // Fallback to individual updates on batch failure
          this.logger.warn(`Falling back to individual updates for ${newAcceptedFriends.length} friends`);
          for (const friendSteamId of newAcceptedFriends) {
            try {
              await this.checkAndUpdateLinkForAcceptedFriend(accountId, friendSteamId);
            } catch (error) {
              this.logger.error(`Error updating Link for friend ${friendSteamId}: ${error.message}`);
            }
          }
        }
      }
      
    } catch (error) {
      this.logger.error(`Error syncing friends list for account ${accountId}: ${error.message}`);
      throw error; // Re-throw to be caught by caller
    }
  }

  /**
   * Enqueue historical message loading tasks for confirmed friends
   * UPDATED: Only enqueue on initial connection, not on token refresh
   */
  async enqueueHistoricalMessageTasks(accountId, accountSteamId, confirmedFriends, account) {
    try {
      // Check if we've already done the initial historical sync for this account
      const syncStatus = this.initialHistoricalSyncCompleted.get(accountId);
      if (syncStatus && syncStatus.synced) {
        const timeSinceSync = Date.now() - syncStatus.syncedAt;
        const hoursSinceSync = (timeSinceSync / (60 * 60 * 1000)).toFixed(1);
        this.logger.debug(`[${account.username || account.steam_login}] Skipping historical message sync - already synced ${hoursSinceSync}h ago (token refresh doesn't require re-sync)`);
        return;
      }

      this.logger.info(`[${account.username || account.steam_login}] Enqueuing historical message tasks for ${confirmedFriends.length} confirmed friends (initial sync)`);

      let enqueuedCount = 0;
      let skippedCount = 0;
      
      for (const friend of confirmedFriends) {
        const friendSteamId = friend.friend_steam_id;
        
        try {
          // Enqueue task for this friend
          const taskId = await this.historicalMessageQueue.enqueueTask(
            accountId,
            friendSteamId,
            accountSteamId,
            'normal' // priority
          );
          
          if (taskId) {
            enqueuedCount++;
            this.logger.debug(`[${account.username || account.steam_login}] Enqueued historical task for friend ${friendSteamId}: ${taskId}`);
          } else {
            skippedCount++;
            this.logger.debug(`[${account.username || account.steam_login}] Skipped historical task for friend ${friendSteamId} (already exists)`);
          }
          
        } catch (error) {
          this.logger.error(`[${account.username || account.steam_login}] Error enqueuing historical task for friend ${friendSteamId}: ${error.message}`);
          skippedCount++;
        }
      }
      
      this.logger.info(`[${account.username || account.steam_login}] Historical message tasks: ${enqueuedCount} enqueued, ${skippedCount} skipped`);

      // Mark this account as having completed initial historical sync
      this.initialHistoricalSyncCompleted.set(accountId, {
        synced: true,
        syncedAt: Date.now()
      });
      this.logger.debug(`[${account.username || account.steam_login}] Marked as historically synced - future token refreshes will skip historical sync`);

    } catch (error) {
      this.logger.error(`Error enqueuing historical message tasks for account ${accountId}: ${error.message}`);
      // Don't throw - this shouldn't stop the sync process
    }
  }

  /**
   * Check and update Link status for accepted friend
   */
  async checkAndUpdateLinkForAcceptedFriend(accountId, friendSteamId) {
    try {
      // Try to update Link status for this accepted friend
      const result = await this.djangoClient.updateLinkStatus(friendSteamId, accountId, 'INVITE_ACCEPTED');
      
      if (result.success && !result.skipped) {
        this.logger.info(`Updated Link ${result.link_id} status: ${result.old_status} -> INVITE_ACCEPTED for Steam ID ${friendSteamId}`);
      }
      
    } catch (error) {
      // Don't throw - this shouldn't stop the sync process
      this.logger.error(`Error checking link update for accepted friend: ${error.message}`);
    }
  }

  /**
   * Clean up event handlers on disconnection (called externally)
   */
  cleanupEventHandlers(accountId) {
    // Mark handlers as no longer setup
    this.setupEventHandlers.delete(accountId);
    
    // Cancel any pending syncs for this account
    const pendingSync = this.pendingSyncs.get(accountId);
    if (pendingSync) {
      this.logger.debug(`Cancelling ${pendingSync.timers.length} pending sync timers for account ${accountId}`);
      
      // Clear all timers
      pendingSync.timers.forEach(timer => clearTimeout(timer));
      this.pendingSyncs.delete(accountId);
    }
  }

  /**
   * Get event handler statistics for monitoring
   */
  getEventHandlerStats() {
    const pendingSyncStats = {};
    for (const [accountId, syncData] of this.pendingSyncs) {
      pendingSyncStats[accountId] = {
        count: syncData.count,
        timers: syncData.timers.length
      };
    }
    
    const setupHandlersStats = {};
    for (const [accountId, setupData] of this.setupEventHandlers) {
      setupHandlersStats[accountId] = {
        setup: setupData.setup,
        ageMs: Date.now() - setupData.timestamp
      };
    }
    
    return {
      handlersSetup: true,
      pendingSyncs: pendingSyncStats,
      setupEventHandlers: setupHandlersStats,
      totalSyncCounter: this.syncCounter,
      historicalQueueIntegrated: this.historicalMessageQueue !== null,
      timestamp: Date.now()
    };
  }

  /**
   * Initialize TradeOfferManager for an account
   * Called when webSession is established
   */
  initializeTradeOfferManager(accountId, client, account, cookies, identitySecret = null) {
    const username = account.username || account.steam_login;

    // Use Steam ID as the key for storing managers (not database accountId)
    const steamId = client.steamID ? client.steamID.getSteamID64() : null;
    if (!steamId) {
      this.logger.error(`[${username}] Cannot initialize TradeOfferManager - no Steam ID available`);
      return;
    }

    // Check if manager already exists
    if (this.steamTradeManager.hasManager(steamId)) {
      this.logger.debug(`[${username}] TradeOfferManager already exists, skipping initialization`);
      return;
    }

    // Register manager with SteamTradeManager using Steam ID
    const manager = this.steamTradeManager.registerManager(
      steamId,
      client,
      account,
      cookies,
      this.logger,
      identitySecret
    );

    // Setup event listeners for real-time updates
    this.steamTradeManager.setupEventListeners(
      steamId,
      this.handleNewTradeOffer.bind(this),
      this.handleSentOfferChanged.bind(this),
      this.handleReceivedOfferChanged.bind(this),
      this.logger
    );

    this.logger.info(`[${username}] ✓ TradeOfferManager initialized with event listeners`);
  }

  /**
   * Map Steam trade offer state code to readable name
   */
  mapTradeOfferState(stateCode) {
    const stateNames = {
      1: 'Invalid',
      2: 'Active',
      3: 'Accepted',
      4: 'Countered',
      5: 'Expired',
      6: 'Canceled',
      7: 'Declined',
      8: 'InvalidItems',
      9: 'CreatedNeedsConfirmation',
      10: 'CanceledBySecondFactor',
      11: 'InEscrow'
    };
    return stateNames[stateCode] || `Unknown(${stateCode})`;
  }

  /**
   * Upsert trade offer in array (same logic as TradeOfferWorker)
   */
  upsertTradeOffer(tradeOffers, offerData, newState = null) {
    const existingIndex = tradeOffers.findIndex(
      offer => offer.trade_offer_id === offerData.trade_offer_id
    );

    if (existingIndex !== -1) {
      // Offer exists - update it
      const existingOffer = tradeOffers[existingIndex];

      // Add new state to history if provided
      const updatedStateHistory = newState ? [
        ...existingOffer.state_history,
        {
          state: newState,
          timestamp: new Date().toISOString()
        }
      ] : existingOffer.state_history;

      // Update the offer
      const updatedOffer = {
        ...existingOffer,
        ...offerData,
        state: newState || existingOffer.state, // Update current state if provided
        state_history: updatedStateHistory,
        updated_at: new Date().toISOString()
      };

      // Replace in array
      return [
        ...tradeOffers.slice(0, existingIndex),
        updatedOffer,
        ...tradeOffers.slice(existingIndex + 1)
      ];
    } else {
      // Offer doesn't exist - add it
      const newOffer = {
        ...offerData,
        state: newState || offerData.state || 'Active', // Set current state
        created_at: offerData.created_at || new Date().toISOString(),
        state_history: offerData.state_history || [{
          state: newState || 'Active',
          timestamp: new Date().toISOString()
        }]
      };

      return [...tradeOffers, newOffer];
    }
  }

  /**
   * Simplify item data - extract only essential fields
   * @param {Array} items - Full Steam item objects
   * @returns {Array} - Simplified item objects
   */
  simplifyItemData(items) {
    if (!items || items.length === 0) return [];

    return items.map(item => ({
      assetid: item.assetid,
      appid: item.appid || 730,
      contextid: item.contextid || '2',
      amount: item.amount || 1,
      market_hash_name: item.market_hash_name || item.name,
      name: item.name,
      type: item.type
    }));
  }

  /**
   * Check if orchestration task should be created for trade offer state change
   * Returns task params or null
   *
   * @param {string} oldStateName - Previous state name
   * @param {string} newStateName - New state name
   * @param {boolean} isOurOffer - Whether we sent the offer
   * @param {Object} offer - Full trade offer object
   * @param {Object} negotiations - Negotiations context
   * @returns {Object|null} - Task params or null if no task needed
   */
  checkOrchestrationTaskNeeded(oldStateName, newStateName, isOurOffer, offer, negotiations) {
    // Only create tasks for offers involving current friends
    const friendSteamId = offer.friend_steam_id;
    if (!negotiations.negotiations || !negotiations.negotiations[friendSteamId]) {
      return null; // Not a current friend
    }

    const tradeOfferId = offer.trade_offer_id;

    // Scenario 1: Active offer → Accepted/InEscrow (our sent offer)
    if (isOurOffer && oldStateName === 'Active' && (newStateName === 'Accepted' || newStateName === 'InEscrow')) {
      return {
        scenario: 'offer_accepted',
        description: `Our offer ${tradeOfferId} was ${newStateName.toLowerCase()}`,
        decisionType: 'ai', // Delegate to AI
        tradeOfferId,
        oldState: oldStateName,
        newState: newStateName
      };
    }

    // Scenario 2: Active offer → Declined (our sent offer)
    if (isOurOffer && oldStateName === 'Active' && newStateName === 'Declined') {
      return {
        scenario: 'offer_declined',
        description: `Our offer ${tradeOfferId} was declined`,
        decisionType: 'ai', // Delegate to AI to ask why
        tradeOfferId,
        oldState: oldStateName,
        newState: newStateName
      };
    }

    // Scenario 3: Active offer → InvalidItems (our sent offer)
    if (isOurOffer && oldStateName === 'Active' && newStateName === 'InvalidItems') {
      // Check if there are ANY incoming messages from this friend (conversation ever happened)
      const hasAnyIncomingMessages = negotiations.negotiations[friendSteamId]?.messages?.some(
        msg => msg.direction === 'incoming'
      );

      return {
        scenario: 'offer_invalid_items',
        description: `Our offer ${tradeOfferId} has invalid items`,
        decisionType: hasAnyIncomingMessages ? 'ai' : 'deterministic_recreate',
        tradeOfferId,
        oldState: oldStateName,
        newState: newStateName,
        hasIncomingMessages: hasAnyIncomingMessages
      };
    }

    // Scenario 4: Active offer → Expired (our sent offer)
    if (isOurOffer && oldStateName === 'Active' && newStateName === 'Expired') {
      return {
        scenario: 'offer_expired',
        description: `Our offer ${tradeOfferId} expired`,
        decisionType: 'deterministic_remove_friend', // Remove friend as unresponsive
        tradeOfferId,
        oldState: oldStateName,
        newState: newStateName
      };
    }

    // Scenario 5: InEscrow → Accepted (our sent offer)
    if (isOurOffer && oldStateName === 'InEscrow' && newStateName === 'Accepted') {
      return {
        scenario: 'escrow_completed',
        description: `Escrow completed for offer ${tradeOfferId}`,
        decisionType: 'deterministic_remove_friend', // Job done, remove friend
        tradeOfferId,
        oldState: oldStateName,
        newState: newStateName
      };
    }

    // Scenario 5b: Active offer → Countered (our sent offer was countered)
    if (isOurOffer && oldStateName === 'Active' && newStateName === 'Countered') {
      return {
        scenario: 'offer_countered',
        description: `Our offer ${tradeOfferId} was countered`,
        decisionType: 'ai', // Delegate to AI to decide how to respond
        tradeOfferId,
        oldState: oldStateName,
        newState: newStateName
      };
    }

    // Scenario 6: New incoming offer or counteroffer (received offer)
    if (!isOurOffer) {
      // New incoming offer in Active state
      if (newStateName === 'Active' && (!oldStateName || oldStateName === 'Active')) {
        return {
          scenario: 'incoming_offer',
          description: `Received ${oldStateName ? 'counteroffer' : 'new offer'} ${tradeOfferId}`,
          decisionType: 'ai', // Delegate to AI
          tradeOfferId,
          oldState: oldStateName,
          newState: newStateName,
          isCounteroffer: !!oldStateName
        };
      }
    }

    return null; // No orchestration task needed for this state change
  }

  /**
   * Create orchestration task for trade offer change
   * @param {string} steamId - Our Steam account ID
   * @param {string} friendSteamId - Friend's Steam ID
   * @param {Object} taskParams - Parameters from checkOrchestrationTaskNeeded
   */
  async createTradeOfferOrchestrationTask(steamId, friendSteamId, taskParams) {
    if (!this.orchestrationQueue) {
      this.logger.warn(`[SteamEventHandler] Cannot create orchestration task - queue not available`);
      return;
    }

    try {
      const taskID = `${steamId}_${friendSteamId}`;

      // Load negotiation context for the orchestration task
      const negotiations = await this.httpClient.loadNegotiations(steamId);
      const friendContext = negotiations.negotiations?.[friendSteamId] || {};

      const orchestrationTask = {
        taskID,
        action: 'run_decision_tree',
        reason: 'change_in_trade_offers',
        priority: 7, // High priority for trade offer changes
        params: taskParams,
        context: {
          ...friendContext,
          account_steam_id: steamId,
          friend_steam_id: friendSteamId
        },
        created_at: new Date().toISOString()
      };

      await this.orchestrationQueue.addTask(orchestrationTask);

      this.logger.info(`[SteamEventHandler] ✅ Created orchestration task for ${taskParams.scenario}: ${taskParams.description}`);
    } catch (error) {
      this.logger.error(`[SteamEventHandler] ❌ Failed to create orchestration task: ${error.message}`);
    }
  }

  /**
   * Sync trade offer to Django Trade model
   * @param {string} ourSteamId - Our Steam account ID
   * @param {Object} tradeOfferData - Trade offer data
   * @param {string} stateName - State name (Active, Canceled, etc.)
   */
  async syncTradeToDjango(ourSteamId, tradeOfferData, stateName) {
    try {
      // Map state name to code
      const stateMap = {
        'Invalid': 1,
        'Active': 2,
        'Accepted': 3,
        'Countered': 4,
        'Expired': 5,
        'Canceled': 6,
        'Declined': 7,
        'InvalidItems': 8,
        'CreatedNeedsConfirmation': 9,
        'CanceledBySecondFactor': 10,
        'InEscrow': 11
      };

      const stateCode = stateMap[stateName] || 2; // Default to Active

      // Calculate totals
      const itemsToGive = tradeOfferData.items_to_give || [];
      const itemsToReceive = tradeOfferData.items_to_receive || [];

      const totalItemsToGive = itemsToGive.reduce((sum, item) =>
        sum + ((item.price || 0) * (item.quantity || 1)), 0
      );
      const totalItemsToReceive = itemsToReceive.reduce((sum, item) =>
        sum + ((item.price || 0) * (item.quantity || 1)), 0
      );

      // Check if trade is intra (between our own accounts)
      const ourAccounts = await this.djangoClient.getActiveAccounts();
      const isIntra = ourAccounts.accounts?.some(
        acc => acc.steam_id === tradeOfferData.friend_steam_id
      ) || false;

      // Prepare trade data
      const tradeData = {
        steam_id: ourSteamId,
        trade_offer_id: tradeOfferData.trade_offer_id,
        state: stateCode,
        trade_partner_steam_id: tradeOfferData.friend_steam_id,
        is_our_offer: tradeOfferData.is_our_offer !== undefined ? tradeOfferData.is_our_offer : true,
        intra: isIntra,
        total_items_to_give: totalItemsToGive,
        total_items_to_receive: totalItemsToReceive
      };

      // Upsert to Django
      const result = await this.djangoClient.upsertTrade(tradeData);

      if (result.success) {
        this.logger.info(
          `[SteamEventHandler] ✅ Synced trade ${tradeOfferData.trade_offer_id} to Django ` +
          `(${result.created ? 'created' : 'updated'}, state: ${stateName})`
        );
      } else {
        this.logger.error(
          `[SteamEventHandler] ❌ Failed to sync trade ${tradeOfferData.trade_offer_id} to Django: ${result.error}`
        );
      }

      return result;

    } catch (error) {
      this.logger.error(
        `[SteamEventHandler] Error syncing trade ${tradeOfferData.trade_offer_id} to Django: ${error.message}`
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle new incoming trade offer
   * Real-time event when someone sends us a trade offer
   */
  async handleNewTradeOffer(offer, account, steamId) {
    const username = account.username || account.steam_login;

    try {
      const friendSteamId = offer.partner.getSteamID64();
      const stateName = this.mapTradeOfferState(offer.state);

      // Update negotiation JSON in real-time using ATOMIC operation (prevents race conditions)
      try {
        // Build trade offer data
        const newOfferData = {
          trade_offer_id: offer.id,
          friend_steam_id: friendSteamId,
          is_our_offer: false, // They sent it to us
          items_to_give: this.simplifyItemData(offer.itemsToGive || []),
          items_to_receive: this.simplifyItemData(offer.itemsToReceive || []),
          state: stateName,
          updated_at: new Date().toISOString()
        };

        // Atomically upsert (entire read-modify-write in single lock)
        const result = await this.httpClient.atomicUpsertTradeOffer(steamId, newOfferData);

        // Check if this is truly a new offer or just Steam re-notifying us of an existing one
        const isTrulyNew = result.operation === 'added';

        if (isTrulyNew) {
          this.logger.info(`[${username}] 🆕 New trade offer received: ${offer.id} from ${friendSteamId}`);
        } else {
          this.logger.debug(`[${username}] 🔄 Steam re-notified existing offer: ${offer.id} from ${friendSteamId} (state: ${stateName})`);
        }

        this.logger.info(`[${username}] ✅ Atomically ${result.operation} trade offer ${offer.id} to negotiation JSON`);

        // Sync to Django Trade model
        try {
          await this.syncTradeToDjango(steamId, newOfferData, stateName);
        } catch (error) {
          this.logger.error(`[${username}] ❌ Failed to sync offer to Django: ${error.message}`);
        }

        // Only create orchestration task for TRULY NEW offers (not re-notifications)
        if (isTrulyNew) {
          try {
            // Load negotiations for context (needed by orchestration logic)
            const negotiations = await this.httpClient.loadNegotiations(steamId);

            const taskParams = this.checkOrchestrationTaskNeeded(
              null, // No old state for new offer
              stateName,
              false, // isOurOffer = false (received offer)
              newOfferData,
              negotiations
            );

            if (taskParams) {
              await this.createTradeOfferOrchestrationTask(steamId, friendSteamId, taskParams);
            }
          } catch (error) {
            this.logger.error(`[${username}] ❌ Failed to create orchestration task for new offer: ${error.message}`);
          }
        }

      } catch (error) {
        this.logger.error(`[${username}] ❌ Failed to update negotiation JSON for new offer ${offer.id}: ${error.message}`);
      }

    } catch (error) {
      this.logger.error(`[${username}] Error handling new trade offer: ${error.message}`);
    }
  }

  /**
   * Handle sent trade offer state change
   * Real-time event when our sent offer changes state (accepted, declined, etc.)
   */
  async handleSentOfferChanged(offer, oldState, account, steamId) {
    const username = account.username || account.steam_login;

    try {
      const newState = offer.state;
      const friendSteamId = offer.partner.getSteamID64();
      const stateName = this.mapTradeOfferState(newState);

      this.logger.info(`[${username}] 📤 Sent offer ${offer.id} state changed: ${oldState} → ${newState} (friend: ${friendSteamId})`);

      // Log additional details based on state
      if (newState === 3) { // Accepted
        this.logger.info(`[${username}] ✅ Trade offer ${offer.id} was ACCEPTED by friend`);
      } else if (newState === 7) { // Declined
        this.logger.info(`[${username}] ❌ Trade offer ${offer.id} was DECLINED by friend`);
      } else if (newState === 6) { // Canceled
        this.logger.info(`[${username}] 🚫 Trade offer ${offer.id} was CANCELED`);
      } else if (newState === 9) { // Invalid items
        this.logger.info(`[${username}] ⚠️ Trade offer ${offer.id} has INVALID ITEMS`);
      }

      // Update negotiation JSON in real-time using ATOMIC operation (prevents race conditions)
      try {
        this.logger.debug(`[${username}] Atomically updating trade offer ${offer.id} for steamId: ${steamId}`);

        // SPECIAL HANDLING: For Countered state, delay to let the newOffer event process first
        // This prevents race condition where we update to Countered while newOffer is still writing
        if (stateName === 'Countered') {
          this.logger.debug(`[${username}] Delaying Countered update by 100ms to avoid race with newOffer event`);
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Build trade offer data
        const tradeOfferData = {
          trade_offer_id: offer.id,
          friend_steam_id: friendSteamId,
          is_our_offer: true, // sentOfferChanged is only for our sent offers
          state: stateName,
          updated_at: new Date().toISOString()
        };

        // Atomically upsert (entire read-modify-write in single lock)
        const result = await this.httpClient.atomicUpsertTradeOffer(steamId, tradeOfferData);

        this.logger.info(`[${username}] ✅ Atomically ${result.operation} negotiation JSON: offer ${offer.id} → ${stateName}`);

        // Sync to Django Trade model
        try {
          await this.syncTradeToDjango(steamId, tradeOfferData, stateName);
        } catch (error) {
          this.logger.error(`[${username}] ❌ Failed to sync sent offer to Django: ${error.message}`);
        }

        // Check if orchestration task should be created for this state change
        try {
          const oldStateName = this.mapTradeOfferState(oldState);

          // Build a minimal offer object for orchestration check
          const offerForOrchestration = {
            ...tradeOfferData,
            id: offer.id
          };

          // Load negotiations for context (needed by orchestration logic)
          const negotiations = await this.httpClient.loadNegotiations(steamId);

          const taskParams = this.checkOrchestrationTaskNeeded(
            oldStateName,
            stateName,
            true, // isOurOffer (sent offer)
            offerForOrchestration,
            negotiations
          );

          if (taskParams) {
            await this.createTradeOfferOrchestrationTask(steamId, friendSteamId, taskParams);
          }
        } catch (error) {
          this.logger.error(`[${username}] ❌ Failed to create orchestration task: ${error.message}`);
        }

      } catch (error) {
        this.logger.error(`[${username}] ❌ Failed to update negotiation JSON for offer ${offer.id}: ${error.message}`);
        this.logger.error(`[${username}] Error stack: ${error.stack}`);
      }

    } catch (error) {
      this.logger.error(`[${username}] Error handling sent offer change: ${error.message}`);
    }
  }

  /**
   * Handle received trade offer state change
   * Real-time event when incoming offer changes state
   */
  async handleReceivedOfferChanged(offer, oldState, account, steamId) {
    const username = account.username || account.steam_login;

    try {
      const newState = offer.state;
      const friendSteamId = offer.partner.getSteamID64();
      const stateName = this.mapTradeOfferState(newState);

      this.logger.info(`[${username}] 📥 Received offer ${offer.id} state changed: ${oldState} → ${newState} (friend: ${friendSteamId})`);

      // Update negotiation JSON in real-time using ATOMIC operation (prevents race conditions)
      try {
        // Build trade offer data
        const tradeOfferData = {
          trade_offer_id: offer.id,
          friend_steam_id: friendSteamId,
          is_our_offer: false, // receivedOfferChanged is for incoming offers
          state: stateName,
          updated_at: new Date().toISOString()
        };

        // Atomically upsert (entire read-modify-write in single lock)
        const result = await this.httpClient.atomicUpsertTradeOffer(steamId, tradeOfferData);

        this.logger.info(`[${username}] ✅ Atomically ${result.operation} negotiation JSON: received offer ${offer.id} → ${stateName}`);

        // Sync to Django Trade model
        try {
          await this.syncTradeToDjango(steamId, tradeOfferData, stateName);
        } catch (error) {
          this.logger.error(`[${username}] ❌ Failed to sync received offer to Django: ${error.message}`);
        }

        // Check if orchestration task should be created for received offer state change
        try {
          const oldStateName = this.mapTradeOfferState(oldState);

          // Build a minimal offer object for orchestration check
          const offerForOrchestration = {
            ...tradeOfferData,
            id: offer.id
          };

          // Load negotiations for context (needed by orchestration logic)
          const negotiations = await this.httpClient.loadNegotiations(steamId);

          const taskParams = this.checkOrchestrationTaskNeeded(
            oldStateName,
            stateName,
            false, // isOurOffer = false (received offer)
            offerForOrchestration,
            negotiations
          );

          if (taskParams) {
            await this.createTradeOfferOrchestrationTask(steamId, friendSteamId, taskParams);
          }
        } catch (error) {
          this.logger.error(`[${username}] ❌ Failed to create orchestration task for received offer: ${error.message}`);
        }

      } catch (error) {
        this.logger.error(`[${username}] ❌ Failed to update negotiation JSON for received offer ${offer.id}: ${error.message}`);
      }

    } catch (error) {
      this.logger.error(`[${username}] Error handling received offer change: ${error.message}`);
    }
  }

  /**
   * Sync all trade offers after reconnection
   * Uses Steam Web API to fetch ALL offers (active + recently changed) since last check
   * Discovers new offers that arrived during downtime and updates state changes
   * @param {string} steamId - Steam ID of the reconnected account
   * @param {Object} account - Account object with username, etc.
   */
  // REMOVED: syncAllTradeOffersAfterReconnect() method (deprecated)
  // Trade offers are now synced intelligently based on [tradeoffer] messages in historical_message_worker.js
  // and via periodic sync (every 24 hours) in trade_offer_worker.js

  /**
   * Cleanup method for proper shutdown
   */
  async cleanup() {
    this.logger.info('SteamEventHandler cleanup started');

    // Cleanup trade offer managers
    if (this.steamTradeManager) {
      this.steamTradeManager.cleanup(this.logger);
    }

    // Clear all pending sync timers
    for (const [accountId, syncData] of this.pendingSyncs) {
      syncData.timers.forEach(timer => clearTimeout(timer));
    }
    this.pendingSyncs.clear();

    // Clear setup tracking
    this.setupEventHandlers.clear();

    // Clear historical sync tracking
    this.initialHistoricalSyncCompleted.clear();

    this.logger.info('SteamEventHandler cleanup completed');
  }
}

module.exports = SteamEventHandler;