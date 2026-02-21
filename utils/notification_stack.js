// automate_trading/utils/notification_stack.js

const axios = require('axios');

/**
 * NotificationStack - Manages stacked notifications via Node API Service
 * Uses Redis-backed API instead of local file storage
 *
 * When admins come online, they ALL get the entire stack
 */
class NotificationStack {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // API configuration
    this.apiBaseUrl = config.nodeApiService.baseUrl;
    this.apiKey = config.nodeApiService.apiKey;
    this.timeout = config.nodeApiService.timeout || 30000;

    this.logger.info('[NOTIFICATION_STACK] Initialized with API backend', {
      apiBaseUrl: this.apiBaseUrl
    });
  }

  /**
   * Make API request with error handling
   */
  async apiRequest(method, endpoint, data = null) {
    try {
      const response = await axios({
        method,
        url: `${this.apiBaseUrl}/notification-stack${endpoint}`,
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json'
        },
        data,
        timeout: this.timeout
      });
      return response.data;
    } catch (error) {
      const message = error.response?.data?.error || error.message;
      this.logger.error(`[NOTIFICATION_STACK] API error: ${message}`);
      throw error;
    }
  }

  /**
   * Add a notification to the stack
   * @param {string} ourSteamLogin - Our Steam login
   * @param {string} friendUsername - Friend's username/nickname
   */
  async addNotification(ourSteamLogin, friendUsername) {
    const result = await this.apiRequest('POST', '/add', {
      login: ourSteamLogin,
      friend: friendUsername
    });

    this.logger.info(`[NOTIFICATION_STACK] ${result.operation} notification`, {
      login: ourSteamLogin,
      friend: friendUsername
    });

    return result;
  }

  /**
   * Get all stacked notifications
   * @returns {Array<{login, friend, time}>} - Array of notifications
   */
  async getNotifications() {
    const result = await this.apiRequest('GET', '');
    return result.notifications || [];
  }

  /**
   * Check if stack has notifications
   * @returns {boolean}
   */
  async hasNotifications() {
    const result = await this.apiRequest('GET', '/count');
    return result.count > 0;
  }

  /**
   * Get count of stacked notifications
   * @returns {number}
   */
  async getCount() {
    const result = await this.apiRequest('GET', '/count');
    return result.count;
  }

  /**
   * Clear all stacked notifications
   */
  async clearAll() {
    const result = await this.apiRequest('DELETE', '');

    this.logger.info(`[NOTIFICATION_STACK] Cleared ${result.cleared} notification(s)`);
    return result.cleared;
  }

  /**
   * Remove specific notifications from the stack
   * @param {Array<{login, friend}>} notificationsToRemove - Array of {login, friend} pairs to remove
   */
  async removeNotifications(notificationsToRemove) {
    const result = await this.apiRequest('POST', '/remove', {
      items: notificationsToRemove
    });

    this.logger.info(`[NOTIFICATION_STACK] Removed ${result.removed} notification(s)`);
    return result.removed;
  }
}

module.exports = NotificationStack;