// automate_trading/workers/managers/resilience_manager.js

/**
 * Manages resilience aspects for HandleFriendsWorker
 * 
 * Responsible for:
 * - Global rate limiting and cooldowns
 * - Failed account retry logic
 * - Manual intervention account tracking
 * - Error classification and handling
 * - Work interval adjustment based on system state
 */
class ResilienceManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Connection manager reference (set via dependency injection)
    this.connectionManager = null;
    
    // Failed accounts tracking
    this.failedAccounts = new Map(); // accountId -> failureInfo
    this.manualInterventionAccounts = new Map(); // accountId -> account
    
    // Global rate limit configuration
    this.globalCooldownMinutes = config.steamUserConnection.globalCooldownMinutes;
    this.maxGlobalCooldownMinutes = config.steamUserConnection.maxGlobalCooldownMinutes || 480; // 8 hours max
    
    // Global rate limit state
    this.globalRateLimit = {
      isActive: false,
      startTime: null,
      baseCooldownPeriod: this.globalCooldownMinutes * 60 * 1000,
      currentCooldownPeriod: this.globalCooldownMinutes * 60 * 1000,
      maxCooldownPeriod: this.maxGlobalCooldownMinutes * 60 * 1000,
      consecutiveFailures: 0
    };
    
    this.logger.info(`ResilienceManager initialized - base cooldown: ${this.globalCooldownMinutes}min, max: ${this.maxGlobalCooldownMinutes}min`);
  }

  /**
   * Set connection manager dependency (called from main worker)
   */
  setConnectionManager(connectionManager) {
    this.connectionManager = connectionManager;
  }

  /**
   * Get appropriate work interval based on system state
   */
  getWorkInterval() {
    // Use shorter interval when we have pending retries or active global cooldown
    if (this.globalRateLimit.isActive || this.failedAccounts.size > 0) {
      return 60 * 1000; // 1 minute during active issues
    }
    
    // Normal interval for stable operation
    return 5 * 60 * 1000; // 5 minutes when everything is stable
  }

  /**
   * Check if currently in global cooldown
   */
  isInGlobalCooldown() {
    if (!this.globalRateLimit.isActive) return false;
    
    const elapsed = Date.now() - this.globalRateLimit.startTime;
    const stillInCooldown = elapsed < this.globalRateLimit.currentCooldownPeriod;
    
    if (!stillInCooldown) {
      // Cooldown expired - reset but don't clear consecutive failures (until successful connection)
      this.globalRateLimit.isActive = false;
      const cooldownMinutes = Math.round(this.globalRateLimit.currentCooldownPeriod / 60000);
      this.logger.info(`Global rate limit cooldown expired after ${cooldownMinutes}min, ready to retry connections`);
    }
    
    return stillInCooldown;
  }

  /**
   * Update global rate limit state with exponential backoff
   */
  updateGlobalRateLimit(error) {
    this.globalRateLimit.isActive = true;
    this.globalRateLimit.startTime = Date.now();
    this.globalRateLimit.consecutiveFailures++;
    
    // Exponential backoff: 1min → 2min → 4min → 8min → ... → max 480min
    const backoffMultiplier = Math.pow(2, this.globalRateLimit.consecutiveFailures - 1);
    this.globalRateLimit.currentCooldownPeriod = Math.min(
      this.globalRateLimit.baseCooldownPeriod * backoffMultiplier,
      this.globalRateLimit.maxCooldownPeriod
    );
    
    const cooldownMinutes = Math.round(this.globalRateLimit.currentCooldownPeriod / 60000);
    this.logger.warn(`Global rate limit #${this.globalRateLimit.consecutiveFailures} - cooling down for ${cooldownMinutes}min (exponential backoff)`);
  }

  /**
   * Reset global rate limit on successful connection
   */
  resetGlobalRateLimit() {
    if (this.globalRateLimit.consecutiveFailures > 0) {
      this.logger.info(`Global rate limit reset - successful connection after ${this.globalRateLimit.consecutiveFailures} failures`);
      this.globalRateLimit.consecutiveFailures = 0;
      this.globalRateLimit.currentCooldownPeriod = this.globalRateLimit.baseCooldownPeriod;
    }
  }

  /**
   * Activate global cooldown for mass disconnection scenario
   */
  activateGlobalCooldownForMassDisconnection() {
    if (!this.globalRateLimit.isActive) {
      this.logger.warn(`Activating global cooldown due to mass disconnection - preventing reconnection storm`);
      this.globalRateLimit.isActive = true;
      this.globalRateLimit.startTime = Date.now();
      this.globalRateLimit.consecutiveFailures++;
      this.globalRateLimit.currentCooldownPeriod = Math.min(
        this.globalRateLimit.baseCooldownPeriod * 5, // 5 minutes for mass disconnection
        this.globalRateLimit.maxCooldownPeriod
      );
    }
  }

  /**
   * Classify error types for appropriate handling
   */
  classifyError(error) {
    const message = error.message.toLowerCase();
    
    // Rate limiting errors that should trigger global cooldown
    const rateLimitPatterns = [
      'ratelimitexceeded',
      'accountlogindeniedthrottle'
    ];
    
    // Retryable errors that don't require global cooldown
    const retryablePatterns = [
      'logonsessionreplaced',
      'noconnection', 
      'connectivitytestfailure',
      'timeout',
      'serviceunavailable',
      'login timeout after 30 seconds'
    ];
    
    // Non-retryable errors requiring manual intervention
    const manualInterventionPatterns = [
      'password not found',
      'mobile authenticator file not found',
      'shared_secret not found',
      'invalid credentials',
      'account disabled'
    ];
    
    if (rateLimitPatterns.some(pattern => message.includes(pattern))) {
      return 'rate_limit';
    } else if (retryablePatterns.some(pattern => message.includes(pattern))) {
      return 'retryable';
    } else if (manualInterventionPatterns.some(pattern => message.includes(pattern))) {
      return 'manual_intervention';
    } else {
      return 'unknown';
    }
  }

  /**
   * Schedule account for retry after global cooldown expires
   */
  scheduleAccountForGlobalRetry(account) {
    this.failedAccounts.set(account.id, {
      account: account,
      lastAttempt: Date.now(),
      attempts: 1,
      lastError: 'Scheduled for retry due to global rate limit',
      rateLimited: true,
      nextRetry: this.globalRateLimit.startTime + this.globalRateLimit.currentCooldownPeriod,
      errorType: 'rate_limit'
    });
    
    this.logger.warn(`[${account.username || account.steam_login}] Scheduled for global retry after cooldown`);
  }

  /**
   * Schedule account for individual retry (connection issues, timeouts, etc.)
   */
  scheduleAccountForIndividualRetry(account, error) {
    // Simple 5-minute retry for connection issues
    const retryDelay = 5 * 60 * 1000; // 5 minutes
    
    this.failedAccounts.set(account.id, {
      account: account,
      lastAttempt: Date.now(),
      attempts: 1,
      lastError: error.message,
      rateLimited: false,
      nextRetry: Date.now() + retryDelay,
      errorType: 'retryable'
    });
    
    this.logger.warn(`[${account.username || account.steam_login}] Connection issue, will retry in 5min: ${error.message}`);
  }

  /**
   * Mark account as needing manual intervention (non-retryable)
   */
  markAccountForManualIntervention(account, error) {
    this.manualInterventionAccounts.set(account.id, {
      account: account,
      error: error.message,
      timestamp: Date.now(),
      errorType: 'manual_intervention'
    });
    
    this.logger.error(`Account ${account.username || account.steam_login} requires manual intervention: ${error.message}`);
  }

  /**
   * Get accounts ready for retry (both rate limited and connection issues)
   */
  getAccountsReadyForRetry() {
    const now = Date.now();
    const readyToRetry = [];
    
    for (const [accountId, failureInfo] of this.failedAccounts) {
      // Retry both rate limited and connection issue accounts when their time comes
      if (now >= failureInfo.nextRetry) {
        readyToRetry.push(failureInfo);
      }
    }
    
    // Sort by next retry time (oldest first)
    return readyToRetry.sort((a, b) => a.nextRetry - b.nextRetry);
  }

  /**
   * Retry failed accounts that are ready
   */
  async retryFailedAccounts() {
    // Skip if in global cooldown
    if (this.isInGlobalCooldown()) {
      return;
    }
    
    const readyToRetry = this.getAccountsReadyForRetry();
    
    if (readyToRetry.length === 0) return;
    
    this.logger.info(`Retrying ${readyToRetry.length} failed account(s) after their cooldown periods`);
    
    // Try only ONE account per health check cycle to avoid overwhelming Steam
    const accountToRetry = readyToRetry[0];
    
    try {
      await this.retryAccountConnection(accountToRetry);
      
    } catch (error) {
      // If this fails with rate limit again, reactivate global cooldown
      if (this.classifyError(error) === 'rate_limit') {
        this.updateGlobalRateLimit(error);
        this.logger.warn(`Rate limited again during retry - extending global cooldown`);
      }
    }
  }

  /**
   * Retry individual account connection
   */
  async retryAccountConnection(failureInfo) {
    if (!this.connectionManager) {
      throw new Error('Connection manager not set - cannot retry account connection');
    }
    
    const account = failureInfo.account;
    
    try {
      // Attempt connection again using connection manager
      await this.connectionManager.initializeAccountConnection(account);
      
      // SUCCESS: Remove from failed accounts
      this.failedAccounts.delete(account.id);
      
      this.logger.info(`[${account.username || account.steam_login}] Retry successful after ${failureInfo.attempts} attempts`);
      
    } catch (error) {
      const errorType = this.classifyError(error);
      
      if (errorType === 'rate_limit') {
        // Update the failure info for next retry
        this.scheduleAccountForGlobalRetry(account);
        throw error; // Will trigger global cooldown in caller
      } else if (errorType === 'manual_intervention') {
        // Move to manual intervention list
        this.failedAccounts.delete(account.id);
        this.markAccountForManualIntervention(account, error);
      } else {
        // Some other error, keep in failed list with incremented attempts
        failureInfo.attempts++;
        failureInfo.lastAttempt = Date.now();
        failureInfo.lastError = error.message;
        failureInfo.nextRetry = Date.now() + (5 * 60 * 1000); // 5 minutes
        this.logger.error(`[${account.username || account.steam_login}] Retry failed: ${error.message}`);
      }
    }
  }

  /**
   * Get resilience statistics for monitoring
   */
  getResilienceStats() {
    const failedAccountsCount = this.failedAccounts.size;
    const manualInterventionCount = this.manualInterventionAccounts.size;
    
    let remainingMinutes = 0;
    if (this.globalRateLimit.isActive) {
      remainingMinutes = Math.ceil((this.globalRateLimit.currentCooldownPeriod - (Date.now() - this.globalRateLimit.startTime)) / 60000);
    }
    
    return {
      globalCooldownActive: this.globalRateLimit.isActive,
      consecutiveFailures: this.globalRateLimit.consecutiveFailures,
      remainingMinutes: remainingMinutes,
      failedAccountsCount: failedAccountsCount,
      manualInterventionCount: manualInterventionCount,
      currentInterval: this.getWorkInterval(),
      timestamp: Date.now()
    };
  }

  /**
   * Get detailed failed account information for debugging
   */
  getFailedAccountsDetails() {
    const details = [];
    
    for (const [accountId, failureInfo] of this.failedAccounts) {
      details.push({
        accountId: accountId,
        username: failureInfo.account.username || failureInfo.account.steam_login,
        attempts: failureInfo.attempts,
        lastError: failureInfo.lastError,
        errorType: failureInfo.errorType,
        rateLimited: failureInfo.rateLimited,
        nextRetryIn: Math.max(0, Math.ceil((failureInfo.nextRetry - Date.now()) / 1000)),
        lastAttemptAgo: Math.ceil((Date.now() - failureInfo.lastAttempt) / 1000)
      });
    }
    
    return details.sort((a, b) => a.nextRetryIn - b.nextRetryIn);
  }

  /**
   * Get manual intervention accounts details
   */
  getManualInterventionDetails() {
    const details = [];
    
    for (const [accountId, accountInfo] of this.manualInterventionAccounts) {
      details.push({
        accountId: accountId,
        username: accountInfo.account.username || accountInfo.account.steam_login,
        error: accountInfo.error,
        errorType: accountInfo.errorType,
        timestampAgo: Math.ceil((Date.now() - accountInfo.timestamp) / 1000)
      });
    }
    
    return details.sort((a, b) => a.timestampAgo - b.timestampAgo);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    this.logger.info('ResilienceManager cleanup started');
    
    // Clear failed accounts maps
    this.failedAccounts.clear();
    this.manualInterventionAccounts.clear();
    
    // Reset global rate limit state
    this.globalRateLimit.isActive = false;
    this.globalRateLimit.consecutiveFailures = 0;
    
    this.logger.info('ResilienceManager cleanup completed');
  }
}

module.exports = ResilienceManager;