// automate_trading/workers/trade_offer_worker.js

const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');
const DjangoClient = require('../shared/django_client');
const TradeOfferDataTransformer = require('./helpers/trade_offer_data_transformer');
const TradeOfferContextManager = require('./helpers/trade_offer_context_manager');
const SteamTradeOperations = require('./helpers/steam_trade_operations');
const axios = require('axios');

/**
 * TradeOfferWorker - Real Steam Trade Offer Implementation
 * Processes trade_offer_queue tasks and updates orchestration pending_tasks
 *
 * Features:
 * - Creates real Steam trade offers via steam-tradeoffer-manager
 * - Accepts, declines, and cancels trade offers
 * - Syncs trade offer states from Steam
 * - Properly handles ai_requested_actions according to Scenario 9
 * - Updates account-level trade_offers in negotiation JSON
 */
class TradeOfferWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Worker configuration
    this.workerName = 'TradeOfferWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.tradeOffer?.processInterval || 4000; // 4 seconds default
    this.batchSize = config.tradeOffer?.batchSize || 2; // Process up to 2 tasks per cycle
    
    // Initialize HTTP client for negotiation JSON updates
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.tradeOfferQueue = createQueueManager('trade_offer_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);

    // Initialize Django client for Trade model operations
    this.djangoClient = new DjangoClient();

    // Initialize data transformer for trade offer conversions
    this.dataTransformer = new TradeOfferDataTransformer(logger);

    // Initialize context manager for orchestration/negotiation updates
    this.contextManager = new TradeOfferContextManager(
      this.orchestrationQueue,
      this.httpClient,
      this.djangoClient,
      this.dataTransformer,
      logger,
      this.workerName
    );

    // Initialize Steam trade operations handler
    this.steamOperations = new SteamTradeOperations(
      this.orchestrationQueue,
      this.dataTransformer,
      logger,
      this.workerName
    );

    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      tasksSkipped: 0,
      errors: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };

    // Track tasks currently being processed to prevent duplicates
    this.processingTasks = new Set();

    // Timers
    this.processTimer = null;
    this.statsTimer = null;
    this.periodicSyncTimer = null;

    // Periodic sync configuration
    this.periodicSyncEnabled = config.tradeOffer?.periodicSyncEnabled !== false;
    this.periodicSyncIntervalHours = config.tradeOffer?.periodicSyncIntervalHours || 24;

    this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms, Batch size: ${this.batchSize}`);
    if (this.periodicSyncEnabled) {
      this.logger.info(`${this.workerName} Periodic sync enabled - Interval: ${this.periodicSyncIntervalHours} hours`);
    }
  }

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    this.logger.info(`Starting ${this.workerName}...`);

    this.isRunning = true;
    this.stats.startedAt = new Date().toISOString();

    // Start processing loop
    this.startProcessingLoop();

    // Start statistics reporting
    this.startStatsReporting();

    // Start periodic sync if enabled
    if (this.periodicSyncEnabled) {
      this.startPeriodicSync();
    }

    this.logger.info(`${this.workerName} started successfully`);
  }

  /**
   * Stop the worker
   */
  async stop() {
    if (!this.isRunning) {
      this.logger.warn(`${this.workerName} is not running`);
      return;
    }

    this.logger.info(`Stopping ${this.workerName}...`);

    this.isRunning = false;

    // Clear timers
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }

    this.logger.info(`${this.workerName} stopped successfully`);
  }

  /**
   * Pause the worker temporarily
   */
  pause() {
    this.isPaused = true;
    this.logger.info(`${this.workerName} paused`);
  }

  /**
   * Resume the worker
   */
  resume() {
    this.isPaused = false;
    this.logger.info(`${this.workerName} resumed`);
  }

  /**
   * Start the processing loop
   */
  startProcessingLoop() {
    this.processTimer = setInterval(async () => {
      if (!this.isRunning || this.isPaused) {
        return;
      }

      try {
        this.stats.cycleCount++;
        await this.processBatch();
      } catch (error) {
        this.logger.error(`${this.workerName} processing loop error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.processInterval);
  }

  /**
   * Start statistics reporting
   */
  startStatsReporting() {
    this.statsTimer = setInterval(() => {
      if (this.stats.cycleCount % 10 === 0 && this.stats.cycleCount > 0) {
        this.logger.info(`${this.workerName} Stats - Cycles: ${this.stats.cycleCount}, Processed: ${this.stats.tasksProcessed}, Errors: ${this.stats.errors}`);
      }
    }, this.processInterval * 3);
  }

  /**
   * Start periodic trade offer sync
   * Runs every N hours to sync all accounts' trade offers
   */
  startPeriodicSync() {
    const intervalMs = this.periodicSyncIntervalHours * 60 * 60 * 1000;

    this.logger.info(`${this.workerName} Starting periodic sync - Interval: ${this.periodicSyncIntervalHours} hours (${intervalMs}ms)`);

    // REMOVED: Immediate sync on startup (now handled by historical message [tradeoffer] detection)
    // Historical message processing intelligently creates sync tasks when needed based on message timestamps

    // Run periodically (every 12 hours as safety net)
    this.periodicSyncTimer = setInterval(async () => {
      try {
        await this.performPeriodicSync();
      } catch (error) {
        this.logger.error(`${this.workerName} ❌ Periodic sync failed: ${error.message}`);
      }
    }, intervalMs);

    this.logger.info(`${this.workerName} ✅ Periodic sync timer started (first sync in ${this.periodicSyncIntervalHours} hours)`);
  }

  /**
   * Filter accounts by available credentials in .env.steam.portion
   */
  async filterAccountsByCredentials(accounts) {
    const CredentialCleaner = require('../utils/credential_cleaner');
    const credentialsFile = this.config.persistentConnections?.credentialsFile || '.env.steam.portion';

    const accountsWithCredentials = [];
    const accountsWithoutCredentials = [];

    for (const account of accounts) {
      const steamLogin = account.steam_login;

      try {
        // Try to load credentials using CredentialCleaner
        CredentialCleaner.loadCleanCredentials(steamLogin, credentialsFile);
        accountsWithCredentials.push(account);
        this.logger.debug(`${this.workerName} ✓ Credentials found for ${steamLogin}`);
      } catch (error) {
        accountsWithoutCredentials.push(account);
        this.logger.debug(`${this.workerName} ✗ Missing credentials for ${steamLogin}`);
      }
    }

    if (accountsWithoutCredentials.length > 0) {
      this.logger.warn(`${this.workerName} Skipping ${accountsWithoutCredentials.length} accounts without credentials:`);
      // accountsWithoutCredentials.forEach(account => {
      //   this.logger.warn(`${this.workerName}   - ${account.steam_login} (${account.username || 'no username'})`);
      // });
    }

    return accountsWithCredentials;
  }

  /**
   * Perform periodic sync for all active accounts
   * Queries Django for active accounts and creates updateTradeOffers tasks
   */
  async performPeriodicSync() {
    try {
      this.logger.info(`${this.workerName} 🔄 Starting periodic trade offer sync...`);

      // Query Django for all active accounts
      const response = await this.djangoClient.getActiveAccounts();

      // Debug: log response structure
      this.logger.debug(`${this.workerName} Active accounts response type: ${typeof response}, isArray: ${Array.isArray(response)}, keys: ${Object.keys(response || {}).join(', ')}`);

      // Handle different response formats
      const allAccounts = Array.isArray(response) ? response : (response.accounts || response.data || []);

      if (!allAccounts || allAccounts.length === 0) {
        this.logger.info(`${this.workerName} No active accounts found for periodic sync`);
        return;
      }

      this.logger.info(`${this.workerName} Found ${allAccounts.length} active accounts from Django`);

      // Filter accounts by available credentials in .env.steam.portion
      const accounts = await this.filterAccountsByCredentials(allAccounts);

      if (accounts.length === 0) {
        this.logger.info(`${this.workerName} No accounts with available credentials for periodic sync`);
        return;
      }

      this.logger.info(`${this.workerName} Filtered to ${accounts.length} accounts with credentials for periodic sync`);

      let tasksCreated = 0;
      let tasksSkipped = 0;

      for (const account of accounts) {
        try {
          const steamId = account.steam_id;

          if (!steamId) {
            this.logger.warn(`${this.workerName} Skipping account ${account.id} - no steam_id`);
            tasksSkipped++;
            continue;
          }

          // Check if there's already a pending updateTradeOffers task for this account
          const existingTasks = await this.tradeOfferQueue.getTasks();
          const hasPendingSync = existingTasks.some(
            task => task.taskID === steamId && task.action === 'updateTradeOffers'
          );

          if (hasPendingSync) {
            this.logger.debug(`${this.workerName} Skipping ${steamId} - already has pending sync task`);
            tasksSkipped++;
            continue;
          }

          // Create updateTradeOffers task
          const syncTask = {
            taskID: steamId,
            action: 'updateTradeOffers',
            priority: 3, // Medium priority for periodic sync
            params: {
              reason: 'periodic_sync'
            },
            created_at: new Date().toISOString()
          };

          await this.tradeOfferQueue.addTask(syncTask);
          tasksCreated++;

          this.logger.debug(`${this.workerName} ✅ Created periodic sync task for ${steamId}`);

        } catch (error) {
          this.logger.error(`${this.workerName} ❌ Failed to create sync task for account ${account.id}: ${error.message}`);
          tasksSkipped++;
        }
      }

      this.logger.info(`${this.workerName} ✅ Periodic sync complete - Tasks created: ${tasksCreated}, Skipped: ${tasksSkipped}`);

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Periodic sync error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process a batch of tasks from the queue
   */
  async processBatch() {
    try {
      const tasks = await this.tradeOfferQueue.getTasks();
      
      if (tasks.length === 0) {
        return; // No tasks to process
      }
      
      // Filter tasks that are ready for execution AND not already being processed
      const readyTasks = tasks.filter(task => {
        // Skip if already being processed
        if (this.processingTasks.has(task.taskID)) {
          return false;
        }

        if (!task.execute) return true; // No delay specified, process immediately
        return new Date(task.execute) <= new Date(); // Execute time has passed
      });

      if (readyTasks.length === 0) {
        return; // No tasks ready for execution
      }

      // Process up to batchSize tasks
      const tasksToProcess = readyTasks.slice(0, this.batchSize);

      this.logger.info(`${this.workerName} processing ${tasksToProcess.length} tasks`);

      // Process each task
      for (const task of tasksToProcess) {
        // Mark task as being processed
        this.processingTasks.add(task.taskID);

        try {
          await this.processTask(task);

          // Remove task from queue after successful processing
          await this.tradeOfferQueue.removeTask(task.taskID);

          this.stats.tasksProcessed++;
          this.stats.lastProcessedAt = new Date().toISOString();
        } catch (error) {
          this.logger.error(`${this.workerName} failed to process task ${task.taskID}: ${error.message}`);
          this.stats.errors++;
        } finally {
          // Always remove from processing set when done
          this.processingTasks.delete(task.taskID);
        }
      }
    } catch (error) {
      this.logger.error(`${this.workerName} batch processing error: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single trade offer task (REAL IMPLEMENTATION)
   */
  async processTask(task) {
      const { taskID, priority, action, params, action_id } = task;

      this.logger.info(`${this.workerName} Processing trade offer action: ${action} for ${taskID}`);

      // Parse task ID to get Steam IDs (skip for updateTradeOffers which handles both formats internally)
      let steamIds = null;
      if (action !== 'updateTradeOffers') {
          steamIds = this.parseTaskID(taskID);
      }

      // Execute the real trade offer action
      let tradeOfferResult;

      try {
          switch (action) {
              case 'createTradeOffer':
                  tradeOfferResult = await this.steamOperations.createTradeOffer(task, this.parseTaskID.bind(this));
                  break;

              case 'acceptTradeOffer':
                  tradeOfferResult = await this.steamOperations.acceptTradeOffer(task, this.parseTaskID.bind(this));
                  break;

              case 'declineTradeOffer':
                  tradeOfferResult = await this.steamOperations.declineTradeOffer(task, this.parseTaskID.bind(this));
                  break;

              case 'cancelTradeOffer':
                  tradeOfferResult = await this.steamOperations.cancelTradeOffer(task, this.parseTaskID.bind(this));
                  break;

              case 'updateTradeOffers':
                  tradeOfferResult = await this.updateTradeOffers(task);
                  break;

              default:
                  this.logger.error(`${this.workerName} Unknown action: ${action}`);
                  tradeOfferResult = {
                      action: action,
                      success: false,
                      status: 'unknown_action',
                      error: `Unknown action type: ${action}`,
                      timestamp: new Date().toISOString()
                  };
          }
      } catch (error) {
          this.logger.error(`${this.workerName} Error executing ${action}: ${error.message}`);
          tradeOfferResult = {
              action: action,
              success: false,
              status: 'execution_failed',
              error: error.message,
              timestamp: new Date().toISOString()
          };
      }

      // Extract items from params (if available)
      const itemsToReceive = params?.items_to_receive || [];
      const itemsToGive = params?.items_to_give || [];

      // Log the execution details (handle updateTradeOffers which doesn't have steamIds parsed)
      const logData = {
          taskID,
          action,
          priority,
          itemsToReceiveCount: itemsToReceive ? itemsToReceive.length : 0,
          itemsToGiveCount: itemsToGive ? itemsToGive.length : 0,
          result: tradeOfferResult.status,
          success: tradeOfferResult.success,
          tradeOfferID: tradeOfferResult.tradeOfferID,
          actionId: action_id
      };

      // Add steamIds if they were parsed
      if (steamIds) {
          logData.ourSteamId = steamIds.ourSteamId;
          logData.friendSteamId = steamIds.friendSteamId;
      }

      this.logger.info(`${this.workerName} Completed trade offer action:`, logData);

      // Process AI requested actions correctly according to Scenario 9
      if (action_id) {
          const success = await this.contextManager.processAIRequestedActions(
            taskID,
            action_id,
            tradeOfferResult,
            this.parseTaskID.bind(this)
          );

          if (success) {
              this.logger.info(`${this.workerName} ✅ Successfully processed AI action ${action_id} for ${taskID}`);
          } else {
              this.logger.error(`${this.workerName} ❌ Failed to process AI action ${action_id} for ${taskID}`);
          }
      } else {
          // For non-AI actions from direct queue tasks
          if (action === 'createTradeOffer') {
              // Gift requests - create new trade offer
              await this.contextManager.updateOrchestrationContextForGiftRequest(
                taskID,
                action,
                tradeOfferResult,
                itemsToReceive,
                itemsToGive,
                this.parseTaskID.bind(this),
                this.syncTradeToDjango.bind(this)
              );
          } else if (['acceptTradeOffer', 'cancelTradeOffer', 'declineTradeOffer'].includes(action)) {
              // Direct accept/cancel/decline - update existing trade offer state
              await this.contextManager.updateTradeOfferState(
                taskID,
                action,
                tradeOfferResult,
                this.parseTaskID.bind(this),
                this.syncTradeToDjango.bind(this)
              );
          }

          // Remove from pending tasks (only for friend-level tasks with orchestration context)
          // Account-level tasks (like updateTradeOffers with steamId only) don't have orchestration tasks
          if (taskID.includes('_')) {
              await this.contextManager.updateOrchestrationPendingTasks(taskID, this.getCompletedPendingTask(action));
          } else {
              this.logger.debug(`${this.workerName} Skipping orchestration update for account-level task ${taskID}`);
          }
      }

      this.logger.info(`${this.workerName} Finished processing trade offer task for ${taskID}`);
  }

  /**
   * Sync trade offer to Django Trade model
   * @param {string} ourSteamId - Our Steam account ID
   * @param {Object} tradeOfferData - Trade offer data from JSON
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
          `${this.workerName} ✅ Synced trade ${tradeOfferData.trade_offer_id} to Django ` +
          `(${result.created ? 'created' : 'updated'}, state: ${stateName})`
        );
      } else {
        this.logger.error(
          `${this.workerName} ❌ Failed to sync trade ${tradeOfferData.trade_offer_id} to Django: ${result.error}`
        );
      }

      return result;

    } catch (error) {
      this.logger.error(
        `${this.workerName} Error syncing trade ${tradeOfferData.trade_offer_id} to Django: ${error.message}`
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * REAL IMPLEMENTATION: Update/sync all trade offers from Steam
   * Fetches offers from Steam (both active and historical) and merges with existing offers
   * Supports both account-level sync (taskID = steamId) and friend-level sync (taskID = steamId_friendSteamId)
   */
  async updateTradeOffers(task) {
    const { taskID } = task;

    try {
      this.logger.info(`${this.workerName} Updating trade offers for ${taskID}`);

      // Parse taskID - support both "steamId" and "steamId_friendSteamId" formats
      let ourSteamId, friendSteamId;
      if (taskID.includes('_')) {
        const parsed = this.parseTaskID(taskID);
        ourSteamId = parsed.ourSteamId;
        friendSteamId = parsed.friendSteamId;
      } else {
        // Account-level sync (e.g., after reconnection)
        ourSteamId = taskID;
        friendSteamId = null;
      }

      // Get auth token from Django
      const authTokenResponse = await this.djangoClient.getAuthTokenBySteamId(ourSteamId);
      if (!authTokenResponse.success || !authTokenResponse.token) {
        throw new Error(`No auth token found for account ${ourSteamId}`);
      }
      const authToken = authTokenResponse.token;

      // Load current negotiation data to determine time filter
      const currentNegotiations = await this.httpClient.loadNegotiations(ourSteamId);
      const existingOffers = currentNegotiations.trade_offers || [];

      // Calculate time cutoff for historical offers (Unix timestamp in seconds)
      let timeHistoricalCutoff;
      if (currentNegotiations.trade_offers_updated_at) {
        // Get offers updated since last sync (with 5 minute buffer)
        // Handle both ISO strings and Unix timestamp strings
        const rawValue = currentNegotiations.trade_offers_updated_at;
        let lastSync;
        if (/^\d+(\.\d+)?$/.test(rawValue)) {
          // Unix timestamp (seconds, possibly with decimals)
          lastSync = new Date(parseFloat(rawValue) * 1000);
        } else {
          lastSync = new Date(rawValue);
        }
        timeHistoricalCutoff = Math.floor((lastSync.getTime() - (5 * 60 * 1000)) / 1000); // Unix seconds
        this.logger.info(`${this.workerName} Using time filter: ${new Date(timeHistoricalCutoff * 1000).toISOString()}`);
      } else {
        // Get all offers from last 14 days if never synced (matches Steam's expiration period)
        timeHistoricalCutoff = Math.floor(Date.now() / 1000) - (14 * 24 * 60 * 60);
        this.logger.info(`${this.workerName} No previous sync - fetching offers from last 14 days`);
      }

      // Fetch offers from Steam Web API directly (bypassing steam-tradeoffer-manager to get all offers)
      this.logger.debug(`${this.workerName} Fetching all offers from Steam Web API...`);

      const steamApiResponse = await axios.get('https://api.steampowered.com/IEconService/GetTradeOffers/v1/', {
        params: {
          get_received_offers: 1,
          get_sent_offers: 1,
          active_only: 0,          // Get both active and inactive
          historical_only: 0,      // Get both current and historical
          get_descriptions: 1,     // Get item descriptions
          language: 'english',
          time_historical_cutoff: timeHistoricalCutoff,
          access_token: authToken
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      });

      if (!steamApiResponse.data || !steamApiResponse.data.response) {
        throw new Error('Invalid response from Steam API');
      }

      const apiData = steamApiResponse.data.response;
      const sentOffers = apiData.trade_offers_sent || [];
      const receivedOffers = apiData.trade_offers_received || [];

      this.logger.info(`${this.workerName} Found ${sentOffers.length} sent and ${receivedOffers.length} received offers from Steam Web API`);
      this.logger.debug(`${this.workerName} Sent offers: ${sentOffers.map(o => `${o.tradeofferid}(state=${o.trade_offer_state})`).join(', ')}`);

      // Build descriptions map for item names
      const descriptions = {};
      if (apiData.descriptions) {
        for (const desc of apiData.descriptions) {
          const key = `${desc.classid}_${desc.instanceid}`;
          descriptions[key] = desc;
        }
      }

      // Get list of current friends from negotiations
      const currentFriends = new Set(Object.keys(currentNegotiations.negotiations || {}));
      this.logger.debug(`${this.workerName} Current friends (${currentFriends.size}): ${Array.from(currentFriends).join(', ')}`);

      // States we care about (active negotiations)
      const relevantStates = new Set(['Active', 'InEscrow', 'Accepted', 'CreatedNeedsConfirmation']);

      // PHASE 1: Parse ALL offers (don't filter yet) to detect state changes
      const allParsedOffers = [];

      for (const rawOffer of sentOffers) {
        const parsedOffer = this.dataTransformer.parseRawOfferToJSON(rawOffer, descriptions);
        parsedOffer.is_our_offer = true; // Mark as sent offer
        allParsedOffers.push(parsedOffer);
      }

      for (const rawOffer of receivedOffers) {
        const parsedOffer = this.dataTransformer.parseRawOfferToJSON(rawOffer, descriptions);
        parsedOffer.is_our_offer = false; // Mark as received offer
        allParsedOffers.push(parsedOffer);
      }

      this.logger.debug(`${this.workerName} Parsed ${allParsedOffers.length} total offers from Steam API`);

      // PHASE 2: Detect state changes, sync to Django, and create orchestration tasks BEFORE filtering
      if (this.orchestrationQueue) {
        for (const parsedOffer of allParsedOffers) {
          const existingOffer = existingOffers.find(o => o.trade_offer_id === parsedOffer.trade_offer_id);

          if (existingOffer && existingOffer.state !== parsedOffer.state) {
            // State change detected!
            const friendSteamId = parsedOffer.friend_steam_id;

            // Only process state changes for current friends
            if (currentFriends.has(friendSteamId)) {
              this.logger.info(`${this.workerName} State change detected for offer ${parsedOffer.trade_offer_id}: ${existingOffer.state} → ${parsedOffer.state}`);

              // Update the existing offer in-place with new state
              existingOffer.state = parsedOffer.state;
              existingOffer.updated_at = new Date().toISOString();

              // Add to state history
              if (!existingOffer.state_history) {
                existingOffer.state_history = [];
              }
              existingOffer.state_history.push({
                state: parsedOffer.state,
                timestamp: new Date().toISOString()
              });

              // Sync to Django
              try {
                await this.syncTradeToDjango(ourSteamId, existingOffer, parsedOffer.state);
              } catch (error) {
                this.logger.error(`${this.workerName} Failed to sync state change to Django: ${error.message}`);
              }

              // Create orchestration task
              try {
                const SteamEventHandler = require('./handlers/steam_event_handler');
                const tempHandler = new SteamEventHandler(this.djangoClient, null, this.logger);
                tempHandler.setOrchestrationQueue(this.orchestrationQueue);
                tempHandler.httpClient = this.httpClient;

                const taskParams = tempHandler.checkOrchestrationTaskNeeded(
                  existingOffer.state_history[existingOffer.state_history.length - 2]?.state || existingOffer.state,
                  parsedOffer.state,
                  parsedOffer.is_our_offer,
                  parsedOffer,
                  currentNegotiations
                );

                if (taskParams) {
                  await tempHandler.createTradeOfferOrchestrationTask(ourSteamId, friendSteamId, taskParams);
                }
              } catch (error) {
                this.logger.error(`${this.workerName} Failed to create orchestration task for state change: ${error.message}`);
              }
            }
          }
        }
      }

      // PHASE 3: Now filter offers to keep only relevant states
      const fetchedOffers = [];
      let filteredOutCount = 0;

      for (const parsedOffer of allParsedOffers) {
        const isFriend = currentFriends.has(parsedOffer.friend_steam_id);
        const isRelevantState = relevantStates.has(parsedOffer.state);

        if (isFriend && isRelevantState) {
          fetchedOffers.push(parsedOffer);
        } else {
          filteredOutCount++;
        }
      }

      this.logger.info(`${this.workerName} Fetched ${fetchedOffers.length} trade offers from Steam (${filteredOutCount} filtered out)`);

      // Filter existing offers to only keep relevant ones (Active/InEscrow/Accepted for current friends)
      const filteredExistingOffers = existingOffers.filter(offer => {
        return currentFriends.has(offer.friend_steam_id) && relevantStates.has(offer.state);
      });

      const removedCount = existingOffers.length - filteredExistingOffers.length;
      if (removedCount > 0) {
        this.logger.info(`${this.workerName} Cleaned up ${removedCount} stale offers from storage`);
      }

      // Merge offers: update existing ones and add new ones
      const mergedOffers = [...filteredExistingOffers];
      let newCount = 0;
      let updatedCount = 0;

      for (const fetchedOffer of fetchedOffers) {
        const existingIndex = mergedOffers.findIndex(
          offer => offer.trade_offer_id === fetchedOffer.trade_offer_id
        );

        if (existingIndex >= 0) {
          // Update existing offer - preserve state_history and append new state if changed
          const existingOffer = mergedOffers[existingIndex];
          const currentState = fetchedOffer.state;
          if (!existingOffer.state_history) {
            existingOffer.state_history = [{ state: existingOffer.state, timestamp: existingOffer.updated_at || new Date().toISOString() }];
          }
          const lastState = existingOffer.state_history[existingOffer.state_history.length - 1]?.state;

          if (currentState !== lastState) {
            // State changed - add to history
            fetchedOffer.state_history = [
              ...existingOffer.state_history,
              {
                state: currentState,
                timestamp: new Date().toISOString()
              }
            ];
            updatedCount++;

            this.logger.info(`${this.workerName} 🔄 Offer ${fetchedOffer.trade_offer_id} state changed: ${lastState} → ${currentState}`);

            // Sync to Django Trade model
            try {
              await this.syncTradeToDjango(ourSteamId, fetchedOffer, currentState);
            } catch (error) {
              this.logger.error(`${this.workerName} ❌ Failed to sync updated offer to Django: ${error.message}`);
            }
          } else {
            // No state change - preserve existing history
            fetchedOffer.state_history = existingOffer.state_history;
          }

          mergedOffers[existingIndex] = fetchedOffer;
        } else {
          // New offer
          this.logger.info(`${this.workerName} 🆕 New offer discovered: ${fetchedOffer.trade_offer_id} (${fetchedOffer.state})`);
          mergedOffers.push(fetchedOffer);
          newCount++;

          // Sync to Django Trade model
          try {
            await this.syncTradeToDjango(ourSteamId, fetchedOffer, fetchedOffer.state);
          } catch (error) {
            this.logger.error(`${this.workerName} ❌ Failed to sync new offer to Django: ${error.message}`);
          }
        }
      }

      // Update negotiation JSON with merged offers
      // For account-level sync, update account-level trade_offers
      // For friend-level sync, update per-friend negotiation
      if (friendSteamId) {
        // Friend-level sync (existing behavior)
        await this.updateNegotiationContext(ourSteamId, friendSteamId, {
          trade_offers: mergedOffers,
          trade_offers_updated_at: new Date().toISOString()
        });
      } else {
        // Account-level sync - directly update account's trade_offers
        currentNegotiations.trade_offers = mergedOffers;
        currentNegotiations.trade_offers_updated_at = new Date().toISOString();
        await this.httpClient.saveNegotiations(ourSteamId, currentNegotiations);
      }

      this.logger.info(`${this.workerName} ✅ Successfully updated trade offers: ${newCount} new, ${updatedCount} updated, ${mergedOffers.length} total`);

      // CLEANUP ORPHANED OFFERS: Mark Django trades as Canceled if they don't exist in JSON
      try {
        this.logger.debug(`${this.workerName} Checking for orphaned trade offers in Django...`);

        // Get all active trades from Django for this account
        const djangoTradesResponse = await this.djangoClient.getActiveTradesBySteamId(ourSteamId);

        if (djangoTradesResponse.success && djangoTradesResponse.trades) {
          const djangoTrades = djangoTradesResponse.trades;
          this.logger.debug(`${this.workerName} Found ${djangoTrades.length} active trades in Django`);

          // Build a Set of trade_offer_ids that exist in our merged offers
          const jsonTradeOfferIds = new Set(mergedOffers.map(offer => offer.trade_offer_id));

          // Find orphaned trades (in Django but not in JSON)
          const orphanedTrades = djangoTrades.filter(
            djangoTrade => !jsonTradeOfferIds.has(djangoTrade.trade_offer_id)
          );

          if (orphanedTrades.length > 0) {
            this.logger.info(`${this.workerName} Found ${orphanedTrades.length} orphaned trade offer(s) in Django - marking as Canceled`);

            // Mark each orphaned trade as Canceled (state 6)
            let canceledCount = 0;
            for (const orphanedTrade of orphanedTrades) {
              try {
                const result = await this.djangoClient.updateTradeState(orphanedTrade.trade_offer_id, 6);

                if (result.success) {
                  this.logger.info(
                    `${this.workerName} ✅ Marked orphaned trade ${orphanedTrade.trade_offer_id} as Canceled ` +
                    `(was state ${orphanedTrade.state})`
                  );
                  canceledCount++;
                } else {
                  this.logger.error(
                    `${this.workerName} ❌ Failed to mark orphaned trade ${orphanedTrade.trade_offer_id} as Canceled: ${result.error}`
                  );
                }
              } catch (error) {
                this.logger.error(
                  `${this.workerName} ❌ Error marking orphaned trade ${orphanedTrade.trade_offer_id} as Canceled: ${error.message}`
                );
              }
            }

            this.logger.info(`${this.workerName} ✅ Cleaned up ${canceledCount}/${orphanedTrades.length} orphaned trade offers`);
          } else {
            this.logger.debug(`${this.workerName} No orphaned trade offers found`);
          }
        }
      } catch (error) {
        this.logger.error(`${this.workerName} ⚠️ Failed to cleanup orphaned offers (non-critical): ${error.message}`);
        // Don't throw - this is a non-critical cleanup operation
      }

      return {
        action: 'updateTradeOffers',
        success: true,
        status: 'offers_updated',
        updatedCount: updatedCount,
        newCount: newCount,
        totalCount: mergedOffers.length,
        activeOffers: sentOffers.length + receivedOffers.length,
        tradeOffers: mergedOffers,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Failed to update trade offers: ${error.message}`);

      return {
        action: 'updateTradeOffers',
        success: false,
        status: 'update_failed',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }


  /**
   * Get the pending task name that should be removed based on action
   * DEPRECATED: Use processAIRequestedActions for AI-related actions
   */
  getCompletedPendingTask(action) {
    // Map trade offer actions to pending task names
    const actionToPendingTask = {
      'createTradeOffer': 'create_trade_offer',
      'acceptTradeOffer': 'accept_trade_offer', 
      'cancelTradeOffer': 'cancel_trade_offer',
      'declineTradeOffer': 'decline_trade_offer',
      'updateTradeOffers': 'update_trade_offers'
    };

    return actionToPendingTask[action] || 'trade_offer_action';
  }

  /**
   * Parse taskID to extract Steam IDs
   */
  parseTaskID(taskID) {
    const parts = taskID.split('_');
    if (parts.length !== 2) {
      throw new Error(`Invalid taskID format: ${taskID}`);
    }
    return {
      ourSteamId: parts[0],
      friendSteamId: parts[1]
    };
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      queueStats: {
        tradeOffer: this.tradeOfferQueue.getStats(),
        orchestration: this.orchestrationQueue.getStats()
      }
    };
  }
}

module.exports = TradeOfferWorker;