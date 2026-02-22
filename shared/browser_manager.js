// automate_trading/shared/browser_manager.js
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class BrowserManager {
  constructor(config, logger = null) {
    this.config = config;
    this.driver = null;
    this.tempDirs = [];
    this.cacheThresholdMB = 50; // Cache size threshold
    this.lastCacheSizeCheck = Date.now();
    this.cacheCheckIntervalMs = 5 * 60 * 1000; // Check every 5 minutes
    
    // Recovery state tracking
    this.isInRecovery = false;
    this.recoveryAttempts = 0;
    this.maxRecoveryAttempts = 3;
    this.lastRecoveryTime = 0;
    this.recoveryTimeoutMs = 30000; // 30 seconds between recovery attempts
    
    // Use provided logger or create default winston logger
    this.logger = logger || winston.createLogger({
      level: config.logging.level,
      format: winston.format.simple(),
      transports: [new winston.transports.Console()]
    });
  }

  /**
   * Check if error indicates browser failure requiring recovery
   */
  isCriticalBrowserError(error) {
    const message = error.message.toLowerCase();
    const criticalPatterns = [
      'tab crashed',
      'renderer',
      'timeout: timed out receiving message from renderer',
      'session deleted because of page crash',
      'chrome not reachable',
      'no such session',
      'invalid session id',
      'session not created',
      'unknown error: failed to close window',
      'disconnected: unable to connect to renderer'
    ];
    
    return criticalPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Check if we should attempt recovery
   */
  shouldAttemptRecovery() {
    const now = Date.now();
    
    // Don't attempt recovery if already in recovery
    if (this.isInRecovery) {
      this.logger.warn('Already in recovery mode, skipping additional recovery attempt');
      return false;
    }
    
    // Check if we've exceeded max recovery attempts
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      this.logger.error(`Max recovery attempts (${this.maxRecoveryAttempts}) exceeded`);
      return false;
    }
    
    // Check if enough time has passed since last recovery
    if (now - this.lastRecoveryTime < this.recoveryTimeoutMs) {
      const remainingTime = Math.ceil((this.recoveryTimeoutMs - (now - this.lastRecoveryTime)) / 1000);
      this.logger.warn(`Recovery cooldown active, ${remainingTime}s remaining`);
      return false;
    }
    
    return true;
  }

  /**
   * Perform aggressive cleanup similar to your cleanup script
   */
  async performAggressiveCleanup() {
    this.logger.info('🧹 Starting aggressive browser cleanup...');
    
    try {
      // 1. Kill any orphaned Chrome/Chromium processes
      this.logger.info('Killing orphaned browser processes...');
      try {
        await execAsync('pkill -f chromium 2>/dev/null || true');
        await execAsync('pkill -f chrome 2>/dev/null || true');
        await execAsync('pkill -f chromedriver 2>/dev/null || true');
        this.logger.info('✓ Browser processes terminated');
      } catch (error) {
        this.logger.warn(`Process cleanup warning: ${error.message}`);
      }
      
      // 2. Count temp directories before cleanup (like your script)
      let chromiumDirs = 0;
      let managedDirs = 0;
      let snapDirs = 0;
      
      try {
        const { stdout: chromiumCount } = await execAsync('find /tmp -name ".org.chromium.Chromium.*" -type d 2>/dev/null | wc -l');
        chromiumDirs = parseInt(chromiumCount.trim()) || 0;
        
        const { stdout: managedCount } = await execAsync('find /tmp -name "chromium-managed-*" -type d 2>/dev/null | wc -l');
        managedDirs = parseInt(managedCount.trim()) || 0;
        
        const { stdout: snapCount } = await execAsync('find /tmp -name "snap.chromium" -type d 2>/dev/null | wc -l');
        snapDirs = parseInt(snapCount.trim()) || 0;
      } catch (error) {
        this.logger.warn(`Error counting temp directories: ${error.message}`);
      }
      
      this.logger.info(`Found temp directories - Chromium: ${chromiumDirs}, Managed: ${managedDirs}, Snap: ${snapDirs}`);
      
      // 3. Clean temp directories (exactly like your script)
      if (chromiumDirs > 0) {
        this.logger.info('Cleaning .org.chromium.Chromium.* directories...');
        try {
          await execAsync('find /tmp -name ".org.chromium.Chromium.*" -type d -exec rm -rf {} + 2>/dev/null || true');
          this.logger.info(`✓ ${chromiumDirs} Chromium directories cleaned`);
        } catch (error) {
          this.logger.warn(`Chromium cleanup warning: ${error.message}`);
        }
      }
      
      if (managedDirs > 0) {
        this.logger.info('Cleaning chromium-managed-* directories...');
        try {
          await execAsync('find /tmp -name "chromium-managed-*" -type d -exec rm -rf {} + 2>/dev/null || true');
          this.logger.info(`✓ ${managedDirs} managed directories cleaned`);
        } catch (error) {
          this.logger.warn(`Managed dirs cleanup warning: ${error.message}`);
        }
      }
      
      if (snapDirs > 0) {
        this.logger.info('Cleaning snap.chromium directories...');
        try {
          await execAsync('find /tmp -path "*/snap.chromium*" -type d -exec rm -rf {} + 2>/dev/null || true');
          this.logger.info(`✓ ${snapDirs} snap directories cleaned`);
        } catch (error) {
          this.logger.warn(`Snap cleanup warning: ${error.message}`);
        }
      }
      
      // 4. Clean our managed temp directories
      await this.cleanupManagedTempDirs();
      
      // 5. Verify cleanup success
      try {
        const { stdout: remaining } = await execAsync('find /tmp -name "*chromium*" -type d 2>/dev/null | wc -l');
        const remainingCount = parseInt(remaining.trim()) || 0;
        
        if (remainingCount === 0) {
          this.logger.info('✅ Aggressive cleanup completed successfully');
        } else {
          this.logger.warn(`⚠️  ${remainingCount} Chromium directories still remain`);
        }
      } catch (error) {
        this.logger.warn('Could not verify cleanup completion');
      }
      
      // Small delay to let system settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return true;
      
    } catch (error) {
      this.logger.error(`Aggressive cleanup failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Recover from browser failure - main recovery method
   */
  async recoverFromBrowserFailure(originalError) {
    if (!this.shouldAttemptRecovery()) {
      throw originalError;
    }
    
    this.isInRecovery = true;
    this.recoveryAttempts++;
    this.lastRecoveryTime = Date.now();
    
    this.logger.warn(`🔄 BROWSER RECOVERY INITIATED (Attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`);
    this.logger.warn(`Original error: ${originalError.message}`);
    
    try {
      // Step 1: Force close current browser instance
      this.logger.info('Step 1: Force closing current browser instance...');
      try {
        if (this.driver) {
          await this.driver.quit();
        }
      } catch (error) {
        this.logger.warn(`Force quit warning: ${error.message}`);
      }
      this.driver = null;
      
      // Step 2: Aggressive cleanup
      this.logger.info('Step 2: Performing aggressive cleanup...');
      const cleanupSuccess = await this.performAggressiveCleanup();
      if (!cleanupSuccess) {
        throw new Error('Aggressive cleanup failed');
      }
      
      // Step 3: Reinitialize browser
      this.logger.info('Step 3: Reinitializing browser...');
      await this.initialize();
      
      if (!this.driver) {
        throw new Error('Failed to reinitialize browser - no driver created');
      }
      
      // Step 4: Verify new browser works
      this.logger.info('Step 4: Verifying new browser functionality...');
      await this.verifyBrowserFunctionality();
      
      // Success!
      this.logger.info('✅ Browser recovery completed successfully');
      this.isInRecovery = false;
      
      return true;
      
    } catch (error) {
      this.logger.error(`❌ Browser recovery failed: ${error.message}`);
      this.isInRecovery = false;
      
      // If this was our last attempt, throw the original error
      if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
        this.logger.error('Max recovery attempts exceeded, giving up');
        throw originalError;
      }
      
      throw error;
    }
  }

  /**
   * Verify that the new browser instance is working
   */
  async verifyBrowserFunctionality() {
    try {
      // Test basic navigation
      await this.driver.get('https://www.google.com');
      
      // Test that page loads
      await this.driver.wait(async () => {
        const readyState = await this.driver.executeScript('return document.readyState');
        return readyState === 'complete';
      }, 10000);
      
      // Test basic JavaScript execution
      const testResult = await this.driver.executeScript('return "browser_test_ok";');
      if (testResult !== 'browser_test_ok') {
        throw new Error('JavaScript execution test failed');
      }
      
      this.logger.info('✓ Browser functionality verification passed');
      
    } catch (error) {
      this.logger.error(`Browser functionality verification failed: ${error.message}`);
      throw new Error(`New browser instance is not functional: ${error.message}`);
    }
  }

  /**
   * Enhanced navigate method with aggressive timeouts and random Steam URLs
   */
  async navigateTo(url) {
    this.logger.info(`Starting navigation to: ${url}`);
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    // Use more aggressive timeout for Steam sites
    const isSteamSite = url.includes('steamcommunity.com') || url.includes('steampowered.com');
    const originalPageLoadTimeout = 60000; // Store original
    
    if (isSteamSite) {
      // Set aggressive timeout for Steam sites (15 seconds)
      await this.driver.manage().setTimeouts({ pageLoad: 15000 });
      this.logger.info('Using aggressive 15s timeout for Steam site');
    }

    try {
      // If this is a steamcommunity.com base URL, randomize it
      let finalUrl = url;
      if (url === 'https://steamcommunity.com' || url === 'https://steamcommunity.com/') {
        finalUrl = this.getRandomSteamCommunityUrl();
        this.logger.info(`Randomized Steam URL: ${finalUrl}`);
      }
      
      await this.driver.get(finalUrl);
      this.logger.info(`✓ Navigation completed for: ${finalUrl}`);
      
      await this.waitForPageLoad();
      this.logger.info(`✓ Page load completed`);
      
      // Reset recovery attempts on successful navigation
      if (this.recoveryAttempts > 0) {
        this.logger.info(`✓ Navigation successful - resetting recovery counter`);
        this.recoveryAttempts = 0;
      }
      
      // Check cache size after navigation (async, don't block)
      setImmediate(() => {
        this.checkAndCleanCacheBySize().catch(error => {
          this.logger.warn(`Background cache check failed: ${error.message}`);
        });
      });
      
    } catch (error) {
      this.logger.error(`Failed to navigate to ${url}: ${error.message}`);
      
      // Check if this is a timeout specifically
      if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
        this.logger.warn(`⏰ Navigation timeout to ${url} - this may be Steam throttling`);
        
        // For Steam sites with timeout, don't trigger recovery - just throw
        if (isSteamSite) {
          throw new Error(`Steam site navigation timeout: ${error.message}`);
        }
      }
      
      // Check if this is a critical browser error requiring recovery
      if (this.isCriticalBrowserError(error)) {
        this.logger.warn('🚨 Critical browser error detected, attempting recovery...');
        
        try {
          await this.recoverFromBrowserFailure(error);
          
          // Retry navigation after successful recovery
          this.logger.info(`Retrying navigation to ${url} after recovery...`);
          
          // Use same randomization for retry if applicable
          let retryUrl = url;
          if (url === 'https://steamcommunity.com' || url === 'https://steamcommunity.com/') {
            retryUrl = this.getRandomSteamCommunityUrl();
            this.logger.info(`Randomized retry URL: ${retryUrl}`);
          }
          
          await this.driver.get(retryUrl);
          await this.waitForPageLoad();
          
          this.logger.info('✅ Navigation successful after recovery');
          return;
          
        } catch (recoveryError) {
          this.logger.error(`Recovery failed, throwing original error: ${recoveryError.message}`);
          throw error;
        }
      }
      
      throw error;
      
    } finally {
      // Always restore original timeout
      if (isSteamSite) {
        try {
          await this.driver.manage().setTimeouts({ pageLoad: originalPageLoadTimeout });
          this.logger.info('Restored original page load timeout');
        } catch (timeoutError) {
          this.logger.warn(`Failed to restore timeout: ${timeoutError.message}`);
        }
      }
    }
  }

  /**
   * Get a random SteamCommunity URL to humanize behavior
   */
  getRandomSteamCommunityUrl() {
    const steamUrls = [
      'https://steamcommunity.com/',
      'https://steamcommunity.com/discussions/',
      'https://steamcommunity.com/workshop/',
      'https://steamcommunity.com/market/',
      'https://steamcommunity.com/?subsection=screenshots',
      'https://steamcommunity.com/groups/',
      'https://steamcommunity.com/stats/'
    ];
    
    const randomIndex = Math.floor(Math.random() * steamUrls.length);
    return steamUrls[randomIndex];
  }

  /**
   * Reset recovery state (call this when starting a new cycle)
   */
  resetRecoveryState() {
    this.recoveryAttempts = 0;
    this.lastRecoveryTime = 0;
    this.isInRecovery = false;
    this.logger.info('Recovery state reset for new cycle');
  }
  
  /**
   * Detect Chromium executable path based on platform
   */
  detectChromiumPath() {
    const platform = process.platform;
    const isProduction = process.env.NODE_ENV === 'production';
    let possiblePaths = [];

    if (isProduction) {
      // Production environment: prioritize server-specific paths
      this.logger.info('Production environment detected - prioritizing server paths');
      possiblePaths.push('/snap/bin/chromium'); // Ubuntu server snap install
      
      // Add fallbacks for production
      if (platform === 'linux') {
        possiblePaths.push(
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/usr/local/bin/chromium'
        );
      }
    } else {
      // Development environment: use original detection logic
      this.logger.info('Development environment detected - using local detection');
      
      if (platform === 'darwin') { // macOS
        possiblePaths.push(
          '/Applications/Chromium-138.app/Contents/MacOS/Google Chrome for Testing',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/usr/local/bin/chromium',
          '/opt/homebrew/bin/chromium'
        );
      } else if (platform === 'linux') { // Linux/Ubuntu
        possiblePaths.push(
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/snap/bin/chromium',
          '/usr/local/bin/chromium'
        );
      } else if (platform === 'win32') { // Windows
        possiblePaths.push(
          'C:\\Program Files\\Chromium\\Application\\chromium.exe',
          'C:\\Program Files (x86)\\Chromium\\Application\\chromium.exe'
        );
      }
    }

    // Check for environment variable override
    if (process.env.CHROMIUM_PATH) {
      possiblePaths.unshift(process.env.CHROMIUM_PATH);
    }

    // Find first existing path
    for (const chromiumPath of possiblePaths) {
      try {
        if (fs.existsSync(chromiumPath)) {
          this.logger.info(`Found Chromium at: ${chromiumPath}`);
          return chromiumPath;
        }
      } catch (error) {
        // Continue checking other paths
      }
    }

    this.logger.warn('Chromium not found in standard locations, falling back to system PATH');
    return null; // Let Selenium try to find it in PATH
  }

  /**
   * Clean up old temp files before starting
   */
  async cleanupOldTempFiles() {
    try {
      const platform = process.platform;
      let tempDir = '/tmp';
      
      if (platform === 'win32') {
        tempDir = process.env.TEMP || process.env.TMP || 'C:\\Temp';
      } else if (platform === 'darwin') {
        tempDir = process.env.TMPDIR || '/tmp';
      }

      // Remove old Chromium temp directories (older than 1 hour)
      const { exec } = require('child_process');
      const cleanupCommand = platform === 'win32' 
        ? `forfiles /p "${tempDir}" /m ".org.chromium.Chromium.*" /d -1 /c "cmd /c rmdir /s /q @path" 2>nul`
        : `find "${tempDir}" -name ".org.chromium.Chromium.*" -type d -mmin +60 -exec rm -rf {} + 2>/dev/null || true`;

      await new Promise((resolve) => {
        exec(cleanupCommand, (error) => {
          if (error) {
            this.logger.warn(`Cleanup command failed: ${error.message}`);
          } else {
            this.logger.info('Old Chromium temp files cleaned up');
          }
          resolve();
        });
      });
    } catch (error) {
      this.logger.warn(`Error during temp file cleanup: ${error.message}`);
    }
  }

  /**
   * Create managed temporary directory
   */
  async createManagedTempDir() {
    try {
      const fs = require('fs-extra');
      const path = require('path');
      const os = require('os');
      
      const tempBase = os.tmpdir();
      const timestamp = Date.now();
      const tempDir = path.join(tempBase, `chromium-managed-${timestamp}`);
      
      await fs.ensureDir(tempDir);
      this.tempDirs.push(tempDir);
      
      return tempDir;
    } catch (error) {
      this.logger.warn(`Failed to create managed temp directory: ${error.message}`);
      return null;
    }
  }

  /**
   * SELECTIVE CLEANUP: Between Steam accounts (lightweight)
   */
  async cleanupBetweenSteamAccounts() {
    if (!this.driver) return;

    try {
      this.logger.info('Cleaning Steam account-specific data...');
      
      // 1. ALWAYS clear - critical for user separation
      await this.driver.manage().deleteAllCookies();
      await this.driver.executeScript(`
        try {
          localStorage.clear();
          sessionStorage.clear();
          console.log('Storage cleared');
        } catch (e) {
          console.warn('Storage clear failed:', e);
        }
      `);
      
      // 2. Clear only user-specific cache (optional, efficient)
      await this.driver.executeScript(`
        if ('caches' in window) {
          caches.keys().then(names => {
            names.forEach(name => {
              if (name.includes('steamcommunity.com') && 
                  (name.includes('login') || name.includes('profiles') || 
                   name.includes('friends') || name.includes('id/'))) {
                caches.delete(name);
                console.log('Deleted user-specific cache:', name);
              }
            });
          }).catch(e => console.warn('Cache cleanup failed:', e));
        }
      `);
      
      this.logger.info('✓ Steam account data cleaned (selective)');
      
    } catch (error) {
      this.logger.warn(`Selective cleanup failed: ${error.message}`);
      // Don't stop the process if cleanup fails
    }
  }

  /**
   * SIZE-BASED CLEANUP: When cache gets too big (aggressive)
   */
  async checkAndCleanCacheBySize() {
    if (!this.driver) return;

    // Don't check too frequently
    const now = Date.now();
    if (now - this.lastCacheSizeCheck < this.cacheCheckIntervalMs) {
      return;
    }
    this.lastCacheSizeCheck = now;

    try {
      // Get cache size estimation via DevTools if available
      const cacheSize = await this.estimateCacheSize();
      
      if (cacheSize > this.cacheThresholdMB) {
        this.logger.warn(`Cache size (${cacheSize}MB) exceeds threshold (${this.cacheThresholdMB}MB). Performing aggressive cleanup...`);
        await this.performAggressiveCacheCleanup();
      } else {
        this.logger.info(`Cache size OK: ${cacheSize}MB (threshold: ${this.cacheThresholdMB}MB)`);
      }
      
    } catch (error) {
      this.logger.warn(`Cache size check failed: ${error.message}`);
    }
  }

  /**
   * ESTIMATE CACHE SIZE
   */
  async estimateCacheSize() {
    try {
      // Method 1: Try to get cache sizes via Storage API
      const sizes = await this.driver.executeScript(`
        return new Promise(async (resolve) => {
          try {
            let totalSize = 0;
            
            // Check storage quota if available
            if ('storage' in navigator && 'estimate' in navigator.storage) {
              const estimate = await navigator.storage.estimate();
              totalSize = estimate.usage ? Math.round(estimate.usage / 1024 / 1024) : 0;
            }
            
            // Fallback: estimate based on localStorage size
            if (totalSize === 0) {
              let storageSize = 0;
              for (let key in localStorage) {
                if (localStorage.hasOwnProperty(key)) {
                  storageSize += localStorage[key].length;
                }
              }
              totalSize = Math.round(storageSize / 1024 / 1024);
            }
            
            resolve(totalSize);
          } catch (e) {
            resolve(0); // Fallback if all methods fail
          }
        });
      `);
      
      return sizes || 0;
      
    } catch (error) {
      // Fallback: assume moderate size if we can't measure
      return 25; // MB
    }
  }

  /**
   * AGGRESSIVE CLEANUP: Clear everything except ML models
   */
  async performAggressiveCacheCleanup() {
    if (!this.driver) return;

    try {
      this.logger.info('Performing aggressive cache cleanup...');
      
      // 1. Clear all storage
      await this.driver.executeScript(`
        try {
          localStorage.clear();
          sessionStorage.clear();
          
          // Clear all caches except ML models and core browser data
          if ('caches' in window) {
            caches.keys().then(names => {
              names.forEach(name => {
                // Keep ML models and essential browser caches
                if (!name.includes('OnDeviceHeadSuggestModel') && 
                    !name.includes('optimization_guide') &&
                    !name.includes('component_crx_cache')) {
                  caches.delete(name);
                  console.log('Deleted cache:', name);
                }
              });
            });
          }
          
          console.log('Aggressive cleanup completed');
        } catch (e) {
          console.warn('Aggressive cleanup failed:', e);
        }
      `);
      
      // 2. Clear cookies (but not all - keep some system ones)
      const cookies = await this.driver.manage().getCookies();
      for (const cookie of cookies) {
        // Keep essential browser functionality cookies
        if (!cookie.name.includes('chrome') && 
            !cookie.name.includes('__chrome') &&
            !cookie.name.includes('devtools')) {
          try {
            await this.driver.manage().deleteCookie(cookie.name);
          } catch (error) {
            // Continue if individual cookie deletion fails
          }
        }
      }
      
      this.logger.info('✓ Aggressive cache cleanup completed');
      
      // Reset cache check timer
      this.lastCacheSizeCheck = Date.now();
      
    } catch (error) {
      this.logger.error(`Aggressive cleanup failed: ${error.message}`);
    }
  }

  /**
   * Clean up managed temp directories
   */
  async cleanupManagedTempDirs() {
    for (const tempDir of this.tempDirs) {
      try {
        const fs = require('fs-extra');
        if (await fs.pathExists(tempDir)) {
          await fs.remove(tempDir);
          this.logger.info(`Cleaned up managed temp directory: ${tempDir}`);
        }
      } catch (error) {
        this.logger.warn(`Failed to cleanup temp directory ${tempDir}: ${error.message}`);
      }
    }
    this.tempDirs = [];
  }

  async initialize() {
    if (this.driver) {
      await this.close();
    }

    try {
      // Clean up old temp files before starting
      await this.cleanupOldTempFiles();

      const options = new chrome.Options();
      
      // Detect and set Chromium path
      const chromiumPath = this.detectChromiumPath();
      if (chromiumPath) {
        options.setChromeBinaryPath(chromiumPath);
        this.logger.info(`Using Chromium binary: ${chromiumPath}`);
      } else {
        this.logger.info('Using Chromium from system PATH');
      }

      // Create managed temp directory
      const tempUserDataDir = await this.createManagedTempDir();
      if (tempUserDataDir) {
        options.addArguments(`--user-data-dir=${tempUserDataDir}`);
        this.logger.info(`Using managed temp directory: ${tempUserDataDir}`);
      }
      
      // Chrome arguments with smart cache limits
      const chromeArgs = [
        '--remote-allow-origins=*',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--remote-debugging-port=9222',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-background-media-downloads',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=VizDisplayCompositor',
        
        // SMART CACHE LIMITS: Allow cache but with reasonable limits
        `--disk-cache-size=${this.cacheThresholdMB * 1024 * 1024}`, // 50MB in bytes
        `--media-cache-size=${Math.round(this.cacheThresholdMB * 0.6) * 1024 * 1024}`, // 30MB for media
        '--aggressive-cache-discard', // Discard cache aggressively when needed
      ];

      if (this.config.browser.headless) {
        chromeArgs.push('--headless');
      }

      chromeArgs.forEach(arg => options.addArguments(arg));
      options.addArguments('--window-size=1280,720');

      this.driver = await new Builder()
        .forBrowser('chrome') // Still use 'chrome' driver for Chromium
        .setChromeOptions(options)
        .build();

      // Enhanced timeouts for better stability
      await this.driver.manage().setTimeouts({
        implicit: 10000,
        pageLoad: 60000,
        explicit: 30000
      });

      // Log browser info for debugging
      const capabilities = await this.driver.getCapabilities();
      const browserVersion = capabilities.get('browserVersion');
      const driverVersion = capabilities.get('chrome')?.chromedriverVersion || 'unknown';
      
      this.logger.info(`Browser initialized with smart cache management:`);
      this.logger.info(`  Browser version: ${browserVersion}`);
      this.logger.info(`  ChromeDriver version: ${driverVersion}`);
      this.logger.info(`  Cache threshold: ${this.cacheThresholdMB}MB`);
      this.logger.info(`  Headless mode: ${this.config.browser.headless}`);
      
      return this.driver;
    } catch (error) {
      this.logger.error('Failed to initialize browser:', error);
      
      // Clean up any temp directories we created if initialization failed
      await this.cleanupManagedTempDirs();
      
      // Provide helpful error messages for common issues
      if (error.message.includes('chrome not reachable') || error.message.includes('no such file')) {
        this.logger.error('HINT: Chromium binary not found. Try setting CHROMIUM_PATH environment variable.');
      } else if (error.message.includes('version')) {
        this.logger.error('HINT: Version mismatch between Chromium and ChromeDriver. Check compatibility.');
      }
      
      throw error;
    }
  }

  async waitForPageLoad() {
    if (!this.driver) return;

    try {
      await this.driver.wait(async () => {
        const readyState = await this.driver.executeScript('return document.readyState');
        return readyState === 'complete';
      }, this.config.browser.timeout);
    } catch (error) {
      // Continue if page load times out
    }
  }

  /**
   * Enhanced element finding with explicit wait - from working version
   * @param {By} locator - Element locator
   * @param {number} timeout - Custom timeout (optional)
   */
  async findElement(locator, timeout = this.config.browser.timeout) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      return await this.driver.wait(until.elementLocated(locator), timeout);
    } catch (error) {
      this.logger.error(`Element not found: ${locator}`, error);
      throw error;
    }
  }

  /**
   * Find element and wait for it to be clickable - NEW from working version
   * @param {By} locator - Element locator
   * @param {number} timeout - Custom timeout (optional)
   */
  async findClickableElement(locator, timeout = this.config.browser.timeout) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      const element = await this.findElement(locator, timeout);
      await this.driver.wait(until.elementIsEnabled(element), timeout);
      return element;
    } catch (error) {
      this.logger.error(`Clickable element not found: ${locator}`, error);
      throw error;
    }
  }

  /**
   * Find multiple elements with timeout - ENHANCED
   * @param {By} locator - Element locator
   * @param {number} timeout - Custom timeout (optional)
   */
  async findElements(locator, timeout = this.config.browser.timeout) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      // Wait for at least one element to be present
      await this.driver.wait(until.elementLocated(locator), timeout);
      return await this.driver.findElements(locator);
    } catch (error) {
      // Return empty array if no elements found
      return [];
    }
  }

  /**
   * Enhanced element waiting with multiple conditions - NEW
   * @param {By} locator - Element locator
   * @param {string} condition - 'visible', 'clickable', 'enabled', 'present'
   * @param {number} timeout - Custom timeout (optional)
   */
  async waitForElement(locator, condition = 'present', timeout = this.config.browser.timeout) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      let element;
      
      switch (condition) {
        case 'visible':
          element = await this.driver.wait(until.elementLocated(locator), timeout);
          await this.driver.wait(until.elementIsVisible(element), timeout);
          return element;
          
        case 'clickable':
          return await this.findClickableElement(locator, timeout);
          
        case 'enabled':
          element = await this.driver.wait(until.elementLocated(locator), timeout);
          await this.driver.wait(until.elementIsEnabled(element), timeout);
          return element;
          
        case 'present':
        default:
          return await this.findElement(locator, timeout);
      }
    } catch (error) {
      this.logger.error(`Element condition '${condition}' not met for: ${locator}`, error);
      throw error;
    }
  }

  /**
   * Smart element finder with multiple selector fallbacks - NEW
   * @param {Array} selectors - Array of By selectors to try in order
   * @param {number} timeout - Timeout for each selector attempt
   */
  async findElementWithFallbacks(selectors, timeout = 5000) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    for (let i = 0; i < selectors.length; i++) {
      const selector = selectors[i];
      try {
        const element = await this.driver.wait(until.elementLocated(selector), timeout);
        if (element) {
          this.logger.info(`Element found with selector ${i + 1}/${selectors.length}`);
          return element;
        }
      } catch (error) {
        // Continue to next selector
        if (i === selectors.length - 1) {
          this.logger.error(`All ${selectors.length} selectors failed`);
          throw new Error(`No element found with any of the ${selectors.length} provided selectors`);
        }
      }
    }
  }

  /**
   * Enhanced JavaScript element finder - NEW
   * @param {string} jsScript - JavaScript to find element
   * @param {number} timeout - Timeout in milliseconds
   */
  async findElementByScript(jsScript, timeout = this.config.browser.timeout) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      const element = await this.driver.wait(() => {
        return this.driver.executeScript(`
          ${jsScript}
        `);
      }, timeout);
      
      return element;
    } catch (error) {
      this.logger.error(`JavaScript element finder failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Wait for element to become stale (useful for detecting page changes) - NEW
   * @param {WebElement} element - Element to wait for staleness
   * @param {number} timeout - Custom timeout (optional)
   */
  async waitForStaleness(element, timeout = this.config.browser.timeout) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      await this.driver.wait(until.stalenessOf(element), timeout);
      return true;
    } catch (error) {
      this.logger.error('Element did not become stale within timeout');
      return false;
    }
  }

  /**
   * Enhanced page source getter - from working version
   */
  async getPageSource() {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      return await this.driver.getPageSource();
    } catch (error) {
      this.logger.error('Failed to get page source:', error);
      return null;
    }
  }

  /**
   * Get current URL - ENHANCED with error handling
   */
  async getCurrentUrl() {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      return await this.driver.getCurrentUrl();
    } catch (error) {
      this.logger.error('Failed to get current URL:', error);
      return null;
    }
  }

  /**
   * Execute JavaScript with enhanced error handling - NEW
   * @param {string} script - JavaScript code to execute
   * @param {...any} args - Arguments to pass to the script
   */
  async executeScript(script, ...args) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      return await this.driver.executeScript(script, ...args);
    } catch (error) {
      this.logger.error(`JavaScript execution failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enhanced cookie management - NEW
   * @param {string} name - Cookie name
   * @param {string} value - Cookie value
   * @param {Object} options - Additional cookie options
   */
  async addCookie(name, value, options = {}) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      const cookieOptions = {
        name: name,
        value: value,
        ...options
      };
      
      await this.driver.manage().addCookie(cookieOptions);
      this.logger.info(`Cookie '${name}' added successfully`);
    } catch (error) {
      this.logger.error(`Failed to add cookie '${name}': ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all cookies or specific cookie - NEW
   * @param {string} name - Optional cookie name to get specific cookie
   */
  async getCookies(name = null) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      if (name) {
        return await this.driver.manage().getCookie(name);
      } else {
        return await this.driver.manage().getCookies();
      }
    } catch (error) {
      this.logger.error(`Failed to get cookies: ${error.message}`);
      return null;
    }
  }

  /**
   * Refresh page and wait for load - ENHANCED
   */
  async refresh() {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      await this.driver.navigate().refresh();
      await this.waitForPageLoad();
    } catch (error) {
      this.logger.error('Failed to refresh page:', error);
      throw error;
    }
  }

  /**
   * Enhanced window management - NEW
   */
  async setWindowSize(width, height) {
    if (!this.driver) {
      throw new Error('Browser not initialized');
    }

    try {
      await this.driver.manage().window().setRect({ width, height });
      this.logger.info(`Window size set to ${width}x${height}`);
    } catch (error) {
      this.logger.error(`Failed to set window size: ${error.message}`);
      throw error;
    }
  }

  /**
   * UTILITY: Set custom cache threshold
   */
  setCacheThreshold(thresholdMB) {
    this.cacheThresholdMB = thresholdMB;
    this.logger.info(`Cache threshold updated to ${thresholdMB}MB`);
  }

  /**
   * UTILITY: Force cache check (for testing)
   */
  async forceCacheCheck() {
    this.lastCacheSizeCheck = 0; // Reset timer
    await this.checkAndCleanCacheBySize();
  }

  async close() {
    if (this.driver) {
      try {
        // First close the driver
        await this.driver.quit();
        this.driver = null;
        this.logger.info('Browser closed');
        
        // Then cleanup temp directories
        await this.cleanupManagedTempDirs();
        
        // Additional cleanup: remove any leftover temp files
        setTimeout(() => {
          this.cleanupOldTempFiles().catch(err => {
            this.logger.warn(`Background cleanup failed: ${err.message}`);
          });
        }, 1000); // Cleanup after 1 second delay
        
      } catch (error) {
        this.logger.error('Error closing browser:', error);
        
        // Force cleanup even if driver.quit() failed
        await this.cleanupManagedTempDirs();
      }
    }
  }

  getDriver() {
    return this.driver;
  }
}

module.exports = BrowserManager;