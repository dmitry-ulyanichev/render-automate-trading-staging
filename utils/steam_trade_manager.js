// automate_trading/utils/steam_trade_manager.js

const TradeOfferManager = require('steam-tradeoffer-manager');
const SteamCommunity = require('steamcommunity');
const config = require('../config/config');

/**
 * SteamTradeManager - Singleton manager for steam-tradeoffer-manager instances
 *
 * Pattern similar to SteamSessionManager - maintains TradeOfferManager instances
 * for each Steam account's persistent connection.
 *
 * Key responsibilities:
 * - Store TradeOfferManager instances by Steam ID (not database accountId)
 * - Initialize managers when webSession is available
 * - Provide access methods for TradeOfferWorker
 * - Handle manager lifecycle (cleanup on disconnection)
 * - Setup real-time event listeners for trade offer changes
 */
class SteamTradeManager {
  constructor() {
    // Singleton pattern - only one instance
    if (SteamTradeManager.instance) {
      return SteamTradeManager.instance;
    }

    // Store TradeOfferManager instances by Steam ID
    // Map<steamId, { manager, account, cookies, registeredAt }>
    this.managers = new Map();

    // Track event listeners for cleanup
    this.eventListeners = new Map(); // steamId -> listener references

    SteamTradeManager.instance = this;
  }

