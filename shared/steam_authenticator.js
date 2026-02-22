// automate_trading/shared/steam_authenticator.js
const { By } = require('selenium-webdriver');
const fs = require('fs-extra');
const SteamTokenGenerator = require('./steam_token_generator');
const CredentialCleaner = require('../utils/credential_cleaner');

class SteamAuthenticator {
  constructor(browserManager, steamAuth, logger) {
    this.browserManager = browserManager;
    this.steamAuth = steamAuth;
    this.logger = logger;
    this.tokenGenerator = null;
  }

  /**
   * NEW: Authenticate for native mode (token only, no browser)
   * @param {Object} account - Account to authenticate
   * @param {boolean} nativeOnly - If true, only generate token without browser auth
   */
  async authenticateAccount(account, nativeOnly = false) {
    // Clean any existing Steam cookies only if using browser
    if (!nativeOnly) {
      await this.cleanSteamCookies();
    }
    
    // Primary method: Token authentication
    const tokenAuth = await this.authenticateWithTokenGeneration(account, nativeOnly);
    
    if (tokenAuth) {
      return true;
    }
    
    // Fallback method: Credential authentication (only if browser needed)
    if (!nativeOnly) {
      const credentialAuth = await this.authenticateWithCredentials(account);
      
      if (credentialAuth) {
        return true;
      }
    } else {
      this.logger.warn('Token authentication failed in native-only mode, no fallback available');
    }
    
    this.logger.warn('All authentication methods failed');
    return false;
  }

  /**
   * MODIFIED: Token generation with optional browser authentication
   */
  async authenticateWithTokenGeneration(account, nativeOnly = false) {
    try {
      // Create token generator instance
      this.tokenGenerator = new SteamTokenGenerator(this.logger);
      
      // Generate token and maintain session
      const success = await this.tokenGenerator.generateAndMaintainToken(account);
      
      if (!success) {
        this.logger.error('Failed to generate auth token');
        return false;
      }
      
      // Get token and Steam ID
      const token = this.tokenGenerator.getToken();
      const steamId = this.tokenGenerator.getSteamId();
      
      // NEW: Skip browser authentication if native-only mode
      if (nativeOnly) {
        return true;
      }
      
      // Authenticate browser with token (original behavior)
      const browserAuth = await this.authenticateWithToken(steamId, token);
      
      if (browserAuth) {
        return true;
      } else {
        this.logger.warn('Browser authentication with token failed');
        // Don't close session yet for native fallback - let the calling code decide
        return false;
      }
      
    } catch (error) {
      this.logger.error(`Token generation authentication error: ${error.message}`);
      
      // Close token generator session on error
      if (this.tokenGenerator) {
        await this.tokenGenerator.closeSession();
        this.tokenGenerator = null;
      }
      
      return false;
    }
  }

