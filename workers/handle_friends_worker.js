// automate_trading/workers/handle_friends_worker.js

const BaseWorker = require('./base_worker');
const DjangoClient = require('../shared/django_client');
const SteamSessionManager = require('../shared/steam_session_manager');
const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');

// Import simplified managers and handlers
const AccountConnectionManager = require('./managers/account_connection_manager');
const ResilienceManager = require('./managers/resilience_manager');
const NegotiationManager = require('./managers/negotiation_manager');
const SteamEventHandler = require('./handlers/steam_event_handler');
const DjangoOperationHandler = require('./handlers/django_operation_handler');

const fs = require('fs-extra');

class HandleFriendsWorker extends BaseWorker {
  constructor(config) {
    super('HandleFriendsWorker', config);
    
    // Initialize Django client and session manager
    this.djangoClient = new DjangoClient();
    this.sessionManager = SteamSessionManager;

    // Initialize HTTP client for queue operations
    this.httpClient = new HttpClient(config, this.logger);

    // Initialize trade offer queue for reconnection syncs
    this.tradeOfferQueue = createQueueManager('trade_offer_queue', config, this.logger, this.httpClient);

    // Initialize orchestration queue for trade offer change reactions
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, this.logger, this.httpClient);

    // Initialize specialized managers
    this.connectionManager = new AccountConnectionManager(config, this.logger);
    this.resilienceManager = new ResilienceManager(config, this.logger);
    this.negotiationManager = new NegotiationManager(config, this.logger);
    this.steamEventHandler = new SteamEventHandler(this.djangoClient, this.sessionManager, this.logger);
    this.djangoOperationHandler = new DjangoOperationHandler(this.djangoClient, this.logger);

    // Cross-manager dependencies
    this.setupManagerDependencies();
    
    // Worker state - PERSISTENT MODE
    this.persistentMode = true;
    this.maxExpectedConnections = parseInt(process.env.MAX_PERSISTENT_CONNECTIONS) || 50;
    
    // Historical message processing configuration
    this.historicalMessageConfig = config.historicalMessages;
    
    // Timers
    this.tokenRefreshTimer = null;
    this.friendsSyncTimer = null;
    this.healthCheckTimer = null;
    this.accountSyncTimer = null;

    // Dynamic sync interval with exponential backoff
    this.defaultSyncInterval = 60 * 1000; // Immutable original default
    this.baseSyncInterval = 60 * 1000; // Current base (can be overridden via Redis)
    this.currentSyncInterval = 60 * 1000; // Current interval (adjusted dynamically)
    this.maxSyncInterval = 480 * 1000; // 8 minutes max
    
