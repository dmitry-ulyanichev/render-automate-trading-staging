// automate_trading/workers/managers/account_connection_manager.js

const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const fs = require('fs-extra');
const CredentialCleaner = require('../../utils/credential_cleaner');

/**
 * PERSISTENT CONNECTIONS: Manages Steam account connections without rotation
 * 
 * Features:
 * - Persistent connections to all accounts simultaneously 
 * - Intelligent reconnection with LogonSessionReplaced courtesy delay
 * - Credentials from .env.steam.portion instead of .env.steam
 * - No rotation - maintains all connections continuously
 */
class AccountConnectionManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Dependencies (set via dependency injection)
    this.resilienceManager = null;
    this.steamEventHandler = null;
    
    // Active Steam clients storage
    this.activeClients = new Map(); // accountId -> { client, account, credentials, ... }
    
    // Connection configuration
    this.tokenRefreshInterval = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
    this.credentialsFile = config.persistentConnections.credentialsFile; // .env.steam.portion
    
    // Reconnection management per account
    this.reconnectionTimers = new Map(); // accountId -> timer
    this.reconnectionAttempts = new Map(); // accountId -> attempts
    this.maxReconnectAttempts = 8;
    this.backoffDelays = this.parseBackoffDelays(config.errorHandling.connectionErrors.backoffDelaysSeconds);
    this.sessionReplacedDelay = config.steamUserConnection.sessionReplacedDelaySeconds * 1000; // 60s in ms

    // Permanent failure tracking (3 strikes and you're out)
    this.permanentFailures = new Map(); // accountId -> { account, attempts, errors: [] }
    this.maxPermanentFailureAttempts = 3;
    this.excludedAccounts = new Set(); // accountIds to never try again
    
    this.logger.info(`AccountConnectionManager initialized for persistent connections`);
    this.logger.info(`Credentials file: ${this.credentialsFile}, Session replaced delay: ${this.sessionReplacedDelay/1000}s`);
  }

  /**
   * Parse backoff delays from config string
   */
  parseBackoffDelays(configString) {
    try {
      return configString.split(',').map(str => parseInt(str.trim()) * 1000); // Convert to milliseconds
    } catch (error) {
      this.logger.warn(`Invalid backoff config: ${configString}, using default`);
      return [15000, 30000, 60000, 120000, 240000, 480000, 960000, 1920000]; // seconds -> milliseconds
    }
  }

  /**
   * Set resilience manager dependency
   */
  setResilienceManager(resilienceManager) {
    this.resilienceManager = resilienceManager;
  }

  /**
   * Set steam event handler dependency
   */
  setSteamEventHandler(steamEventHandler) {
    this.steamEventHandler = steamEventHandler;
  }

  /**
   * Connect all accounts - simplified to rely on sync cycles
   * Just validates credentials and lets sync cycles handle connections
   */
  async connectAllAccounts() {
    try {
      this.logger.info('Initializing connection manager...');

      // Load accounts from Django
      const { remainingAccounts: djangoAccounts, totalAccounts } = await this.getDjangoAccounts();

      if (totalAccounts === 0) {
        this.logger.warn('No accounts with available credentials found in .env.steam.portion');
        this.logger.warn('Service will start but no connections will be established');
        return { successful: 0, failed: 0, total: 0 };
      }

      this.logger.info(`Found ${totalAccounts} accounts with credentials`);
      this.logger.info('Connections will be established via sync cycles (1 account per minute)');

      return { successful: 0, failed: 0, total: totalAccounts };

    } catch (error) {
      this.logger.error(`Error initializing connection manager: ${error.message}`);
      throw error;
    }
  }


  /**
   * Get all active accounts from Django and filter by available credentials
   */
  async getDjangoAccounts() {
    const DjangoClient = require('../../shared/django_client');
    const djangoClient = new DjangoClient();
    
    try {
      const response = await djangoClient.getActiveAccounts();
      
      if (!response.success || !response.accounts) {
        throw new Error('Failed to load active accounts from Django');
      }
      
      const allAccounts = response.accounts || [];
      this.logger.info(`Loaded ${allAccounts.length} active accounts from Django`);
      
      // Filter accounts by available credentials in .env.steam.portion
      const accountsWithCredentials = await this.filterAccountsByCredentials(allAccounts);
      
      this.logger.info(`Filtered to ${accountsWithCredentials.length} accounts with available credentials in ${this.credentialsFile}`);
      
      // Return in same format as before for compatibility
      return {
        prioritizedAccounts: [], // No longer used
        remainingAccounts: accountsWithCredentials, // Only accounts with credentials
        totalAccounts: accountsWithCredentials.length
      };
      
    } catch (error) {
      this.logger.error(`Error loading accounts from Django: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check whether this instance has credentials for a given steam_login.
   */
  hasCredentials(steamLogin) {
    try {
      CredentialCleaner.loadCleanCredentials(steamLogin, this.credentialsFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check whether a steam_login is currently connected and online.
   * Used to detect already-connected priority accounts.
   */
  isConnectedByLogin(steamLogin) {
    for (const clientData of this.activeClients.values()) {
      if (clientData.account.steam_login === steamLogin && clientData.isOnline) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find an active client entry by steam_login (case-insensitive).
   * Returns { accountId, clientData } or null if not found.
   */
  getClientByLogin(steamLogin) {
    const loginLower = steamLogin.toLowerCase();
    for (const [accountId, clientData] of this.activeClients) {
      if (clientData.account.steam_login.toLowerCase() === loginLower) {
        return { accountId, clientData };
      }
    }
    return null;
  }

  /**
   * Filter accounts by available credentials in .env.steam.portion
   */
  async filterAccountsByCredentials(accounts) {
    const accountsWithCredentials = [];
    const accountsWithoutCredentials = [];
    
    for (const account of accounts) {
      const steamLogin = account.steam_login;
      
      try {
        // Try to load credentials using CredentialCleaner
        const credentials = CredentialCleaner.loadCleanCredentials(steamLogin, this.credentialsFile);
        
        accountsWithCredentials.push(account);
        this.logger.debug(`✓ Credentials found for ${steamLogin}`);
        
      } catch (error) {
        accountsWithoutCredentials.push(account);
        // Expected behavior: not all accounts have credentials in this service instance
        this.logger.debug(`✗ Missing credentials for ${steamLogin}`);
      }
    }
    
    if (accountsWithoutCredentials.length > 0) {
      this.logger.warn(`Skipping ${accountsWithoutCredentials.length} accounts without credentials:`);
      // accountsWithoutCredentials.forEach(account => {
      //   this.logger.warn(`  - ${account.steam_login} (${account.username || 'no username'})`);
      // });
    }
    
    return accountsWithCredentials;
  }

  /**
   * Initialize connection for a single account
   */
  async initializeAccountConnection(account, isReconnection = false) {
    const accountId = account.id;
    const username = account.username || account.steam_login;
    
    try {
      this.logger.info(`[${username}] ${isReconnection ? 'Reconnecting' : 'Connecting'}...`);
      
      // Load credentials for this account using CredentialCleaner
      const credentials = CredentialCleaner.loadCleanCredentials(account.steam_login, this.credentialsFile);
      
      // Create Steam client
      const client = new SteamUser();
      
      // Set up event handlers before login
      this.setupReconnectionEventHandlers(client, account, credentials);
      
      // Set up main event handlers via steam event handler
      if (this.steamEventHandler) {
        this.steamEventHandler.setupClientEventHandlers(client, account, credentials);
      }
      
      // Attempt login
      const loginSuccess = await this.loginWithCredentials(client, credentials);
      
      if (!loginSuccess) {
        throw new Error(`Failed to login for account ${username}`);
      }
      
      // Store client data
      this.activeClients.set(accountId, {
        client: client,
        account: account,
        credentials: credentials,
        lastTokenRefresh: Date.now(),
        isOnline: false,
        isProcessingWebSession: false,
        lastDisconnection: null,
        connectedAt: Date.now()
      });

      // Reset reconnection attempts on successful connection
      this.reconnectionAttempts.delete(accountId);

      this.logger.info(`[${username}] ${isReconnection ? 'Reconnection' : 'Connection'} successful`);

      return true;
      
    } catch (error) {
      this.logger.error(`[${username}] ${isReconnection ? 'Reconnection' : 'Connection'} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Setup reconnection-specific event handlers
   */
  setupReconnectionEventHandlers(client, account, credentials) {
    const accountId = account.id;
    const username = account.username || account.steam_login;
    
    // Handle disconnections with intelligent reconnection
    client.on('disconnected', async (eresult, msg) => {
      this.logger.warn(`[${username}] Disconnected: ${msg} (eresult: ${eresult})`);
      
      // Update client status
      this.updateClientStatus(accountId, { 
        isOnline: false, 
        lastDisconnection: Date.now() 
      });
      
      // Determine reconnection strategy
      await this.handleDisconnection(account, eresult, msg);
    });
    
    // Handle errors with intelligent reconnection
    client.on('error', async (err) => {
      this.logger.error(`[${username}] Steam client error: ${err.message}`);
      
      // Update client status
      this.updateClientStatus(accountId, { 
        isOnline: false, 
        lastDisconnection: Date.now() 
      });
      
      // Determine reconnection strategy
      await this.handleSteamError(account, err);
    });
  }

  /**
   * Handle disconnection - simplified, let sync cycle handle reconnection
   */
  async handleDisconnection(account, eresult, msg) {
    const accountId = account.id;
    const username = account.username || account.steam_login;

    // Simply remove the client - sync cycle will rediscover and reconnect
    this.logger.info(`[${username}] Disconnected - will be reconnected by sync cycle`);
    this.removeClient(accountId);
  }

  /**
   * Handle Steam errors - simplified, let sync cycle handle reconnection
   */
  async handleSteamError(account, err) {
    const accountId = account.id;
    const username = account.username || account.steam_login;

    // Simply remove the client - sync cycle will rediscover and reconnect
    this.logger.info(`[${username}] Error: ${err.message} - will be reconnected by sync cycle`);
    this.removeClient(accountId);
  }


  /**
   * Clear reconnection timer for account
   */
  clearReconnectionTimer(accountId) {
    const timer = this.reconnectionTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectionTimers.delete(accountId);
    }
  }

  /**
   * Login with credentials using SteamTotp (using shared secret directly)
   */
  async loginWithCredentials(client, credentials) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Login timeout after 30 seconds'));
      }, 30000);

      // Generate 2FA code using shared secret directly
      const twoFactorCode = SteamTotp.generateAuthCode(credentials.sharedSecret);

      // Handle login success
      client.once('loggedOn', () => {
        clearTimeout(timeout);
        resolve(true);
      });

      // Handle login errors
      client.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // Attempt login
      client.logOn({
        accountName: credentials.username,
        password: credentials.password,
        twoFactorCode: twoFactorCode
      });
    });
  }

  /**
   * Determine if an error is retryable
   */
  isRetryableError(err) {
    const message = err.message.toLowerCase();
    
    const retryablePatterns = [
      'noconnection',
      'timeout',
      'serviceunavailable',
      'connectivitytest',
      'network'
    ];
    
    const retryableEResults = [
      6,  // LoggedInElsewhere  
      13, // NoConnection
      22, // Timeout
      25  // ServiceUnavailable
    ];
    
    return retryablePatterns.some(pattern => message.includes(pattern)) || 
           retryableEResults.includes(err.eresult);
  }

  /**
   * Determine if a disconnection is retryable
   */
  isRetryableDisconnection(eresult, msg) {
    const message = msg.toLowerCase();
    
    const retryablePatterns = [
      'logonsessionreplaced',
      'noconnection',
      'timeout',
      'serviceunavailable',
      'connectivitytest'
    ];
    
    const retryableEResults = [
      5,  // LogonSessionReplaced
      6,  // LoggedInElsewhere  
      13, // NoConnection
      22, // Timeout
      25  // ServiceUnavailable
    ];
    
    return retryablePatterns.some(pattern => message.includes(pattern)) || 
           retryableEResults.includes(eresult);
  }

  /**
   * Update client status
   */
  updateClientStatus(accountId, updates) {
    const clientData = this.activeClients.get(accountId);
    if (clientData) {
      Object.assign(clientData, updates);
    }
  }

  /**
   * Check token refresh needed for all clients
   */
  async checkTokenRefreshNeeded() {
    const now = Date.now();

    for (const [accountId, clientData] of this.activeClients) {
      const timeSinceLastRefresh = now - clientData.lastTokenRefresh;

      if (timeSinceLastRefresh >= this.tokenRefreshInterval) {
        try {
          if (clientData.client.steamID && clientData.isOnline) {
            clientData.client.webLogOn();
            clientData.lastTokenRefresh = now;
          }
        } catch (error) {
          this.logger.error(`[${clientData.account.username || clientData.account.steam_login}] Error refreshing token: ${error.message}`);
        }
      }
    }
  }

  /**
   * Reload credentials from .env.steam.portion file
   */
  reloadCredentials() {
    try {
      this.logger.debug(`Reloading credentials from ${this.credentialsFile}...`);

      // Reload .env.steam.portion with override: true to pick up new credentials
      require('dotenv').config({ path: this.credentialsFile, override: true });

      this.logger.debug('Credentials reloaded successfully');
    } catch (error) {
      this.logger.error(`Error reloading credentials: ${error.message}`);
      throw error;
    }
  }

  /**
   * Sync accounts with Django - simplified ONE connection per cycle
   * Connects one random unconnected account (new or reconnection)
   */
  async syncAccountsWithDjango() {
    try {
      this.logger.debug('Running sync cycle...');

      // Reload credentials file to pick up any new credentials
      this.reloadCredentials();

      // Get current active accounts from Django
      const { remainingAccounts: djangoAccounts } = await this.getDjangoAccounts();

      // Create set of Django account IDs for comparison
      const djangoAccountIds = new Set(djangoAccounts.map(account => account.id));

      // Find accounts to remove (connected but not in Django or deactivated)
      const accountsToRemove = Array.from(this.activeClients.entries())
        .filter(([accountId, _]) => !djangoAccountIds.has(accountId))
        .map(([accountId, clientData]) => ({ accountId, clientData }));

      // Remove deactivated accounts first
      for (const { accountId, clientData } of accountsToRemove) {
        const username = clientData.account.username || clientData.account.steam_login;
        this.logger.info(`Removing deactivated account: ${username}`);
        await this.disconnectAccount(accountId);
      }

      // Find accounts needing connection (not connected and not excluded)
      const accountsNeedingConnection = djangoAccounts.filter(account =>
        !this.activeClients.has(account.id) &&
        !this.excludedAccounts.has(account.id)
      );

      if (accountsNeedingConnection.length === 0) {
        this.logger.debug(`Sync cycle: all accounts connected (${this.activeClients.size}/${djangoAccounts.length})`);
        return {
          attempted: false,
          success: null,
          connectedCount: this.activeClients.size,
          excludedCount: this.excludedAccounts.size
        };
      }

      // Check for priority connection requests from SteamSessionManager
      const SteamSessionManager = require('../../shared/steam_session_manager');
      const priorityRequests = SteamSessionManager.getPriorityConnectionRequests(false); // Don't clear yet

      // Filter accounts that have priority requests.
      // Redis priorities are by steam_login (matched case-insensitively);
      // MessageWorker priorities are by steam_id (exact match, IDs are numeric).
      const priorityRequestsLower = new Set(priorityRequests.map(r => r.toLowerCase()));
      const priorityAccounts = accountsNeedingConnection.filter(account =>
        priorityRequestsLower.has(account.steam_login.toLowerCase()) ||
        (account.steam_id && priorityRequests.includes(account.steam_id))
      );

      // Diagnostic: log priority state whenever there are pending priority requests
      if (priorityRequests.length > 0) {
        const blockedInActive = priorityRequests.filter(r =>
          Array.from(this.activeClients.values()).some(c =>
            c.account.steam_login === r ||
            c.account.steam_login.toLowerCase() === r.toLowerCase() ||
            c.account.steam_id === r
          )
        );
        const inExcluded = priorityRequests.filter(r =>
          Array.from(this.excludedAccounts).some(id => {
            const c = this.activeClients.get(id);
            return c && (c.account.steam_login === r || c.account.steam_id === r);
          })
        );
        this.logger.info(
          `[PriorityDebug] Pending: [${priorityRequests.join(', ')}] | ` +
          `In accountsNeedingConnection: [${priorityAccounts.map(a => a.steam_login).join(', ') || 'none'}] | ` +
          `Blocked in activeClients: [${blockedInActive.join(', ') || 'none'}] | ` +
          `Excluded account IDs total: ${this.excludedAccounts.size} | ` +
          `Possibly ID-excluded: [${inExcluded.join(', ') || 'none'}]`
        );
      }

      let accountToConnect;
      let isPriority = false;

      if (priorityAccounts.length > 0) {
        // Randomly select from priority accounts
        const randomIndex = Math.floor(Math.random() * priorityAccounts.length);
        accountToConnect = priorityAccounts[randomIndex];
        isPriority = true;
        this.logger.info(`Sync cycle: connecting priority account (${priorityAccounts.length} priority requests)`);
      } else {
        // No priority requests, randomly select from all unconnected accounts
        const randomIndex = Math.floor(Math.random() * accountsNeedingConnection.length);
        accountToConnect = accountsNeedingConnection[randomIndex];
      }

      const username = accountToConnect.username || accountToConnect.steam_login;

      this.logger.info(`[${username}] Connecting... (${accountsNeedingConnection.length} accounts need connection)`);

      // Attempt connection
      try {
        await this.initializeAccountConnection(accountToConnect, false);

        // Success - clear any permanent failure tracking
        this.permanentFailures.delete(accountToConnect.id);

        // Clear any priority request for this account regardless of whether it was
        // selected as a priority — it may have connected via the random path while
        // a priority request was already pending (which would leave it stuck forever).
        SteamSessionManager.clearPriorityRequest(accountToConnect.steam_login);
        SteamSessionManager.clearPriorityRequest(accountToConnect.steam_login.toLowerCase());
        if (accountToConnect.steam_id) {
          SteamSessionManager.clearPriorityRequest(accountToConnect.steam_id);
        }
        if (isPriority) {
          this.logger.info(`Sync cycle: cleared priority request for ${username}`);
        }

        this.logger.info(`Sync cycle: connection successful (${this.activeClients.size}/${djangoAccounts.length} connected)`);

        return {
          attempted: true,
          success: true,
          accountId: accountToConnect.id,
          username: username,
          steamLogin: accountToConnect.steam_login,
          isPriority: isPriority,
          connectedCount: this.activeClients.size,
          excludedCount: this.excludedAccounts.size
        };

      } catch (error) {
        // Connection failed - track it
        this.trackConnectionFailure(accountToConnect, error);

        this.logger.warn(`Sync cycle: connection failed for ${username}: ${error.message}`);

        return {
          attempted: true,
          success: false,
          accountId: accountToConnect.id,
          username: username,
          error: error.message,
          isPermanent: this.excludedAccounts.has(accountToConnect.id),
          connectedCount: this.activeClients.size,
          excludedCount: this.excludedAccounts.size
        };
      }

    } catch (error) {
      this.logger.error(`Error in sync cycle: ${error.message}`);
      throw error;
    }
  }

  /**
   * Track connection failure and implement 3-strikes rule for permanent failures
   */
  trackConnectionFailure(account, error) {
    const accountId = account.id;
    const username = account.username || account.steam_login;

    // Check if error is permanent (account-specific) or retryable (temporary)
    const isPermanent = this.isPermanentError(error);

    if (!isPermanent) {
      // Retryable error - don't track, will be retried next cycle
      this.logger.debug(`[${username}] Retryable error - will retry in next cycle`);
      return;
    }

    // Permanent error - track attempts
    let failureInfo = this.permanentFailures.get(accountId);

    if (!failureInfo) {
      failureInfo = {
        account: account,
        attempts: 0,
        errors: []
      };
      this.permanentFailures.set(accountId, failureInfo);
    }

    failureInfo.attempts++;
    failureInfo.errors.push({
      message: error.message,
      timestamp: Date.now()
    });

    this.logger.warn(`[${username}] Permanent error (attempt ${failureInfo.attempts}/${this.maxPermanentFailureAttempts}): ${error.message}`);

    // Check if reached max attempts
    if (failureInfo.attempts >= this.maxPermanentFailureAttempts) {
      this.excludedAccounts.add(accountId);
      this.permanentFailures.delete(accountId);
      this.logger.error(`[${username}] Permanently excluded after ${this.maxPermanentFailureAttempts} failed attempts - will not retry`);
    }
  }

  /**
   * Determine if error is permanent (account-specific) or retryable
   */
  isPermanentError(error) {
    const message = error.message.toLowerCase();

    const permanentPatterns = [
      'invalid password',
      'password not found',
      'shared_secret not found',
      'mobile authenticator',
      'invalid credentials',
      'account disabled',
      'accountlogindeniedneedtwofactor',
      'invalidloginauthcode'
    ];

    return permanentPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Get connection statistics
   */
  getConnectionStats() {
    let total = 0;
    let online = 0;
    let offline = 0;
    let reconnecting = 0;
    
    for (const [accountId, clientData] of this.activeClients) {
      total++;
      
      if (this.reconnectionTimers.has(accountId)) {
        reconnecting++;
      } else if (clientData.isOnline && clientData.client.steamID) {
        online++;
      } else {
        offline++;
      }
    }
    
    return {
      total: total,
      online: online,
      offline: offline,
      reconnecting: reconnecting,
      pendingReconnections: this.reconnectionTimers.size,
      timestamp: Date.now()
    };
  }

  /**
   * Get active client by account ID
   */
  getClient(accountId) {
    return this.activeClients.get(accountId);
  }

  /**
   * Get all active clients
   */
  getAllClients() {
    return new Map(this.activeClients);
  }

  /**
   * Check if account has active client
   */
  hasActiveClient(accountId) {
    return this.activeClients.has(accountId);
  }

  /**
   * Remove client and cleanup
   */
  removeClient(accountId) {
    const clientData = this.activeClients.get(accountId);
    if (clientData) {
      try {
        clientData.client.removeAllListeners();
        clientData.client.logOff();
      } catch (error) {
        // Continue with removal even if logoff fails
      }
      this.activeClients.delete(accountId);
    }

    // Clear reconnection timer
    this.clearReconnectionTimer(accountId);
  }

  /**
   * Gracefully disconnect an account (used for deactivation)
   */
  async disconnectAccount(accountId) {
    const clientData = this.activeClients.get(accountId);
    if (!clientData) {
      this.logger.warn(`Cannot disconnect account ${accountId} - not found in active clients`);
      return;
    }

    const username = clientData.account.username || clientData.account.steam_login;
    this.logger.info(`[${username}] Gracefully disconnecting (deactivated in Django)...`);

    try {
      // Remove from session manager
      const SteamSessionManager = require('../../shared/steam_session_manager');
      SteamSessionManager.removeSession(accountId);

      // Remove event listeners
      clientData.client.removeAllListeners();

      // Gracefully log off
      clientData.client.logOff();

      // Remove from active clients
      this.activeClients.delete(accountId);

      // Clear any reconnection timers
      this.clearReconnectionTimer(accountId);

      // Clear reconnection attempts
      this.reconnectionAttempts.delete(accountId);

      this.logger.info(`[${username}] Successfully disconnected`);
    } catch (error) {
      this.logger.error(`[${username}] Error during disconnect: ${error.message}`);
      // Force removal even if disconnect failed
      this.activeClients.delete(accountId);
      this.clearReconnectionTimer(accountId);
      this.reconnectionAttempts.delete(accountId);
    }
  }

  /**
   * Cleanup all connections
   */
  async cleanup() {
    this.logger.info('AccountConnectionManager cleanup started');
    
    // Clear all reconnection timers
    for (const timer of this.reconnectionTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectionTimers.clear();
    this.reconnectionAttempts.clear();
    
    // Logout all active clients
    for (const [accountId, clientData] of this.activeClients) {
      try {
        const username = clientData.account.username || clientData.account.steam_login;
        this.logger.debug(`[${username}] Logging out...`);
        clientData.client.removeAllListeners();
        clientData.client.logOff();
      } catch (error) {
        this.logger.error(`Error logging out ${clientData.account.username || clientData.account.steam_login}: ${error.message}`);
      }
    }
    
    this.activeClients.clear();
    
    this.logger.info('AccountConnectionManager cleanup completed');
  }
}

module.exports = AccountConnectionManager;