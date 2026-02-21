// automate_trading/shared/steam_auth.js
const { By, until, Key } = require('selenium-webdriver');
const fs = require('fs-extra');
const crypto = require('crypto');

class SteamAuth {
  constructor(browserManager, logger) {
    this.browser = browserManager;
    this.logger = logger;
    this.steamGuardChars = '23456789BCDFGHJKMNPQRTVWXY';
  }

  async authenticateWithToken(steamId, tokenValue) {
    try {
      const driver = this.browser.getDriver();
      
      // Navigate to Steam Community
      await this.browser.navigateTo('https://steamcommunity.com');
      
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
      await this.browser.waitForPageLoad();
      
      // Brief pause to let authentication settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Verify authentication with robust detection
      const isAuthenticated = await this.verifyAuthenticationRobust();
      
      if (isAuthenticated) {
        return true;
      } else {
        this.logger.warn(`Token authentication failed for ${steamId} - falling back to credentials`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Token authentication error for ${steamId}: ${error.message}`);
      return false;
    }
  }

  async authenticateWithCredentials(username, password, maFilePath) {
    try {
      // Start continuous cookie monitoring
      const cookieMonitor = this.startCookieMonitoring();
      
      try {
        // Navigate to Steam login page
        await this.browser.navigateTo('https://steamcommunity.com/login/home/?goto=');
        
        // Enter credentials
        await this.enterCredentials(username, password);
        
        // Handle Steam Guard if required
        await this.handleSteamGuard(maFilePath);
        
        // Verify login success with robust detection
        await this.verifyLoginSuccess();
        
        return true;
        
      } finally {
        // Stop cookie monitoring
        this.stopCookieMonitoring(cookieMonitor);
      }
      
    } catch (error) {
      this.logger.error(`Credential authentication error for ${username}: ${error.message}`);
      return false;
    }
  }

  /**
   * Start continuous monitoring for cookie dialogs
   */
  startCookieMonitoring() {
    let isMonitoring = true;
    let checksPerformed = 0;
    let hasLoggedStop = false;
    const maxChecks = 60; // Stop after 30 seconds (500ms * 60)
    
    const monitor = setInterval(async () => {
      if (!isMonitoring || checksPerformed >= maxChecks) {
        clearInterval(monitor);
        return;
      }
      
      checksPerformed++;
      
      try {
        // Only check for cookies during login phase
        const currentUrl = await this.browser.getDriver().getCurrentUrl();
        if (currentUrl.includes('/login/')) {
          await this.handleCookieConsentIfPresent();
        } else {
          // Stop monitoring once we're past login
          if (!hasLoggedStop) {
            hasLoggedStop = true;
          }
          isMonitoring = false;
          clearInterval(monitor);
        }
      } catch (error) {
        // Silently continue - don't interrupt the main flow
      }
    }, 500);
    
    return {
      stop: () => {
        isMonitoring = false;
        clearInterval(monitor);
      }
    };
  }

  /**
   * Stop cookie monitoring
   */
  stopCookieMonitoring(cookieMonitor) {
    if (cookieMonitor && cookieMonitor.stop) {
      cookieMonitor.stop();
    }
  }

  /**
   * Check for and handle cookie consent if present (non-blocking)
   */
  async handleCookieConsentIfPresent() {
    const driver = this.browser.getDriver();
    
    try {
      // Single JavaScript execution to check and handle cookies
      const handled = await driver.executeScript(`
        // Check for login page style cookie dialog
        const acceptButton1 = document.getElementById('acceptAllButton');
        if (acceptButton1 && acceptButton1.offsetParent !== null) {
          acceptButton1.click();
          return 'login_page_accept';
        }
        
        // Check for community page style cookie dialog
        const popup = document.getElementById('cookiePrefPopup');
        if (popup && popup.style.display === 'block') {
          const acceptButton2 = popup.querySelector('#acceptAllButton');
          if (acceptButton2) {
            acceptButton2.click();
            return 'community_page_accept';
          }
        }
        
        return null;
      `);
      
      if (handled) {
        // Brief pause to let dialog close
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
    } catch (error) {
      // Don't log minor errors - this runs frequently during login
    }
  }

  async enterCredentials(username, password) {
    try {
      // Wait for login form to be ready
      const usernameField = await this.browser.findElement(
        By.xpath("//input[@class='_2GBWeup5cttgbTw8FM3tfx'][1]")
      );
      
      // Human-like typing speed for username
      await usernameField.clear();
      await this.typeWithHumanSpeed(usernameField, username);
      
      // Small pause (human-like)
      await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 300));
      
      // Wait for and fill password field  
      const passwordField = await this.browser.findElement(
        By.xpath("//input[@type='password'][@class='_2GBWeup5cttgbTw8FM3tfx']")
      );
      
      // Human-like typing speed for password
      await passwordField.clear();
      await this.typeWithHumanSpeed(passwordField, password);
      
      // Brief pause to let any cookie dialogs appear and be handled by monitoring
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Click login button with retry logic
      await this.clickLoginButtonWithRetry();
      
      // Wait for page to process - look for either Steam Guard or success
      const driver = this.browser.getDriver();
      try {
        await driver.wait(function() {
          return driver.executeScript(`
            return document.readyState === 'complete' && 
            (document.querySelector('input[class*="_3xcXqLVteTNHmk-gh9W65d"]') !== null ||
             document.querySelector('#account_dropdown') !== null ||
             document.querySelector('.profile_header_badgeinfo') !== null ||
             !window.location.href.includes('/login/'))
          `);
        }, 15000);
      } catch (error) {
        // Continue silently
      }
      
    } catch (error) {
      this.logger.error(`Failed to enter credentials: ${error.message}`);
      throw error;
    }
  }

  /**
   * Click login button with retry logic for click interception
   */
  async clickLoginButtonWithRetry() {
    const loginButton = await this.browser.findClickableElement(
      By.xpath("//button[@class='DjSvCZoKKfoNSmarsEcTS']")
    );
    
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      try {
        // Ensure button is clickable
        await this.ensureButtonClickable(loginButton);
        
        // Attempt the click
        await loginButton.click();
        return; // Success!
        
      } catch (error) {
        if (error.name === 'ElementClickInterceptedError') {
          attempt++;
          
          // Force handle any cookie dialogs that might be intercepting
          await this.forceHandleCookieDialogs();
          
          // Wait a bit for DOM to settle
          await new Promise(resolve => setTimeout(resolve, 500));
          
          if (attempt === maxRetries) {
            await this.fallbackJavaScriptClick();
            return;
          }
        } else {
          throw error; // Different error, re-throw
        }
      }
    }
  }

  /**
   * Force handle any cookie dialogs immediately
   */
  async forceHandleCookieDialogs() {
    const driver = this.browser.getDriver();
    
    try {
      await driver.executeScript(`
        // Force close any cookie dialogs
        const acceptButton = document.getElementById('acceptAllButton');
        if (acceptButton && acceptButton.offsetParent !== null) {
          acceptButton.click();
        }
        
        const popup = document.getElementById('cookiePrefPopup');
        if (popup && popup.style.display === 'block') {
          const popupButton = popup.querySelector('#acceptAllButton');
          if (popupButton) {
            popupButton.click();
          }
        }
      `);
    } catch (error) {
      // Continue silently
    }
  }

  /**
   * Fallback JavaScript click when Selenium click fails
   */
  async fallbackJavaScriptClick() {
    const driver = this.browser.getDriver();
    
    try {
      await driver.executeScript(`
        const button = document.querySelector('button.DjSvCZoKKfoNSmarsEcTS');
        if (button) {
          button.click();
        }
      `);
    } catch (error) {
      this.logger.error(`JavaScript fallback click failed: ${error.message}`);
      throw new Error('All click methods failed');
    }
  }

  /**
   * Ensure button is clickable by checking for overlays
   */
  async ensureButtonClickable(button) {
    const driver = this.browser.getDriver();
    
    try {
      // Check if there are any overlaying elements
      const isClickable = await driver.executeScript(`
        const button = arguments[0];
        const rect = button.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const elementAtPoint = document.elementFromPoint(centerX, centerY);
        
        // Check if the element at the button's center is the button itself or a child
        return button === elementAtPoint || button.contains(elementAtPoint);
      `, button);
      
      if (!isClickable) {
        // Wait up to 2 seconds for overlays to clear
        await driver.wait(function() {
          return driver.executeScript(`
            const button = arguments[0];
            const rect = button.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const elementAtPoint = document.elementFromPoint(centerX, centerY);
            
            return button === elementAtPoint || button.contains(elementAtPoint);
          `, button);
        }, 2000);
      }
      
    } catch (error) {
      // Continue anyway
    }
  }

  /**
   * Type text with human-like speed
   */
  async typeWithHumanSpeed(element, text) {
    for (let char of text) {
      await element.sendKeys(char);
      // Random delay between 50-150ms per character (human-like)
      await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }

  /**
   * Handle Steam Guard authentication if required
   */
  async handleSteamGuard(maFilePath) {
    try {
      // Check if Steam Guard is required using multiple detection methods
      const steamGuardDetected = await this.detectSteamGuard();
      
      if (steamGuardDetected) {
        // Generate Steam Guard code
        const steamGuardCode = await this.generateSteamGuardCode(maFilePath);
        
        // Enter the code with auto-submission detection
        await this.enterSteamGuardCodeWithAutoDetection(steamGuardCode);
        
        // Wait for authentication to complete by looking for logged-in indicators
        await this.waitForSteamGuardCompletion();
      }
    } catch (error) {
      this.logger.error(`Steam Guard authentication failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Detect if Steam Guard authentication is required
   */
  async detectSteamGuard() {
    const driver = this.browser.getDriver();
    
    try {
      // Method 1: Look for Steam Guard input fields
      const inputFields = await driver.findElements(
        By.xpath("//input[contains(@class, '_3xcXqLVteTNHmk-gh9W65d')]")
      );
      if (inputFields.length > 0) {
        return true;
      }
      
      // Method 2: Look for Steam Guard container
      const containers = await driver.findElements(
        By.xpath("//div[contains(@class, '_3huyZ7Eoy2bX4PbCnH3p5w')]")
      );
      if (containers.length > 0) {
        return true;
      }
      
      // Method 3: Look for Steam Guard text
      const textElements = await driver.findElements(
        By.xpath("//*[contains(text(), 'Enter the code from your Steam Mobile App')]")
      );
      if (textElements.length > 0) {
        return true;
      }
      
      // Method 4: Look for mobile app reference
      const mobileElements = await driver.findElements(
        By.xpath("//*[contains(text(), 'Steam Mobile') or contains(text(), 'Steam App')]")
      );
      if (mobileElements.length > 0) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error detecting Steam Guard: ${error.message}`);
      return false;
    }
  }

  /**
   * Find Steam Guard input fields with wait
   */
  async findSteamGuardFields() {
    const driver = this.browser.getDriver();
    
    const selectors = [
      "//input[contains(@class, '_3xcXqLVteTNHmk-gh9W65d')]",
      "//div[contains(@class, '_1gzkmmy_XA39rp9MtxJfZJ')]/input",
      "//div[contains(@class, '_3huyZ7Eoy2bX4PbCnH3p5w')]//input[@type='text']",
      "//input[@type='text' and @maxlength='1']",
      "//input[@type='text' and @maxlength='1' and contains(@class, 'Focusable')]"
    ];
    
    // Wait up to 10 seconds for ANY of the selectors to find elements
    for (const selector of selectors) {
      try {
        await driver.wait(until.elementLocated(By.xpath(selector)), 10000);
        const inputFields = await driver.findElements(By.xpath(selector));
        if (inputFields.length > 0) {
          return inputFields;
        }
      } catch (error) {
        // Continue to next selector
      }
    }
    
    throw new Error('No Steam Guard input fields found after waiting 10 seconds');
  }

  /**
   * Check if Steam Guard fields still exist (for auto-submission detection)
   */
  async checkIfSteamGuardFieldsExist() {
    const driver = this.browser.getDriver();
    
    try {
      const result = await driver.executeScript(`
        // Check for any Steam Guard input fields
        const selectors = [
          "input[class*='_3xcXqLVteTNHmk-gh9W65d']",
          "div[class*='_1gzkmmy_XA39rp9MtxJfZJ'] input",
          "div[class*='_3huyZ7Eoy2bX4PbCnH3p5w'] input[type='text']",
          "input[type='text'][maxlength='1']"
        ];
        
        for (let selector of selectors) {
          const elements = document.querySelectorAll(selector);
          if (elements.length > 0) {
            // Check if any are visible
            for (let element of elements) {
              if (element.offsetParent !== null) {
                return true; // Found visible Steam Guard fields
              }
            }
          }
        }
        
        return false; // No visible Steam Guard fields found
      `);
      
      return result;
    } catch (error) {
      // If script fails, assume fields don't exist
      return false;
    }
  }

  /**
   * Enter Steam Guard code with auto-submission detection - MAIN NEW METHOD
   */
  async enterSteamGuardCodeWithAutoDetection(code) {
    try {
      // Find input fields with wait
      let inputFields = await this.findSteamGuardFields();
      
      // Enter characters one by one and watch for auto-submission
      for (let i = 0; i < Math.min(code.length, inputFields.length); i++) {
        const digit = code.charAt(i);
        
        try {
          // Wait for this specific input to be interactable
          const driver = this.browser.getDriver();
          await driver.wait(until.elementIsEnabled(inputFields[i]), 5000);
          
          // Clear and enter the digit
          await inputFields[i].clear();
          await inputFields[i].click();
          await inputFields[i].sendKeys(digit);
          
          // Short pause to let Steam process the digit
          await new Promise(resolve => setTimeout(resolve, 300));
          
          // Check if fields still exist (not auto-submitted)
          const fieldsStillExist = await this.checkIfSteamGuardFieldsExist();
          
          if (!fieldsStillExist) {
            return; // Success! Auto-submission detected
          }
          
        } catch (error) {
          if (error.name === 'StaleElementReferenceError') {
            return; // Success! Stale elements indicate auto-submission
          }
          
          this.logger.error(`Error entering digit ${i + 1}: ${error.message}`);
          throw error;
        }
      }
      
      // If we get here, all digits entered but fields still exist
      await this.handlePostEntryState();
      
    } catch (error) {
      this.logger.error(`Failed to enter Steam Guard code: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle state after all digits are entered (check for errors or wait for submission)
   */
  async handlePostEntryState() {
    const driver = this.browser.getDriver();
    
    try {
      // Wait a bit more for potential auto-submission
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check again if fields disappeared
      const fieldsStillExist = await this.checkIfSteamGuardFieldsExist();
      
      if (!fieldsStillExist) {
        return;
      }
      
      // Fields still exist - check for error indicators
      const errorState = await driver.executeScript(`
        // Check for red text, error messages, or other failure indicators
        const inputs = document.querySelectorAll("input[type='text'][maxlength='1']");
        let hasErrors = false;
        
        for (let input of inputs) {
          const style = window.getComputedStyle(input);
          if (style.color.includes('red') || style.borderColor.includes('red') || 
              input.className.includes('error') || input.className.includes('invalid')) {
            hasErrors = true;
            break;
          }
        }
        
        // Also check for error text in the page
        const bodyText = document.body.textContent.toLowerCase();
        if (bodyText.includes('incorrect') || bodyText.includes('invalid') || bodyText.includes('try again')) {
          hasErrors = true;
        }
        
        return hasErrors;
      `);
      
      if (errorState) {
        throw new Error('Steam Guard code appears to be incorrect (error indicators detected)');
      }
      
      // No clear error, try manual submission as fallback
      await this.attemptManualSubmission();
      
    } catch (error) {
      this.logger.error(`Error in post-entry state handling: ${error.message}`);
      throw error;
    }
  }

  /**
   * Attempt manual submission as fallback
   */
  async attemptManualSubmission() {
    const driver = this.browser.getDriver();
    
    try {
      // Look for submit button
      const submitButtons = await driver.findElements(
        By.xpath("//button[contains(@class, 'DialogButton')]")
      );
      
      if (submitButtons.length > 0) {
        await submitButtons[0].click();
        return;
      }
      
      // Fallback: try Enter key on any input field
      const inputFields = await driver.findElements(
        By.xpath("//input[@type='text' and @maxlength='1']")
      );
      
      if (inputFields.length > 0) {
        await inputFields[inputFields.length - 1].sendKeys(Key.ENTER);
        return;
      }
      
    } catch (error) {
      this.logger.warn(`Manual submission failed: ${error.message}`);
    }
  }

  async generateSteamGuardCode(maFilePath) {
    const maFileContent = await fs.readFile(maFilePath, 'utf8');
    const maData = JSON.parse(maFileContent);
    
    if (!maData.shared_secret) {
      throw new Error('shared_secret not found in maFile');
    }

    const sharedSecretBytes = Buffer.from(maData.shared_secret, 'base64');
    const timeStamp = Math.floor(Date.now() / 1000 / 30);
    
    const timeBuffer = Buffer.allocUnsafe(8);
    timeBuffer.writeUInt32BE(0, 0);
    timeBuffer.writeUInt32BE(timeStamp, 4);

    const hmac = crypto.createHmac('sha1', sharedSecretBytes);
    hmac.update(timeBuffer);
    const hmacResult = hmac.digest();

    const offset = hmacResult[hmacResult.length - 1] & 0x0F;
    let fullCode = ((hmacResult[offset] & 0x7F) << 24)
      | ((hmacResult[offset + 1] & 0xFF) << 16)
      | ((hmacResult[offset + 2] & 0xFF) << 8)
      | (hmacResult[offset + 3] & 0xFF);

    let code = '';
    for (let i = 0; i < 5; i++) {
      code += this.steamGuardChars.charAt(fullCode % this.steamGuardChars.length);
      fullCode = Math.floor(fullCode / this.steamGuardChars.length);
    }

    return code;
  }

  /**
   * Wait for Steam Guard authentication to complete using efficient indicators
   */
  async waitForSteamGuardCompletion() {
    const driver = this.browser.getDriver();
    
    try {
      // Use the most reliable login indicators with JavaScript execution for speed
      await driver.wait(function() {
        return driver.executeScript(`
          // Primary indicator: Account dropdown (present on all Steam Community pages when logged in)
          if (document.querySelector('#account_dropdown') !== null) {
            return 'account_dropdown';
          }
          
          // Secondary indicator: Profile badge info (on profile pages)
          if (document.querySelector('.profile_header_badgeinfo') !== null) {
            return 'profile_badge';
          }
          
          // URL-based check: redirected away from login
          if (!window.location.href.includes('/login/') && 
              (window.location.href.includes('/id/') || window.location.href.includes('/profiles/'))) {
            return 'url_redirect';
          }
          
          // Additional check: Edit Profile button (definitive logged-in indicator)
          if (document.querySelector('a[href*="/edit/info"]') !== null) {
            return 'edit_profile';
          }
          
          return false;
        `);
      }, 10000); // Reduced from 30 seconds to 10 seconds
      
    } catch (error) {
      // Fallback check - sometimes Steam takes a moment to fully load the page
      const currentUrl = await driver.getCurrentUrl();
      if (!currentUrl.includes('/login/')) {
        // Silent success
      } else {
        throw new Error('Steam Guard authentication failed - still on login page after timeout');
      }
    }
  }

  /**
   * Verify that login was successful and we're on Steam Community
   */
  async verifyLoginSuccess() {
    const driver = this.browser.getDriver();
    
    try {
      // We should already be logged in at this point
      const currentUrl = await driver.getCurrentUrl();
      
      // Ensure we're not on a login page anymore
      if (currentUrl.includes('/login/')) {
        throw new Error('Still on login page after authentication');
      }
      
      // Look for specific logged-in elements
      await this.verifyActuallyLoggedIn();
      
      return true;
    } catch (error) {
      this.logger.error(`Login verification failed: ${error.message}`);
      throw new Error('Failed to verify Steam login success');
    }
  }

  /**
   * Verify we're actually logged in by checking for user profile elements
   */
  async verifyActuallyLoggedIn() {
    const driver = this.browser.getDriver();
    
    try {
      // Look for specific elements that indicate we're logged in
      const loginIndicators = [
        // Account dropdown (most reliable)
        By.id('account_dropdown'),
        // Profile header badge info
        By.className('profile_header_badgeinfo'),
        // View my profile link
        By.xpath("//a[contains(text(), 'View my profile')]"),
        // Account name span
        By.className('account_name'),
        // Profile actions area
        By.className('profile_header_actions'),
        // Any profile URL link
        By.xpath("//a[contains(@href, '/profiles/') or contains(@href, '/id/')]")
      ];
      
      let loggedIn = false;
      
      for (const indicator of loginIndicators) {
        try {
          const element = await driver.wait(until.elementLocated(indicator), 2000);
          if (element) {
            loggedIn = true;
            break;
          }
        } catch (error) {
          // Continue to next indicator
        }
      }
      
      if (!loggedIn) {
        throw new Error('Could not verify login - no user profile elements found');
      }
      
      return true;
      
    } catch (error) {
      this.logger.error(`Login verification check failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * ROBUST authentication verification - the key improvement!
   */
  async verifyAuthenticationRobust() {
    const driver = this.browser.getDriver();
    
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

  // Simplified version for backwards compatibility
  async verifyAuthentication() {
    return await this.verifyAuthenticationRobust();
  }
}

module.exports = SteamAuth;