    this.logger.info(`HandleFriendsWorker initialized in PERSISTENT mode (target: ${this.maxExpectedConnections} connections)`);
    this.logger.info(`Credentials source: ${config.persistentConnections.credentialsFile}`);
  }

  /**
   * Setup cross-dependencies for persistent connections
   */
  setupManagerDependencies() {
    // Connection manager needs resilience manager for error handling
    this.connectionManager.setResilienceManager(this.resilienceManager);

    // Connection manager needs steam event handler for proper setup
    this.connectionManager.setSteamEventHandler(this.steamEventHandler);

    // Steam event handler needs connection manager for client access
    this.steamEventHandler.setConnectionManager(this.connectionManager);

    // Steam event handler needs trade offer queue for creating sync tasks
    this.steamEventHandler.setTradeOfferQueue(this.tradeOfferQueue);

    // Steam event handler needs orchestration queue for trade offer change reactions
    this.steamEventHandler.setOrchestrationQueue(this.orchestrationQueue);

    // Steam event handler needs Django operation handler for retries
    this.steamEventHandler.setDjangoOperationHandler(this.djangoOperationHandler);

    // Steam event handler needs negotiation manager
    this.steamEventHandler.setNegotiationManager(this.negotiationManager);

    // Resilience manager needs connection manager for retry operations
    this.resilienceManager.setConnectionManager(this.connectionManager);

    // Negotiation manager needs connection manager
    this.negotiationManager.setConnectionManager(this.connectionManager);

    this.logger.info('✓ Manager dependencies configured for persistent connections (no prioritization)');
  }

  async initialize() {
    this.logger.info('Initializing HandleFriendsWorker in persistent mode...');
    
    // Validate environment
    await this.validateEnvironment();
    
    // Test Django connectivity
    await this.testDjangoConnectivity();
    
    // Initialize negotiation manager
    await this.negotiationManager.initialize();
    
    // Start persistent connection system
    await this.initializePersistentConnections();
    
    this.logger.info('HandleFriendsWorker initialization complete');
  }

  async validateEnvironment() {
    // Check .env.steam.portion file
    const credentialsFile = this.config.persistentConnections.credentialsFile;
    const credentialsExists = await fs.pathExists(credentialsFile);
    
    if (!credentialsExists) {
      throw new Error(`Steam credentials file (${credentialsFile}) not found`);
    }
    
    this.logger.info(`✓ Credentials file found: ${credentialsFile}`);
    
    // Load steam environment variables from portion file
    require('dotenv').config({ path: credentialsFile });
    
    // Check SteamUser and SteamTotp dependencies
    try {
      require('steam-user');
      require('steam-totp');
    } catch (error) {
      throw new Error(`Missing Steam dependencies: ${error.message}`);
    }
  }

  async testDjangoConnectivity() {
    try {
      const response = await this.djangoClient.getActiveAccounts();
      this.logger.info('Django API connectivity verified');
    } catch (error) {
      this.logger.error(`Django API connectivity test failed: ${error.message}`);
      throw new Error('Cannot connect to Django API');
    }
  }

  /**
   * Initialize persistent connection system
   */
  async initializePersistentConnections() {
    try {
      this.logger.info('Starting persistent connection system...');
      
      // Connect to all accounts persistently
      const connectionResult = await this.connectionManager.connectAllAccounts();
      
      this.logger.info(`Persistent connections established: ${connectionResult.successful} successful, ${connectionResult.failed} failed`);
      
      if (connectionResult.successful === 0) {
        this.logger.warn('No successful connections established - service will continue with retry attempts');
        this.logger.warn('Check .env.steam.portion file for missing credentials or connection issues');
        // Don't throw error - let the service continue and retry failed connections
      } else {
        this.logger.info(`Service operational with ${connectionResult.successful} active connections`);
      }
      
      // Start periodic tasks
      this.startPeriodicTasks();
      
      this.logger.info('Persistent connection system initialized successfully');
      
    } catch (error) {
      this.logger.error(`Error initializing persistent connections: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start periodic tasks for persistent connections
   */
  startPeriodicTasks() {
    // Token refresh timer (every hour)
    this.tokenRefreshTimer = setInterval(async () => {
      try {
        await this.connectionManager.checkTokenRefreshNeeded();
      } catch (error) {
        this.logger.error(`Error in token refresh: ${error.message}`);
      }
    }, 60 * 60 * 1000); // 1 hour
    
    // Expired invites check timer (every 30 minutes)
    this.friendsSyncTimer = setInterval(async () => {
      try {
        await this.checkExpiredInvites();
      } catch (error) {
        this.logger.error(`Error checking expired invites: ${error.message}`);
      }
    }, 30 * 60 * 1000); // 30 minutes
    
    // Health check timer (every 2 minutes)
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error(`Error in health check: ${error.message}`);
      }
    }, 2 * 60 * 1000); // 2 minutes

    // Account sync timer - starts immediately and reschedules dynamically
    this.scheduleNextSyncCycle();

    this.logger.info('Periodic tasks started: token refresh (1h), expired invites (30min), health check (2min), account sync (dynamic)');
  }

  /**
   * Schedule next sync cycle with current interval
   */
  scheduleNextSyncCycle() {
    // Clear any existing timer
    if (this.accountSyncTimer) {
      clearTimeout(this.accountSyncTimer);
    }

    // Schedule next cycle
    this.accountSyncTimer = setTimeout(async () => {
      await this.runSyncCycle();
    }, this.currentSyncInterval);

    this.logger.debug(`Next sync cycle scheduled in ${this.currentSyncInterval / 1000}s`);
  }

  /**
   * Read connection control settings from Redis and apply them.
   * - syncIntervalSeconds: overrides baseSyncInterval (persists until cleared)
   * - priorityAccounts: consumed (cleared from Redis) and added to in-memory priority queue
   */
  async applyConnectionControl() {
    try {
      const control = await this.httpClient.pollConnectionControl();

      // Apply sync interval override
      if (control.syncIntervalSeconds !== null) {
        const newBase = control.syncIntervalSeconds * 1000;
        if (newBase !== this.baseSyncInterval) {
          this.logger.info(`Sync interval override from Redis: ${control.syncIntervalSeconds}s (was ${this.baseSyncInterval / 1000}s)`);
          this.baseSyncInterval = newBase;
          this.currentSyncInterval = newBase;
          this.sessionManager.updateSyncInterval(this.currentSyncInterval);
        }
      }

      // Handle priority accounts: filter to what this instance can handle
      if (control.priorityAccounts.length > 0) {
        const claimable = control.priorityAccounts.filter(
          login => this.connectionManager.hasCredentials(login)
        );
        const unclaimed = control.priorityAccounts.length - claimable.length;

        if (claimable.length > 0) {
          const alreadyOnline = [];
          const newlyClaimed = [];

          for (const steamLogin of claimable) {
            const existing = this.connectionManager.getClientByLogin(steamLogin);

            if (existing && existing.clientData.isOnline) {
              // Already connected and online — SREM from Redis immediately, nothing else to do
              alreadyOnline.push(steamLogin);
              this.sessionManager.clearPriorityRequest(steamLogin);
            } else {
              if (existing) {
                // In activeClients but offline/stuck — force remove so this cycle's sync
                // sees it in accountsNeedingConnection and reconnects it as priority
                this.connectionManager.removeClient(existing.accountId);
                this.logger.info(`Priority account ${steamLogin} was offline in activeClients, removed for immediate reconnect`);
              }
              // Add to in-memory priority queue. Redis SREM is deferred until after
              // the account actually connects (see runSyncCycle), so the priority
              // survives a process restart.
              const alreadyQueued = this.sessionManager.getPriorityConnectionRequests().includes(steamLogin);
              this.sessionManager.requestPriorityConnection(steamLogin);
              if (!alreadyQueued) {
                newlyClaimed.push(steamLogin);
              }
            }
          }

          if (alreadyOnline.length > 0) {
            await this.httpClient.claimPriorityAccounts(alreadyOnline);
            this.logger.info(`Priority accounts already online, cleared from Redis: ${alreadyOnline.join(', ')}`);
          }
          if (newlyClaimed.length > 0) {
            this.logger.info(`Priority connections claimed: ${newlyClaimed.join(', ')}`);
          }
        }

        if (unclaimed > 0) {
          this.logger.debug(`${unclaimed} priority account(s) left in Redis for other instances`);
        }
      }

    } catch (error) {
      // Non-fatal: don't interrupt the sync cycle if Redis control is unavailable
      this.logger.warn(`Could not load connection control from Redis: ${error.message}`);
    }
  }

  /**
   * Run sync cycle and adjust interval based on result
   */
  async runSyncCycle() {
    try {
      // Apply any dynamic control settings from Redis before running the sync
      await this.applyConnectionControl();

      // Run the sync
      const result = await this.connectionManager.syncAccountsWithDjango();

      // Adjust interval based on result
      if (result.attempted) {
        if (result.success) {
          // If this was a priority connection, remove it from Redis now that it succeeded.
          // Send both the Django casing and lowercase to clean up whichever the user added.
          if (result.isPriority && result.steamLogin) {
            try {
              const toRemove = [...new Set([result.steamLogin, result.steamLogin.toLowerCase()])];
              await this.httpClient.claimPriorityAccounts(toRemove);
            } catch (err) {
              this.logger.warn(`Could not remove priority ${result.steamLogin} from Redis after connection: ${err.message}`);
            }
          }

          // Reset to base interval
          if (this.currentSyncInterval !== this.baseSyncInterval) {
            this.logger.info(`Connection successful - sync interval reset to ${this.baseSyncInterval / 1000}s`);
            this.currentSyncInterval = this.baseSyncInterval;
            // Notify SteamSessionManager of interval change
            this.sessionManager.updateSyncInterval(this.currentSyncInterval);
          }
        } else if (!result.isPermanent) {
          // Retryable error - double the interval
          const oldInterval = this.currentSyncInterval;
          this.currentSyncInterval = Math.min(this.currentSyncInterval * 2, this.maxSyncInterval);

          if (this.currentSyncInterval !== oldInterval) {
            this.logger.warn(`Retryable error - increasing sync interval from ${oldInterval / 1000}s to ${this.currentSyncInterval / 1000}s`);
            // Notify SteamSessionManager of interval change
            this.sessionManager.updateSyncInterval(this.currentSyncInterval);
          }
        }
        // For permanent errors (isPermanent=true), keep current interval unchanged
      }

    } catch (error) {
      this.logger.error(`Error in sync cycle: ${error.message}`);
    } finally {
      // Always schedule next cycle
      this.scheduleNextSyncCycle();
    }
  }

  // BaseWorker implementation
  getInterval() {
    // Main work cycle for Django operation retries and resilience checks
    return this.resilienceManager.getWorkInterval();
  }

  /**
   * SIMPLIFIED: Main work cycle - health monitoring and maintenance
   */
  async doWork() {
    // Step 1: Retry failed accounts (if not in global cooldown)
    await this.resilienceManager.retryFailedAccounts();
    
    // Step 2: Retry failed Django operations
    await this.djangoOperationHandler.retryFailedOperations();
    
    // Step 3: Connection statistics logging (less frequent)
    if (this.shouldLogConnectionStats()) {
      this.logConnectionSummary();
    }
  }

  /**
   * SIMPLIFIED: Perform health check without mass disconnection detection
   */
  async performHealthCheck() {
    const connectionStats = this.connectionManager.getConnectionStats();
    const resilienceStats = this.resilienceManager.getResilienceStats();
    const djangoStats = this.djangoOperationHandler.getOperationStats();
    
    this.logger.info(`Health Check: ${connectionStats.online}/${connectionStats.total} connections online, ${connectionStats.reconnecting} reconnecting`);
    
    // Log various queue statuses
    if (resilienceStats.failedAccountsCount > 0) {
      this.logger.warn(`${resilienceStats.failedAccountsCount} accounts awaiting retry`);
    }
    
    if (resilienceStats.manualInterventionCount > 0) {
      this.logger.warn(`${resilienceStats.manualInterventionCount} accounts need manual intervention`);
    }
    
    if (djangoStats.queueSize > 0) {
      this.logger.warn(`${djangoStats.queueSize} Django operations awaiting retry`);
    }
    
    if (resilienceStats.globalCooldownActive) {
      this.logger.warn(`Global cooldown active: ${resilienceStats.remainingMinutes}min remaining (failure #${resilienceStats.consecutiveFailures})`);
    }
    
    // Update session manager to keep sessions fresh
    this.updateSessionManagerStatus();
  }

  /**
   * Update session manager with current connection status
   */
  updateSessionManagerStatus() {
    try {
      const allClients = this.connectionManager.getAllClients();
      
      for (const [accountId, clientData] of allClients) {
        if (clientData.isOnline && clientData.client?.steamID) {
          // Mark session as recently used
          this.sessionManager.markSessionUsed(accountId);
          
          // Update session status
          this.sessionManager.updateSessionStatus(accountId, true);
        } else {
          // Update session status as offline
          this.sessionManager.updateSessionStatus(accountId, false);
        }
      }
    } catch (error) {
      this.logger.error(`Error updating session manager status: ${error.message}`);
    }
  }

  /**
   * Check if we should log connection stats (every 10 cycles or 10 minutes)
   */
  shouldLogConnectionStats() {
    // Simple counter-based approach
    this.workCycleCount = (this.workCycleCount || 0) + 1;
    return this.workCycleCount % 10 === 0;
  }

  /**
   * Log connection summary with persistent connection stats
   */
  logConnectionSummary() {
    const connectionStats = this.connectionManager.getConnectionStats();
    const resilienceStats = this.resilienceManager.getResilienceStats();
    const sessionStats = this.sessionManager.getStats();
    
    this.logger.info(`=== PERSISTENT CONNECTIONS SUMMARY ===`);
    this.logger.info(`Connections: ${connectionStats.online}/${connectionStats.total} online (${connectionStats.reconnecting} reconnecting)`);
    this.logger.info(`Session Manager: ${sessionStats.available} available sessions`);
    this.logger.info(`Resilience: ${resilienceStats.failedAccountsCount} retrying, ${resilienceStats.manualInterventionCount} manual intervention`);
    
    if (resilienceStats.globalCooldownActive) {
      this.logger.warn(`Global cooldown: ${resilienceStats.remainingMinutes}min remaining`);
    }
    
    // Sample of online connections
    const allClients = this.connectionManager.getAllClients();
    const onlineClients = Array.from(allClients.entries())
      .filter(([_, clientData]) => clientData.isOnline && clientData.client?.steamID)
      .slice(0, 3);
    
    onlineClients.forEach(([accountId, clientData]) => {
      const connectedTime = Math.round((Date.now() - clientData.connectedAt) / 60000);
      this.logger.info(`  Online: ${clientData.account.username || clientData.account.steam_login} (${connectedTime}min)`);
    });
    
    if (onlineClients.length < connectionStats.online) {
      this.logger.info(`  ... and ${connectionStats.online - onlineClients.length} more online connections`);
    }
    
    this.logger.info(`======================================`);
  }

  async checkExpiredInvites() {
    try {
      const result = await this.djangoClient.markInvitesExpired();
      
      if (result.success && result.expired_count > 0) {
        this.logger.info(`Marked ${result.expired_count} invites as expired`);
      }
      
    } catch (error) {
      this.logger.error(`Error checking expired invites: ${error.message}`);
    }
  }

  /**
   * Override BaseWorker's stop to handle all timers
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    // Stop all timers
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
      this.logger.info('Token refresh timer stopped');
    }
    
    if (this.friendsSyncTimer) {
      clearInterval(this.friendsSyncTimer);
      this.friendsSyncTimer = null;
      this.logger.info('Friends sync timer stopped');
    }
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      this.logger.info('Health check timer stopped');
    }

    if (this.accountSyncTimer) {
      clearTimeout(this.accountSyncTimer);
      this.accountSyncTimer = null;
      this.logger.info('Account sync timer stopped');
    }

    // Stop base worker interval
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.cleanup();
  }

  /**
   * SIMPLIFIED: Cleanup all managers in proper order
   */
  async cleanup() {
    this.logger.info('HandleFriendsWorker cleanup started');
    
    try {
      // Clear all timers first
      if (this.tokenRefreshTimer) {
        clearInterval(this.tokenRefreshTimer);
        this.tokenRefreshTimer = null;
      }
      if (this.friendsSyncTimer) {
        clearInterval(this.friendsSyncTimer);
        this.friendsSyncTimer = null;
      }
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }
      if (this.accountSyncTimer) {
        clearTimeout(this.accountSyncTimer);
        this.accountSyncTimer = null;
      }
      
      // Cleanup all managers in proper order
      // 1. Steam event handler first (stops event processing)
      await this.steamEventHandler.cleanup();
      
      // 2. Negotiation manager
      await this.negotiationManager.cleanup();
      
      // 3. Connection manager (logs out all clients)
      await this.connectionManager.cleanup();
      
      // 4. Django operation handler
      await this.djangoOperationHandler.cleanup();
      
      // 5. Resilience manager last
      await this.resilienceManager.cleanup();
      
      this.logger.info('HandleFriendsWorker cleanup completed successfully');
    } catch (error) {
      this.logger.error(`Error during worker cleanup: ${error.message}`);
    }
  }

  /**
   * Get worker statistics for monitoring
   */
  getWorkerStats() {
    const connectionStats = this.connectionManager.getConnectionStats();
    const resilienceStats = this.resilienceManager.getResilienceStats();
    const djangoStats = this.djangoOperationHandler.getOperationStats();
    const sessionStats = this.sessionManager.getStats();
    
    return {
      mode: 'persistent',
      connections: connectionStats,
      resilience: resilienceStats,
      djangoOperations: djangoStats,
      sessionManager: sessionStats,
      maxExpectedConnections: this.maxExpectedConnections,
      credentialsFile: this.config.persistentConnections.credentialsFile,
      workCycleCount: this.workCycleCount || 0,
      timestamp: Date.now()
    };
  }

  /**
   * Force reconnection to specific account (for manual intervention)
   */
  async forceReconnectAccount(accountId) {
    try {
      const clientData = this.connectionManager.getClient(accountId);
      if (!clientData) {
        throw new Error(`Account ${accountId} not found in active connections`);
      }
      
      const username = clientData.account.username || clientData.account.steam_login;
      this.logger.info(`Force reconnecting account: ${username}`);
      
      // Remove current client
      this.connectionManager.removeClient(accountId);
      
      // Attempt new connection
      await this.connectionManager.initializeAccountConnection(clientData.account, true);
      
      this.logger.info(`Force reconnection successful for ${username}`);
      return true;
      
    } catch (error) {
      this.logger.error(`Force reconnection failed for account ${accountId}: ${error.message}`);
      throw error;
    }
  }
}

module.exports = HandleFriendsWorker;