  async authenticateWithToken(steamId, tokenValue) {
    try {
      const driver = this.browserManager.getDriver();
      
      if (!driver) {
        throw new Error('Browser driver not available');
      }
      
      // Navigate to Steam Community
      await this.browserManager.navigateTo('https://steamcommunity.com');
      
      // Set the steamLoginSecure cookie
      const steamLoginSecure = `${steamId}%7C%7C${tokenValue}`;
      await driver.manage().addCookie({
        name: 'steamLoginSecure',
        value: steamLoginSecure,
        domain: 'steamcommunity.com',
        path: '/',
        secure: true
      });
      
      // Refresh to apply authentication
      await driver.navigate().refresh();
      await this.browserManager.waitForPageLoad();
      
      // Brief pause to let authentication settle
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Verify authentication with robust detection
      const isAuthenticated = await this.verifyAuthenticationRobust();
      
      if (isAuthenticated) {
        return true;
      } else {
        this.logger.warn(`Token authentication failed for Steam ID: ${steamId}`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Token authentication error for Steam ID ${steamId}: ${error.message}`);
      return false;
    }
  }

  async authenticateWithCredentials(account) {
    try {
      // Load credentials using centralized cleaner
      const credentials = CredentialCleaner.loadCleanCredentials(account.steam_login);
      
      // Use existing credential authentication logic with cleaned credentials
      return await this.steamAuth.authenticateWithCredentials(
        credentials.username, 
        credentials.password,
        credentials.sharedSecret
      );
      
    } catch (error) {
      this.logger.error(`Credential authentication error for ${account.steam_login}: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean Steam cookies to prepare for next account authentication
   */
  async cleanSteamCookies() {
    try {
      const driver = this.browserManager.getDriver();
      
      if (!driver) {
        this.logger.warn('No browser driver available for cookie cleaning');
        return false;
      }

      // Navigate to Steam domain first to access cookies
      await this.browserManager.navigateTo('https://steamcommunity.com');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Delete all Steam-related cookies
      const steamCookies = ['steamLoginSecure', 'sessionid', 'steamRememberLogin', 'steamCountry', 'Steam_Language'];
      
      for (const cookieName of steamCookies) {
        try {
          await driver.manage().deleteCookie(cookieName);
        } catch (error) {
          // Cookie might not exist, continue silently
        }
      }
      
      // Also clear all cookies for the domain to be thorough
      try {
        await driver.manage().deleteAllCookies();
      } catch (error) {
        this.logger.warn(`Could not clear all cookies: ${error.message}`);
      }
      
      return true;
      
    } catch (error) {
      this.logger.error(`Error cleaning Steam cookies: ${error.message}`);
      return false;
    }
  }

  /**
   * Logout from Steam and cleanup token generator if needed
   */
  async logoutIfNeeded() {
    try {
      // Close token generator session if active
      if (this.tokenGenerator) {
        await this.tokenGenerator.closeSession();
        this.tokenGenerator = null;
      }
      
      // Clean browser cookies only if browser is available
      const driver = this.browserManager.getDriver();
      if (driver) {
        await this.cleanSteamCookies();
        
        // Optional: explicit Steam logout from browser (not always necessary)
        const currentUrl = await this.browserManager.getCurrentUrl();
        if (currentUrl && currentUrl.includes('steamcommunity.com')) {
          await this.logoutFromSteam();
        }
      }
      
      return true;
      
    } catch (error) {
      this.logger.error(`Error during logout: ${error.message}`);
      return false;
    }
  }

  async logoutFromSteam() {
    try {
      const driver = this.browserManager.getDriver();
      
      if (!driver) {
        this.logger.warn('No browser driver available for logout');
        return false;
      }

      // Step 1: Click account pulldown button
      const accountPulldown = await this.browserManager.waitForElement(
        By.id('account_pulldown'),
        'clickable',
        10000
      );
      
      if (!accountPulldown) {
        this.logger.warn('Account pulldown button not found - may already be logged out');
        return false;
      }
      
      await accountPulldown.click();
      
      // Wait for dropdown menu to appear
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Step 2: Click logout menu item
      const logoutLink = await this.browserManager.waitForElement(
        By.xpath("//a[@class='popup_menu_item'][contains(@href, 'javascript:Logout()')]"),
        'clickable',
        5000
      );
      
      if (!logoutLink) {
        this.logger.warn('Logout menu item not found');
        return false;
      }
      
      await logoutLink.click();
      
      // Step 3: Wait for logout to complete by looking for login link
      const loginLink = await this.browserManager.waitForElement(
        By.xpath("//a[@class='global_action_link'][contains(@href, '/login/home/')]"),
        'present',
        15000
      );
      
      if (loginLink) {
        return true;
      } else {
        this.logger.warn('Logout may not have completed - login link not found');
        return false;
      }
      
    } catch (error) {
      this.logger.error(`Error during logout: ${error.message}`);
      
      // Fallback: try to navigate to logout URL directly
      try {
        await this.browserManager.navigateTo('https://steamcommunity.com/login/logout/');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Check if we're on login page
        const currentUrl = await this.browserManager.getCurrentUrl();
        if (currentUrl && currentUrl.includes('/login/')) {
          return true;
        }
      } catch (fallbackError) {
        this.logger.error(`Fallback logout also failed: ${fallbackError.message}`);
      }
      
      return false;
    }
  }

  /**
   * Quick login verification with short timeout
   */
  async quickVerifyLoggedIn() {
    const driver = this.browserManager.getDriver();
    
    try {
      // Use JavaScript for fast verification
      const isLoggedIn = await driver.executeScript(`
        // Quick check for login indicators
        return document.querySelector('#account_dropdown') !== null ||
               document.querySelector('.profile_header_badgeinfo') !== null ||
               document.querySelector('a[href*="/profiles/"]') !== null ||
               document.querySelector('.account_name') !== null ||
               document.querySelector('a[href*="Edit Profile"]') !== null;
      `);
      
      if (isLoggedIn) {
        return true;
      }
      
      // If not found immediately, wait briefly for page to load
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const isLoggedInSecondCheck = await driver.executeScript(`
        return document.querySelector('#account_dropdown') !== null ||
               document.querySelector('.profile_header_badgeinfo') !== null ||
               document.querySelector('a[href*="/profiles/"]') !== null ||
               document.querySelector('.account_name') !== null ||
               !document.body.innerText.includes('Sign in');
      `);
      
      return isLoggedInSecondCheck;
      
    } catch (error) {
      return true; // Assume logged in to avoid blocking
    }
  }

  /**
   * ROBUST authentication verification
   */
  async verifyAuthenticationRobust() {
    const driver = this.browserManager.getDriver();
    
    try {
      // Use JavaScript for fast verification with multiple checks
      const authCheck = await driver.executeScript(`
        // Multiple authentication indicators
        const indicators = {
          account_dropdown: document.querySelector('#account_dropdown') !== null,
          profile_badge: document.querySelector('.profile_header_badgeinfo') !== null,
          profile_link: document.querySelector('a[href*="/profiles/"]') !== null,
          account_name: document.querySelector('.account_name') !== null,
          edit_profile: document.querySelector('a[href*="/edit/info"]') !== null,
          no_sign_in: !document.body.innerText.includes('Sign in'),
          community_menu: document.querySelector('.supernav_container') !== null,
          user_avatar: document.querySelector('.playerAvatar') !== null
        };
        
        // Count how many indicators are positive
        const positiveCount = Object.values(indicators).filter(Boolean).length;
        
        return {
          authenticated: positiveCount >= 2, // Require at least 2 positive indicators
          indicators: indicators,
          positiveCount: positiveCount,
          url: window.location.href,
          readyState: document.readyState
        };
      `);
      
      if (authCheck.authenticated) {
        return true;
      }
      
      // If immediate check fails, wait briefly for page to fully load
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Second check with timeout
      const secondCheck = await driver.executeScript(`
        const indicators = {
          account_dropdown: document.querySelector('#account_dropdown') !== null,
          profile_badge: document.querySelector('.profile_header_badgeinfo') !== null,
          profile_link: document.querySelector('a[href*="/profiles/"]') !== null,
          account_name: document.querySelector('.account_name') !== null,
          edit_profile: document.querySelector('a[href*="/edit/info"]') !== null,
          no_sign_in: !document.body.innerText.includes('Sign in'),
          community_menu: document.querySelector('.supernav_container') !== null,
          user_avatar: document.querySelector('.playerAvatar') !== null
        };
        
        const positiveCount = Object.values(indicators).filter(Boolean).length;
        
        return {
          authenticated: positiveCount >= 1, // More lenient on second check
          indicators: indicators,
          positiveCount: positiveCount,
          url: window.location.href
        };
      `);
      
      if (secondCheck.authenticated) {
        return true;
      }
      
      this.logger.warn('Authentication verification failed - no sufficient login indicators found');
      return false;
      
    } catch (error) {
      this.logger.error(`Authentication verification error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get token generator status for debugging
   */
  getTokenGeneratorStatus() {
    if (!this.tokenGenerator) {
      return { active: false, message: 'No token generator instance' };
    }
    
    return {
      active: true,
      status: this.tokenGenerator.getSessionStatus()
    };
  }
}

module.exports = SteamAuthenticator;