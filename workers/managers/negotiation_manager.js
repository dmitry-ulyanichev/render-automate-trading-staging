// automate_trading/workers/managers/negotiation_manager.js - Extended with Orchestration Support
const HttpClient = require('../../utils/http_client');
const DjangoClient = require('../../shared/django_client');
const QueueCleanupManager = require('./queue_cleanup_manager');
const NegotiationTaskCoordinator = require('./negotiation_task_coordinator'); // NEW
const SteamLoginExtractor = require('../../utils/steam_login_extractor');

/**
 * Negotiation Manager - Handles Steam chat negotiations with orchestration support
 */
class NegotiationManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // HTTP client for API operations (only method)
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue cleanup manager
    this.queueCleanupManager = new QueueCleanupManager(config, logger);

    // Django client for source determination
    this.djangoClient = new DjangoClient();

    // Initialize task coordinator
    this.taskCoordinator = new NegotiationTaskCoordinator(config, logger);

    // Initialize Steam login extractor
    this.steamLoginExtractor = new SteamLoginExtractor(config.persistentConnections?.credentialsFile);

    // Dependencies (set via dependency injection)
    this.connectionManager = null;
    
    // Define negotiation states (existing + potentially new ones)
    this.NEGOTIATION_STATES = {
      INITIATING: 'initiating',
      REMOVING: 'removing',
      REPLYING: 'replying',
      AWAITING_REPLY: 'awaiting_reply',
      ACTIVE: 'active',
      WAITING_FOR_REPLY: 'waiting_for_reply',
      DISCONNECTED_ACTIVE: 'disconnected_active',
      COMPLETED: 'completed',
      FINISHED: 'finished',
      ERROR: 'error',
      REPLIED: 'replied'
    };
    
    // Define objective types for orchestration
    this.OBJECTIVE_TYPES = {
      REQUEST_CASES_AS_GIFT: 'request_cases_as_gift',
      REQUEST_SKINS_AS_GIFT: 'request_skins_as_gift',
      TRADE: 'trade',
      REDIRECT: 'redirect'
    };
    
    // Define source types
    this.SOURCE_TYPES = {
      MATCH: 'match',
      RESERVE_PIPELINE: 'reserve_pipeline'
    };
    
    // In-memory cache for negotiations
    this.negotiationCache = new Map();
    this.cacheValidityMs = 30000; // 30 seconds
    
    this.logger.info('NegotiationManager initialized - Extended with orchestration support');
  }

  async initialize() {
    this.logger.info('Initializing NegotiationManager...');
    
    try {
      // Test HTTP API connection (required)
      await this.httpClient.testConnection();
      this.logger.info('NegotiationManager HTTP API connection verified');
      
      this.logger.info('NegotiationManager initialization complete');
      
    } catch (error) {
      this.logger.error(`NegotiationManager initialization failed: ${error.message}`);
      throw error;
    }
  }

  // ==================== NEGOTIATION STRUCTURE ====================

  /**
   * Create new negotiation structure with all orchestration fields
   * @param {string} friendSteamId - Friend's Steam ID
   * @param {string|null} source - Source of negotiation ('match' | 'reserve_pipeline' | null)
   * @returns {Object} New negotiation object with all required fields
   */
  createNewNegotiation(friendSteamId, source = null) {
    const now = new Date().toISOString();

    return {
      friend_steam_id: friendSteamId,
      state: this.NEGOTIATION_STATES.INITIATING, // CHANGED: was PENDING_INITIATION
      followUpCount: 0,
      created_at: now,
      updated_at: now,
      messages: [],

      // Orchestration fields
      objective: null,
      source: source,
      inventory_private: null,
      inventory: null,
      inventory_updated_at: null,
      redirected_to: [],
      language: {
        current_language: null,
        candidates: [],
        methods_used: [],
        last_updated: null
      },
      referred_from_messages: [],
      // REMOVED: trade_offers (moved to account level)
      // REMOVED: trade_offers_updated_at (moved to account level)
      referrer_checked: false,
      base_accounts_checked_at: null,
      ai_requested_actions: null
    };
  }

  /**
   * Create AI requested actions structure
   * @returns {Object} AI requested actions object
   */
  createAIRequestedActions() {
    return {
      trigger_message_id: null,
      actions_completed: [],
      actions_pending: [],
      created_at: new Date().toISOString()
    };
  }

  /**
   * Create trade offer structure
   * @param {Object} params - Trade offer parameters
   * @returns {Object} Trade offer object
   */
  createTradeOffer(params = {}) {
    return {
      trade_offer_id: params.trade_offer_id || null,
      is_our_offer: params.is_our_offer || false,
      state_history: params.state_history || [],
      items_to_give: params.items_to_give || [],
      items_to_receive: params.items_to_receive || [],
      profit: params.profit || 0,
      give_to_receive_ratio: params.give_to_receive_ratio || null
    };
  }

  /**
   * Create inventory item structure
   * @param {Object} params - Item parameters
   * @returns {Object} Inventory item object
   */
  createInventoryItem(params = {}) {
    return {
      market_hash_name: params.market_hash_name || '',
      quantity: params.quantity || 0,
      price: params.price || 0,
      tradeable: params.tradeable !== undefined ? params.tradeable : true
    };
  }

  /**
   * Determine negotiation source for a friend based on Link lookup
   * @param {string} friendSteamId - Friend's Steam ID
   * @returns {Promise<string>} 'reserve_pipeline' or 'match'
   */
  async determineNegotiationSource(friendSteamId) {
    try {
      // Use DjangoClient to determine source
      const result = await this.djangoClient.determineNegotiationSource(friendSteamId);
      
      if (result.success) {
        this.logger.debug(`Determined source for ${friendSteamId}: ${result.source} (user_id: ${result.user_id})`);
        return result.source;
      } else {
        this.logger.warn(`Failed to determine source for ${friendSteamId}: ${result.error}`);
        return 'match'; // Default fallback
      }
    } catch (error) {
      this.logger.error(`Error determining source for ${friendSteamId}: ${error.message}`);
      return 'match'; // Default fallback
    }
  }

  /**
   * Create new negotiation with automatically determined source
   * @param {string} friendSteamId - Friend's Steam ID
   * @returns {Promise<Object>} New negotiation object with correct source
   */
  async createNewNegotiationWithSource(friendSteamId) {
    const source = await this.determineNegotiationSource(friendSteamId);
    return this.createNewNegotiation(friendSteamId, source);
  }

  // ==================== API OPERATIONS ====================

  /**
   * Ensure negotiation has all required fields with defaults
   * @param {Object} negotiation - Negotiation object
   * @returns {Object} Negotiation with all fields
   */
  ensureNegotiationFields(negotiation) {
    const requiredFieldDefaults = {
      // Core orchestration fields
      objective: null,
      source: null,
      inventory_private: null,
      inventory: null,
      inventory_updated_at: null,

      // Array fields
      redirected_to: [],
      referred_from_messages: [],
      // REMOVED: trade_offers (moved to account level)

      // Timestamp fields
      // REMOVED: trade_offers_updated_at (moved to account level)
      base_accounts_checked_at: null,

      // Boolean fields
      referrer_checked: false,

      // Language object
      language: {
        current_language: null,
        candidates: [],
        methods_used: [],
        last_updated: null
      },

      // AI actions
      ai_requested_actions: null,

      // Legacy fields that might be missing
      messages: [],
      followUpCount: 0,
      state: this.NEGOTIATION_STATES?.INITIATING || 'initiating', // CHANGED: was PENDING_INITIATION
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    let fieldsAdded = [];
    let fieldsPreserved = [];
    
    // Add missing fields ONLY (never overwrite existing values)
    for (const [fieldName, defaultValue] of Object.entries(requiredFieldDefaults)) {
      const existingValue = negotiation[fieldName];
      const isUndefined = existingValue === undefined;
      
      if (isUndefined) {
        negotiation[fieldName] = defaultValue;
        fieldsAdded.push(`${fieldName}: undefined -> ${JSON.stringify(defaultValue)}`);
      } else {
        fieldsPreserved.push(`${fieldName}: ${JSON.stringify(existingValue)}`);
      }
    }
    
    // Ensure arrays are arrays (migration support)
    // This is needed for existing negotiations that might have null instead of []
    const arrayFields = ['messages', 'redirected_to', 'referred_from_messages'];
    let arrayFieldsFixed = [];

    for (const field of arrayFields) {
      const originalValue = negotiation[field];
      if (negotiation[field] !== undefined && !Array.isArray(negotiation[field])) {
        negotiation[field] = [];
        arrayFieldsFixed.push(`${field}: ${JSON.stringify(originalValue)} -> []`);
      }
    }

    // MIGRATION: Remove old trade_offers field from friend-level negotiations
    if (negotiation.trade_offers !== undefined) {
      delete negotiation.trade_offers;
      delete negotiation.trade_offers_updated_at;
    }
    
    // Ensure boolean fields are boolean (migration support)
    let booleanFieldsFixed = [];
    
    if (negotiation.referrer_checked !== undefined && typeof negotiation.referrer_checked !== 'boolean') {
      const originalValue = negotiation.referrer_checked;
      negotiation.referrer_checked = false;
      booleanFieldsFixed.push(`referrer_checked: ${JSON.stringify(originalValue)} -> false`);
    }
    
    return negotiation;
  }

  /**
   * Remove negotiation for a friend who is no longer in friends list
   * This cleans up negotiation data when friendship is lost
   */
  async removeFriendNegotiation(accountSteamId, friendSteamId, account) {
    try {
      this.logger.debug(`Removing negotiation for ex-friend ${friendSteamId} from account ${accountSteamId}`);

      // EXISTING: Use HttpClient to call API endpoint
      const response = await this.httpClient.delete(`/negotiations/${accountSteamId}/friend/${friendSteamId}`);

      if (response.success && response.removed) {
        this.logger.info(`Successfully removed negotiation for ex-friend ${friendSteamId} (previous state: ${response.previous_state})`);

        // Clean up queue tasks only if a negotiation actually existed
        try {
          const queueCleanupResult = await this.queueCleanupManager.cleanupTasksForFriend(
            accountSteamId,
            friendSteamId
          );

          if (queueCleanupResult.total_tasks_removed > 0) {
            this.logger.info(`Cleaned ${queueCleanupResult.total_tasks_removed} queue task(s) for ex-friend ${friendSteamId}`);
          }
        } catch (queueCleanupError) {
          this.logger.error(`Error cleaning queue tasks for ex-friend ${friendSteamId}: ${queueCleanupError.message}`);
        }

        return true;
      } else {
        this.logger.debug(`No negotiation found for friend ${friendSteamId} - nothing to clean`);
        return true; // Not an error - already clean
      }
      
    } catch (error) {
      this.logger.error(`Error removing negotiation for friend ${friendSteamId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Remove negotiations for multiple friends (bulk operation)
   * This cleans up negotiation data when multiple friendships are lost
   */
  async removeFriendNegotiations(accountSteamId, friendSteamIds, account) {
    try {
      if (!friendSteamIds || friendSteamIds.length === 0) {
        return { success: true, removed_count: 0 };
      }

      this.logger.debug(`Bulk removing negotiations for ${friendSteamIds.length} ex-friends from account ${accountSteamId}`);
      
      // NEW: Clean up queue tasks BEFORE removing negotiations (bulk)
      try {
        this.logger.debug(`Bulk cleaning queue tasks for ${friendSteamIds.length} ex-friends before negotiation removal`);
        
        const queueCleanupResult = await this.queueCleanupManager.cleanupTasksForFriends(
          accountSteamId, 
          friendSteamIds
        );
        
        if (queueCleanupResult.total_tasks_removed > 0) {
          this.logger.info(`Bulk cleaned ${queueCleanupResult.total_tasks_removed} queue task(s) for ${friendSteamIds.length} ex-friends`);
        }
        
        if (!queueCleanupResult.success) {
          this.logger.warn(`Bulk queue cleanup had some failures for ex-friends, but continuing with negotiation removal`);
        }
        
      } catch (queueCleanupError) {
        // Don't fail the entire operation if queue cleanup fails
        this.logger.error(`Error bulk cleaning queue tasks for ex-friends: ${queueCleanupError.message}`);
        this.logger.warn(`Continuing with bulk negotiation removal despite queue cleanup failure`);
      }
      
      // EXISTING: Use HttpClient to call API endpoint
      const response = await this.httpClient.post(`/negotiations/${accountSteamId}/remove-friends`, {
        friend_steam_ids: friendSteamIds
      });
      
      if (response.success) {
        const removedCount = response.removed_count || 0;
        if (removedCount > 0) {
          this.logger.info(`Successfully removed ${removedCount} negotiations for ex-friends: ${response.removed_friends?.join(', ')}`);
        } else {
          this.logger.debug(`No negotiations found for any of the ${friendSteamIds.length} friends - already clean`);
        }
        
        return {
          success: true,
          removed_count: removedCount,
          removed_friends: response.removed_friends || []
        };
      } else {
        this.logger.error(`Failed to remove friend negotiations: ${response.error}`);
        return { success: false, error: response.error };
      }
      
    } catch (error) {
      this.logger.error(`Error bulk removing friend negotiations: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ==================== EXISTING MESSAGE HANDLING ====================

  async handleIncomingMessage(accountSteamId, friendSteamId, message, account) {
    try {
      this.logger.info(`[${account.username || account.steam_login}] Incoming message from ${friendSteamId}: "${message}"`);

      const negotiations = await this.httpClient.loadNegotiations(accountSteamId);

      if (!negotiations.negotiations[friendSteamId]) {
        negotiations.negotiations[friendSteamId] = await this.createNewNegotiationWithSource(friendSteamId);
        this.logger.debug(`Created new negotiation for incoming message from ${friendSteamId}`);
      }

      const negotiation = negotiations.negotiations[friendSteamId];

      const messageObj = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        direction: 'incoming',
        message: message,
        sender_steam_id: friendSteamId,
        received_at: new Date().toISOString(),
        processed_at: new Date().toISOString()
      };

      negotiation.messages.push(messageObj);
      negotiation.updated_at = new Date().toISOString();

      negotiation.state = 'replying';
      // Reset followUpCount since friend has responded
      negotiation.followUpCount = 0;

      // IMPORTANT: Reload negotiations before saving to avoid overwriting concurrent
      // atomic trade offer updates (race condition fix)
      const freshNegotiations = await this.httpClient.loadNegotiations(accountSteamId);
      freshNegotiations.negotiations[friendSteamId] = negotiation;

      await this.httpClient.saveNegotiations(accountSteamId, freshNegotiations);
      
      try {
        await this.taskCoordinator.handleLastMessage(negotiation, accountSteamId);
        this.logger.debug(`Task coordination completed for incoming message: ${accountSteamId} -> ${friendSteamId}`);
      } catch (coordinatorError) {
        this.logger.error(`Task coordination failed for incoming message ${accountSteamId} -> ${friendSteamId}: ${coordinatorError.message}`);
      }
      
      this.logger.info(`[${account.username || account.steam_login}] Saved incoming message from ${friendSteamId}`);

    } catch (error) {
      this.logger.error(`Error handling incoming message from ${friendSteamId}: ${error.message}`);
    }
  }

  /**
   * DEPRECATED: No longer called since friendMessageEcho doesn't fire reliably.
   * Outgoing messages are now saved by MessageWorker.saveOutgoingMessages() after sending.
   * Historical outgoing messages are discovered by HistoricalMessageWorker.
   *
   * Kept for reference only - can be removed in future cleanup.
   */
  async handleOutgoingMessage(accountSteamId, friendSteamId, message, account) {
    this.logger.warn(`handleOutgoingMessage called but is deprecated - outgoing messages should be saved by MessageWorker`);

    try {
      this.logger.info(`[${account.username || account.steam_login}] Outgoing message to ${friendSteamId}: "${message}"`);

      const negotiations = await this.httpClient.loadNegotiations(accountSteamId);

      if (!negotiations.negotiations[friendSteamId]) {
        negotiations.negotiations[friendSteamId] = await this.createNewNegotiationWithSource(friendSteamId);
        this.logger.debug(`Created new negotiation for outgoing message to ${friendSteamId}`);
      }

      const negotiation = negotiations.negotiations[friendSteamId];

      const messageObj = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        direction: 'outgoing',
        message: message,
        sender_steam_id: accountSteamId,
        sent_at: new Date().toISOString()
      };

      negotiation.messages.push(messageObj);
      negotiation.updated_at = new Date().toISOString();

      negotiation.state = 'awaiting_reply';
      // The reason to comment this out is that if we are in 'removing' state but in a
      // trade cooldown period, we should still communictate with the friend
      // if (negotiation.state !== 'removing') {
      //   negotiation.state = 'awaiting_reply';
      // }

      // IMPORTANT: Reload negotiations before saving to avoid overwriting concurrent
      // atomic trade offer updates (race condition fix)
      const freshNegotiations = await this.httpClient.loadNegotiations(accountSteamId);
      freshNegotiations.negotiations[friendSteamId] = negotiation;

      await this.httpClient.saveNegotiations(accountSteamId, freshNegotiations);

      try {
        await this.taskCoordinator.handleLastMessage(negotiation, accountSteamId);
        this.logger.debug(`Task coordination completed for outgoing message: ${accountSteamId} -> ${friendSteamId}`);
      } catch (coordinatorError) {
        this.logger.error(`Task coordination failed for outgoing message ${accountSteamId} -> ${friendSteamId}: ${coordinatorError.message}`);
      }

      this.logger.info(`[${account.username || account.steam_login}] Saved outgoing message to ${friendSteamId}`);

    } catch (error) {
      this.logger.error(`Error handling outgoing message to ${friendSteamId}: ${error.message}`);
    }
  }

  // ==================== DEPENDENCY INJECTION ====================

  /**
   * Set connection manager dependency (called from main worker)
   */
  setConnectionManager(connectionManager) {
    this.connectionManager = connectionManager;
    this.logger.debug('NegotiationManager: ConnectionManager dependency set');
  }

  /**
   * Setup message event handlers for a Steam client
   * Called when webSession is established and steamID is available
   */
  setupMessageEventHandlers(client, account) {
    const accountSteamId = client.steamID?.getSteamID64();
    if (!accountSteamId) {
      this.logger.error(`Cannot setup message handlers - no Steam ID for ${account.username || account.steam_login}`);
      return;
    }

    this.logger.info(`Setting up message handlers for ${account.username || account.steam_login} (steamID: ${accountSteamId})`);

    // Handle incoming messages
    client.on('friendMessage', async (steamID, message) => {
      await this.handleIncomingMessage(accountSteamId, steamID.getSteamID64(), message, account);
    });

    // NOTE: friendMessageEcho event doesn't fire reliably, so outgoing messages
    // are now saved manually by MessageWorker after sending.
    // Historical outgoing messages are still discovered by HistoricalMessageWorker.

    this.logger.info(`Message handlers setup complete for ${account.username || account.steam_login} (steamID: ${accountSteamId})`);
  }

  async createNegotiationsForFriends(accountSteamId, friendsList, account) {
    try {
      this.logger.debug(`[${account.username || account.steam_login}] Creating negotiations for ${friendsList.length} friends`);
      
      let negotiations = await this.httpClient.loadNegotiations(accountSteamId);
      
      if (!negotiations) {
        // Extract our Steam login from credentials file
        let ourSteamLogin = this.steamLoginExtractor.getSteamLogin(accountSteamId);
        if (!ourSteamLogin) {
          this.logger.warn(`Could not extract Steam login for ${accountSteamId} - using Steam ID as fallback`);
          ourSteamLogin = accountSteamId;
        }

        negotiations = {
          account_steam_id: accountSteamId,
          account_username: account?.username || account?.steam_login || null,
          our_steam_login: ourSteamLogin,  // NEW: Our Steam login for admin notifications
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          our_inventory: null,
          our_inventory_updated_at: null,
          trade_offers: [],  // NEW: Account-level trade offers
          trade_offers_updated_at: null,  // NEW: Account-level timestamp
          negotiations: {}
        };

        this.logger.info(`Created new negotiations structure for ${ourSteamLogin} (${accountSteamId})`);
      }

      // Ensure account-level fields exist (migration support)
      if (!negotiations.trade_offers) {
        negotiations.trade_offers = [];
      }
      if (!negotiations.trade_offers_updated_at) {
        negotiations.trade_offers_updated_at = null;
      }
      // Ensure our_steam_login exists (migration support)
      if (!negotiations.our_steam_login) {
        let ourSteamLogin = this.steamLoginExtractor.getSteamLogin(accountSteamId);
        if (!ourSteamLogin) {
          this.logger.warn(`Could not extract Steam login for ${accountSteamId} - using Steam ID as fallback`);
          ourSteamLogin = accountSteamId;
        }
        negotiations.our_steam_login = ourSteamLogin;
        this.logger.info(`Added our_steam_login '${ourSteamLogin}' to existing negotiations for ${accountSteamId}`);
      }

      if (!negotiations.negotiations) {
        negotiations.negotiations = {};
      }
      
      let newNegotiationsCount = 0;

      for (const friend of friendsList) {
        let friendSteamId = friend.friend_steam_id || friend.steam_id || friend.steamId;
        
        if (!friendSteamId) {
          this.logger.warn(`Friend object missing steam ID: ${JSON.stringify(friend)}`);
          continue;
        }

        const relationship = friend.relationship || 'unknown';
        if (relationship === 'friend') {
          if (!negotiations.negotiations[friendSteamId]) {
            negotiations.negotiations[friendSteamId] = await this.createNewNegotiationWithSource(friendSteamId);
            newNegotiationsCount++;
            this.logger.debug(`Created negotiation for friend ${friendSteamId} with source: ${negotiations.negotiations[friendSteamId].source}`);
          } else {
            negotiations.negotiations[friendSteamId] = this.ensureNegotiationFields(
              negotiations.negotiations[friendSteamId]
            );
            
            if (!negotiations.negotiations[friendSteamId].source) {
              const source = await this.determineNegotiationSource(friendSteamId);
              negotiations.negotiations[friendSteamId].source = source;
              negotiations.negotiations[friendSteamId].updated_at = new Date().toISOString();
              this.logger.debug(`Updated existing negotiation for friend ${friendSteamId} with source: ${source}`);
            }
            
            this.logger.debug(`Updated existing negotiation for friend ${friendSteamId} with new fields`);
          }
        }
      }

      if (newNegotiationsCount > 0) {
        await this.httpClient.saveNegotiations(accountSteamId, negotiations);
        this.logger.info(`[${account.username || account.steam_login}] Created ${newNegotiationsCount} new negotiations for confirmed friends`);
      } else {
        await this.httpClient.saveNegotiations(accountSteamId, negotiations);
        this.logger.debug(`[${account.username || account.steam_login}] Updated existing negotiations with source information`);
      }

    } catch (error) {
      this.logger.error(`Error creating negotiations for friends: ${error.message}`);
    }
  }

  // ==================== CLEANUP ====================

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      
      if (this.httpClient) {
        await this.httpClient.cleanup();
      }
      
      // Cleanup queue cleanup manager
      if (this.queueCleanupManager) {
        await this.queueCleanupManager.cleanup();
      }
      
      this.logger.info('NegotiationManager cleanup completed');
    } catch (error) {
      this.logger.error(`Error during NegotiationManager cleanup: ${error.message}`);
    }
  }
}

module.exports = NegotiationManager;