  /**
   * Register a TradeOfferManager for an account
   * Called from SteamEventHandler when webSession is available
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @param {SteamUser} steamClient - Active steam-user client instance
   * @param {Object} account - Account data from Django
   * @param {Array} cookies - Web session cookies
   * @param {Object} logger - Logger instance
   * @returns {TradeOfferManager} The initialized manager
   */
  registerManager(steamId, steamClient, account, cookies, logger, identitySecret = null) {
    const username = account.username || account.steam_login;

    try {
      logger.info(`[SteamTradeManager] Initializing TradeOfferManager for ${username} (${steamId})`);

      // Create SteamCommunity instance for trade confirmations
      const community = new SteamCommunity();
      community.setCookies(cookies);

      // Create TradeOfferManager instance
      const manager = new TradeOfferManager({
        steam: steamClient,        // Use existing steam-user connection
        community: community,     // SteamCommunity instance for confirmations
        language: 'en',           // Trade offer language
        pollInterval: 30000,      // Poll every 30 seconds for changes
        cancelTime: 0,            // Don't auto-cancel offers
        pendingCancelTime: 0,     // Don't auto-cancel pending offers
        cancelOfferCount: 0,      // Don't auto-cancel by count
        dataDirectory: null       // Don't persist poll data to disk (ephemeral in Docker)
      });

      // Set web session cookies
      manager.setCookies(cookies);

      // Set Steam Web API key (required for creating trade offers)
      if (config.steam && config.steam.apiKey) {
        manager.apiKey = config.steam.apiKey;
        logger.info(`[SteamTradeManager] ✓ API key set for ${username} (${config.steam.apiKey.substring(0, 10)}...)`);
      } else {
        logger.warn(`[SteamTradeManager] ⚠️ No Steam API key configured - trade offers may fail`);
      }

      if (identitySecret) {
        logger.info(`[SteamTradeManager] ✓ Identity secret available for ${username} - trade confirmation enabled`);
      } else {
        logger.warn(`[SteamTradeManager] ⚠️ No identity secret for ${username} - trade offers will require manual confirmation`);
      }

      // Store manager data by Steam ID
      this.managers.set(steamId, {
        manager: manager,
        community: community,
        identitySecret: identitySecret,
        account: account,
        cookies: cookies,
        registeredAt: Date.now(),
        steamClient: steamClient
      });

      logger.info(`[SteamTradeManager] ✓ TradeOfferManager registered for ${username} (${steamId})`);

      return manager;

    } catch (error) {
      logger.error(`[SteamTradeManager] Failed to register manager for ${username}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Setup event listeners for real-time trade offer updates
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @param {Function} onNewOffer - Handler for new incoming offers
   * @param {Function} onSentOfferChanged - Handler for sent offer state changes
   * @param {Function} onReceivedOfferChanged - Handler for received offer state changes
   * @param {Object} logger - Logger instance
   */
  setupEventListeners(steamId, onNewOffer, onSentOfferChanged, onReceivedOfferChanged, logger) {
    const managerData = this.managers.get(steamId);
    if (!managerData) {
      logger.warn(`[SteamTradeManager] Cannot setup listeners - no manager for Steam ID ${steamId}`);
      return;
    }

    const { manager, account } = managerData;
    const username = account.username || account.steam_login;

    logger.info(`[SteamTradeManager] Setting up event listeners for ${username}`);

    // Store listener references for cleanup
    const listeners = {
      newOffer: null,
      sentOfferChanged: null,
      receivedOfferChanged: null
    };

    // Listen for new incoming trade offers
    if (onNewOffer) {
      listeners.newOffer = (offer) => {
        logger.info(`[SteamTradeManager] 🆕 New trade offer received for ${username}: ${offer.id}`);
        onNewOffer(offer, account, steamId);
      };
      manager.on('newOffer', listeners.newOffer);
    }

    // Listen for changes in sent offers (we created)
    if (onSentOfferChanged) {
      listeners.sentOfferChanged = (offer, oldState) => {
        logger.info(`[SteamTradeManager] 📤 Sent offer state changed for ${username}: ${offer.id} (${oldState} → ${offer.state})`);
        onSentOfferChanged(offer, oldState, account, steamId);
      };
      manager.on('sentOfferChanged', listeners.sentOfferChanged);
    }

    // Listen for changes in received offers (sent to us)
    if (onReceivedOfferChanged) {
      listeners.receivedOfferChanged = (offer, oldState) => {
        logger.info(`[SteamTradeManager] 📥 Received offer state changed for ${username}: ${offer.id} (${oldState} → ${offer.state})`);
        onReceivedOfferChanged(offer, oldState, account, steamId);
      };
      manager.on('receivedOfferChanged', listeners.receivedOfferChanged);
    }

    // Store listener references
    this.eventListeners.set(steamId, listeners);

    logger.info(`[SteamTradeManager] ✓ Event listeners registered for ${username}`);
  }

  /**
   * Get TradeOfferManager for an account
   * Used by TradeOfferWorker to perform trade offer operations
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {TradeOfferManager|null} The manager instance or null if not found
   */
  getManager(steamId) {
    const managerData = this.managers.get(steamId);
    return managerData ? managerData.manager : null;
  }

  /**
   * Get SteamCommunity instance for an account (used for trade confirmations)
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {SteamCommunity|null} The community instance or null
   */
  getCommunity(steamId) {
    const managerData = this.managers.get(steamId);
    return managerData ? managerData.community : null;
  }

  /**
   * Get identity secret for an account (used for trade confirmations)
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {string|null} The identity secret or null
   */
  getIdentitySecret(steamId) {
    const managerData = this.managers.get(steamId);
    return managerData ? managerData.identitySecret : null;
  }

  /**
   * Get manager data (includes account info)
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {Object|null} Manager data or null
   */
  getManagerData(steamId) {
    return this.managers.get(steamId) || null;
  }

  /**
   * Check if manager exists and is ready for an account
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @returns {boolean} True if manager exists
   */
  hasManager(steamId) {
    return this.managers.has(steamId);
  }

  /**
   * Get all registered Steam IDs
   *
   * @returns {Array<string>} Array of Steam IDs
   */
  getAccountIds() {
    return Array.from(this.managers.keys());
  }

  /**
   * Remove manager for an account (cleanup on disconnection)
   *
   * @param {string} steamId - Steam ID (64-bit)
   * @param {Object} logger - Logger instance
   */
  removeManager(steamId, logger) {
    const managerData = this.managers.get(steamId);
    if (!managerData) {
      return;
    }

    const username = managerData.account.username || managerData.account.steam_login;

    try {
      logger.info(`[SteamTradeManager] Removing manager for ${username} (${steamId})`);

      // Remove event listeners
      const listeners = this.eventListeners.get(steamId);
      if (listeners && managerData.manager) {
        if (listeners.newOffer) {
          managerData.manager.removeListener('newOffer', listeners.newOffer);
        }
        if (listeners.sentOfferChanged) {
          managerData.manager.removeListener('sentOfferChanged', listeners.sentOfferChanged);
        }
        if (listeners.receivedOfferChanged) {
          managerData.manager.removeListener('receivedOfferChanged', listeners.receivedOfferChanged);
        }
      }
      this.eventListeners.delete(steamId);

      // Remove manager
      this.managers.delete(steamId);

      logger.info(`[SteamTradeManager] ✓ Manager removed for ${username}`);

    } catch (error) {
      logger.error(`[SteamTradeManager] Error removing manager for ${username}: ${error.message}`);
    }
  }

  /**
   * Get statistics about registered managers
   *
   * @returns {Object} Statistics
   */
  getStats() {
    const stats = {
      totalManagers: this.managers.size,
      accounts: []
    };

    for (const [accountId, data] of this.managers.entries()) {
      const username = data.account.username || data.account.steam_login;
      stats.accounts.push({
        accountId: accountId,
        username: username,
        registeredAt: new Date(data.registeredAt).toISOString(),
        ageMs: Date.now() - data.registeredAt
      });
    }

    return stats;
  }

  /**
   * Cleanup all managers (called on shutdown)
   *
   * @param {Object} logger - Logger instance
   */
  cleanup(logger) {
    logger.info(`[SteamTradeManager] Cleaning up ${this.managers.size} managers...`);

    for (const steamId of this.managers.keys()) {
      this.removeManager(steamId, logger);
    }

    logger.info(`[SteamTradeManager] ✓ Cleanup complete`);
  }
}

// Export singleton instance
module.exports = new SteamTradeManager();
