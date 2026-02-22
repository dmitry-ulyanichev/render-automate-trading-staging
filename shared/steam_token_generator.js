// automate_trading/shared/steam_token_generator.js
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const CredentialCleaner = require('../utils/credential_cleaner');

class SteamTokenGenerator {
  constructor(logger) {
    this.logger = logger;
    this.client = null;
    this.authToken = null;
    this.steamId = null;
    this.isSessionActive = false;
    this.refreshTokenTimer = null;
    this.account = null;
  }

  /**
   * Generate token and maintain SteamUser session active
   */
  async generateAndMaintainToken(account) {
    if (this.isSessionActive) {
      await this.closeSession();
    }

    this.account = account;

    try {
      // Load credentials using the centralized cleaner
      const credentials = CredentialCleaner.loadCleanCredentials(account.steam_login);
      
      // Create SteamUser client
      this.client = new SteamUser();
      
      // Setup event handlers
      this.setupEventHandlers();
      
      // Generate 2FA code using shared secret directly
      const twoFactorCode = SteamTotp.generateAuthCode(credentials.sharedSecret);
      
      // Create login promise
      const loginPromise = this.createLoginPromise();
      
      // Login to Steam
      this.client.logOn({
        accountName: credentials.username,
        password: credentials.password,
        twoFactorCode: twoFactorCode
      });
      
      // Wait for authentication to complete
      const result = await loginPromise;
      
      if (result.success) {
        this.authToken = result.token;
        this.steamId = result.steamId;
        this.isSessionActive = true;
        
        // Session will remain active until explicitly closed
        
        return true;
      } else {
        throw new Error(result.error || 'Authentication failed');
      }
      
    } catch (error) {
      this.logger.error(`Failed to generate token for ${account.steam_login}: ${error.message}`);
      await this.closeSession();
      throw error;
    }
  }

  /**
   * Setup SteamUser event handlers
   */
  setupEventHandlers() {
    // Login successful
    this.client.on('loggedOn', () => {
      // Request web cookies immediately
      this.client.webLogOn();
    });

    // Disconnection handler with reconnection attempt
    this.client.on('disconnected', (eresult, msg) => {
      this.logger.warn(`Steam client disconnected: ${msg}`);
      this.isSessionActive = false;
      
      // Attempt to reconnect if disconnection was unexpected
      if (this.account && eresult !== 1) { // 1 = intentional logoff
        setTimeout(() => {
          if (!this.isSessionActive && this.client) {
            this.client.logOn();
          }
        }, 5000);
      }
    });

    // Error handler
    this.client.on('error', (err) => {
      this.logger.error(`Steam client error: ${err.message}`);
      this.isSessionActive = false;
    });
  }

  /**
   * Create promise that resolves when login completes
   */
  createLoginPromise() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Authentication timed out after 30 seconds'));
      }, 30000);

      // Handle successful web session
      this.client.once('webSession', (sessionId, cookies) => {
        clearTimeout(timeout);
        
        // Extract auth token from cookies
        let authToken = null;
        let steamId = null;
        
        for (const cookie of cookies) {
          if (cookie.includes('steamLoginSecure=')) {
            const matches = cookie.match(/steamLoginSecure=(\d+)%7C%7C([^;]+)/);
            if (matches && matches.length >= 3) {
              steamId = matches[1];
              authToken = matches[2];
              break;
            }
          }
        }
        
        if (authToken && steamId) {
          resolve({
            success: true,
            token: authToken,
            steamId: steamId
          });
        } else {
          resolve({
            success: false,
            error: 'Failed to extract auth token from cookies'
          });
        }
      });

      // Handle errors
      this.client.once('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: `Steam error: ${err.message}`
        });
      });
    });
  }

  /**
   * Manual token refresh - only called when needed (e.g., after reconnection)
   */
  getToken() {
    return this.authToken;
  }

  /**
   * Get current Steam ID
   */
  getSteamId() {
    return this.steamId;
  }

  /**
   * Check if session is active
   */
  getSessionStatus() {
    return {
      isActive: this.isSessionActive,
      hasClient: this.client !== null,
      loggedOn: this.client ? this.client.loggedOn : false,
      steamId: this.steamId,
      hasToken: this.authToken !== null
    };
  }

  /**
   * Refresh token if needed (optional - called automatically)
   */
  async refreshToken() {
    if (!this.isSessionActive || !this.client) {
      throw new Error('No active session to refresh');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Token refresh timed out'));
      }, 10000);

      this.client.once('webSession', (sessionId, cookies) => {
        clearTimeout(timeout);
        
        // Extract new token
        for (const cookie of cookies) {
          if (cookie.includes('steamLoginSecure=')) {
            const matches = cookie.match(/steamLoginSecure=(\d+)%7C%7C([^;]+)/);
            if (matches && matches.length >= 3) {
              this.authToken = matches[2];
              resolve(this.authToken);
              return;
            }
          }
        }
        
        reject(new Error('Failed to extract refreshed token'));
      });

      this.client.webLogOn();
    });
  }

  /**
   * Close session and cleanup
   */
  async closeSession() {
    try {
      // Clear any timers (none currently, but keeping for future compatibility)
      
      // Close Steam client
      if (this.client) {
        this.client.logOff();
        this.client.removeAllListeners();
        this.client = null;
      }
      
      // Clear token data
      this.authToken = null;
      this.steamId = null;
      this.isSessionActive = false;
      this.account = null;
      
    } catch (error) {
      this.logger.error(`Error closing SteamUser session: ${error.message}`);
    }
  }
}

module.exports = SteamTokenGenerator;