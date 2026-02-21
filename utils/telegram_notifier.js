// automate_trading/utils/telegram_notifier.js

const axios = require('axios');

/**
 * Telegram Notifier for automate_trading service
 * Sends admin notifications via Telegram
 * Based on invite_friends/src/telegram_notifier.js pattern
 */
class TelegramNotifier {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    this.telegramApiKey = process.env.TELEGRAM_API_KEY;
    this.enabled = this.telegramApiKey ? true : false;
    this.timeout = config.telegram?.timeout || 10000;
    this.baseUrl = 'https://api.telegram.org/bot';

    // All admin usernames from environment variable
    const adminUsernamesEnv = process.env.AUTOMATE_TRADING_ADMIN || 'Professor,ready_set_grow,impassive_hawk';
    this.allAdminUsernames = adminUsernamesEnv.split(',').map(name => name.trim());

    // Cache for admin Telegram IDs (username -> telegram_id)
    this.adminTelegramIdsCache = new Map();
    this.cacheTimestamp = 0;
    this.cacheDuration = 3600000; // 1 hour in milliseconds

    // Django API configuration
    this.djangoBaseUrl = process.env.DJANGO_BASE_URL;
    this.djangoApiKey = process.env.LINK_HARVESTER_API_KEY;

    this.logger.info('[TELEGRAM] Notifier initialized', {
      enabled: this.enabled,
      allAdmins: this.allAdminUsernames
    });
  }

  /**
   * Get admin Telegram IDs from Django API
   * Fetches IDs for all configured admins and caches them
   */
  async getAdminTelegramIds() {
    const now = Date.now();

    // Return cached IDs if still valid
    if (this.adminTelegramIdsCache.size > 0 && (now - this.cacheTimestamp) < this.cacheDuration) {
      this.logger.debug('[TELEGRAM] Using cached admin Telegram IDs', {
        count: this.adminTelegramIdsCache.size,
        cacheAge: Math.round((now - this.cacheTimestamp) / 1000)
      });
      return this.adminTelegramIdsCache;
    }

    try {
      this.logger.info('[TELEGRAM] Fetching admin Telegram IDs from Django API', {
        usernames: this.allAdminUsernames
      });

      const response = await axios.post(
        `${this.djangoBaseUrl}/links/api/get-admin-telegram-ids/`,
        { usernames: this.allAdminUsernames },
        {
          headers: {
            'X-API-Key': this.djangoApiKey,
            'Content-Type': 'application/json'
          },
          timeout: this.timeout
        }
      );

      // Log the full response for debugging
      this.logger.info('[TELEGRAM] Django API response', {
        responseData: response.data
      });

      if (response.data && response.data.success) {
        // Clear cache
        this.adminTelegramIdsCache.clear();

        // Check if Django returns a mapping object (username -> telegram_id)
        if (response.data.mapping && typeof response.data.mapping === 'object') {
          // Format: {mapping: {username1: telegram_id1, username2: telegram_id2}}
          for (const [username, telegramId] of Object.entries(response.data.mapping)) {
            if (telegramId) {
              this.adminTelegramIdsCache.set(username, telegramId);
            }
          }
        } else if (Array.isArray(response.data.telegram_ids)) {
          // Format: {telegram_ids: [id1, id2, ...]} - assumes same order as usernames
          this.logger.warn('[TELEGRAM] Using index-based mapping (order-dependent, may be unreliable)');
          this.allAdminUsernames.forEach((username, index) => {
            if (response.data.telegram_ids[index]) {
              this.adminTelegramIdsCache.set(username, response.data.telegram_ids[index]);
            }
          });
        } else {
          this.logger.error('[TELEGRAM] Unknown response format from Django API', {
            response: response.data
          });
          return new Map();
        }

        this.cacheTimestamp = now;

        this.logger.info('[TELEGRAM] Admin Telegram IDs fetched and cached', {
          count: this.adminTelegramIdsCache.size,
          mapping: Object.fromEntries(this.adminTelegramIdsCache)
        });

        return this.adminTelegramIdsCache;
      } else {
        this.logger.error('[TELEGRAM] Invalid response format from Django API', {
          response: response.data
        });
        return new Map();
      }
    } catch (error) {
      this.logger.error('[TELEGRAM] Error fetching admin Telegram IDs', {
        error: error.message,
        usernames: this.allAdminUsernames
      });
      return new Map();
    }
  }

  /**
   * Send message to specific admins
   * @param {Array<string>} adminUsernames - Array of admin usernames (or ['all'])
   * @param {string} message - Message text (HTML format)
   * @returns {Promise<Object>} - {success: boolean, sentTo: Array<string>, failed: Array<string>}
   */
  async sendToAdmins(adminUsernames, message) {
    if (!this.enabled) {
      this.logger.warn('[TELEGRAM] Notifications disabled (no API key), skipping message');
      return { success: false, sentTo: [], failed: [] };
    }

    try {
      // Get admin Telegram IDs
      const telegramIdsMap = await this.getAdminTelegramIds();

      if (telegramIdsMap.size === 0) {
        this.logger.error('[TELEGRAM] No admin Telegram IDs available');
        return { success: false, sentTo: [], failed: [] };
      }

      // Resolve 'all' to all admin usernames
      let targetAdmins = adminUsernames;
      if (adminUsernames.includes('all')) {
        targetAdmins = this.allAdminUsernames;
      }

      // Get telegram IDs for target admins
      const sentTo = [];
      const failed = [];

      for (const username of targetAdmins) {
        const telegramId = telegramIdsMap.get(username);

        if (!telegramId) {
          this.logger.warn(`[TELEGRAM] No Telegram ID found for admin '${username}'`);
          failed.push(username);
          continue;
        }

        const success = await this.sendTelegramMessage(telegramId, message);
        if (success) {
          sentTo.push(username);
          this.logger.info(`[TELEGRAM] Message sent to ${username} (${telegramId})`);
        } else {
          failed.push(username);
        }
      }

      const allSuccess = failed.length === 0;
      this.logger.info('[TELEGRAM] Message delivery completed', {
        sentTo,
        failed,
        allSuccess
      });

      return {
        success: sentTo.length > 0,
        sentTo,
        failed
      };

    } catch (error) {
      this.logger.error('[TELEGRAM] Error sending message to admins', {
        error: error.message,
        admins: adminUsernames
      });
      return { success: false, sentTo: [], failed: adminUsernames };
    }
  }

  /**
   * Send a message to a specific Telegram chat ID
   * @param {string} telegramId - Telegram chat ID
   * @param {string} message - Message text (HTML format)
   * @returns {Promise<boolean>} - True if sent successfully
   */
  async sendTelegramMessage(telegramId, message) {
    if (!this.enabled) {
      return false;
    }

    if (!this.telegramApiKey) {
      this.logger.error('[TELEGRAM] Telegram API key not configured');
      return false;
    }

    try {
      const url = `${this.baseUrl}${this.telegramApiKey}/sendMessage`;

      const response = await axios.post(
        url,
        {
          chat_id: telegramId,
          text: message,
          parse_mode: 'HTML'
        },
        {
          timeout: this.timeout
        }
      );

      if (response.data && response.data.ok) {
        return true;
      } else {
        this.logger.error('[TELEGRAM] Failed to send message', {
          telegramId,
          response: response.data
        });
        return false;
      }
    } catch (error) {
      this.logger.error('[TELEGRAM] Error sending Telegram message', {
        telegramId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Clear admin Telegram IDs cache
   */
  clearCache() {
    this.adminTelegramIdsCache.clear();
    this.cacheTimestamp = 0;
    this.logger.info('[TELEGRAM] Admin Telegram IDs cache cleared');
  }

  /**
   * Escape HTML special characters to prevent parsing errors
   * @param {string} text - Text to escape
   * @returns {string} - Escaped text
   */
  escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Format notification message for Telegram (HTML format)
   * Respects Telegram's 4096 character limit by truncating if needed
   * @param {Object} stackByLogin - Map of login -> array of {friend, time}
   * @param {number} maxLength - Maximum message length (default 4000, leaves room for footer)
   * @returns {Object} - {message: string, included: Array<{login, friend}>, truncated: boolean, totalCount: number}
   */
  formatNotificationMessage(stackByLogin, maxLength = 4000) {
    const totalCount = Object.values(stackByLogin).reduce((sum, friends) => sum + friends.length, 0);
    const included = []; // Track which notifications were included
    let truncated = false;

    const lines = [
      `⚠️ <b>Manual intervention needed</b> (${totalCount} negotiation${totalCount > 1 ? 's' : ''})`,
      ''
    ];

    // Build message incrementally, checking length
    for (const [login, friends] of Object.entries(stackByLogin)) {
      const loginLine = `<b>${this.escapeHtml(login)}</b>`;

      // Check if adding this login section would exceed limit
      const testLines = [...lines, loginLine];
      if (testLines.join('\n').length > maxLength) {
        truncated = true;
        break;
      }

      lines.push(loginLine);
      let addedFriendsForThisLogin = false;

      for (const { friend, time } of friends) {
        // Format time as HH:MM
        const timeStr = new Date(time).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Europe/Madrid'
        });

        const friendLine = `  → ${this.escapeHtml(friend)}, ${timeStr}`;

        // Check if adding this friend would exceed limit
        const testLinesWithFriend = [...lines, friendLine, '', '<i>First notification: 00:00, Sent: 00:00</i>'];
        if (testLinesWithFriend.join('\n').length > maxLength) {
          // If we haven't added any friends for this login yet, remove the login header
          if (!addedFriendsForThisLogin) {
            lines.pop(); // Remove the orphaned login header
          }
          truncated = true;
          break;
        }

        lines.push(friendLine);
        included.push({ login, friend });
        addedFriendsForThisLogin = true;
      }

      if (truncated) {
        break;
      }

      lines.push(''); // Empty line between logins
    }

    // Add footer with first notification time
    const allTimes = Object.values(stackByLogin).flatMap(friends => friends.map(f => new Date(f.time)));
    if (allTimes.length > 0) {
      const firstTime = new Date(Math.min(...allTimes));
      const sentTime = new Date();

      const firstTimeStr = firstTime.toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Madrid'
      });

      const sentTimeStr = sentTime.toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Europe/Madrid'
      });

      const footerText = truncated
        ? `<i>Showing ${included.length} of ${totalCount}. First: ${firstTimeStr}, Sent: ${sentTimeStr}</i>`
        : `<i>First notification: ${firstTimeStr}, Sent: ${sentTimeStr}</i>`;

      lines.push(footerText);
    }

    return {
      message: lines.join('\n'),
      included,
      truncated,
      totalCount
    };
  }
}

module.exports = TelegramNotifier;
