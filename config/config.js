// automate_trading/config/config.js (SIMPLIFIED)

require('dotenv').config();

module.exports = {
  // Django API configuration
  django: {
    baseUrl: process.env.DJANGO_BASE_URL || 'http://localhost:8000/en',
    apiKey: process.env.LINK_HARVESTER_API_KEY
  },

  // Steam API configuration
  steam: {
    apiKey: process.env.STEAM_API_KEY,
    baseUrl: 'https://api.steampowered.com'
  },

  // Node API Service configuration (HTTP only - no fallback)
  nodeApiService: {
    baseUrl: process.env.NODE_API_SERVICE_URL || 'http://127.0.0.1:3001',
    apiKey: process.env.LINK_HARVESTER_API_KEY,
    timeout: parseInt(process.env.NODE_API_SERVICE_TIMEOUT) || 30000,
    retryAttempts: parseInt(process.env.NODE_API_SERVICE_RETRY_ATTEMPTS) || 3,
    retryDelayMs: parseInt(process.env.NODE_API_SERVICE_RETRY_DELAY_MS) || 1000,
    
    // Always enabled - no fallback to local files
    enabled: true,
    fallbackToLocal: false
  },

  // Browser configuration
  browser: {
    headless: process.env.NODE_ENV === 'production',
    timeout: 30000
  },

  // Logging configuration
  logging: {
    level: process.env.AUTOMATE_TRADING_LOG_LEVEL || 'debug',
    file: 'logs/automation.log',
    // Console-only logging when file system is unavailable (e.g. Render.com)
    consoleOnly: !!process.env.RENDER || process.env.LOG_CONSOLE_ONLY === 'true'
  },

  // Steam user connection retry configuration
  steamUserConnection: {
    globalCooldownMinutes: parseInt(process.env.STEAM_GLOBAL_COOLDOWN_MINUTES) || 1,
    maxGlobalCooldownMinutes: parseInt(process.env.STEAM_MAX_GLOBAL_COOLDOWN_MINUTES) || 480,
    
    // LogonSessionReplaced courtesy delay (for invite_friends service)
    sessionReplacedDelaySeconds: parseInt(process.env.STEAM_SESSION_REPLACED_DELAY_SECONDS) || 60
  },

  // Persistent connections configuration (no prioritization)
  persistentConnections: {
    maxConnections: parseInt(process.env.MAX_PERSISTENT_CONNECTIONS) || 50,
    negotiationsDataDir: process.env.NEGOTIATIONS_DATA_DIR || 'automate_trading/data/negotiations',
    
    // Credential source: .env.steam.portion with STEAM_PASSWORD_* and STEAM_SHAREDSECRET_* format
    credentialsFile: process.env.STEAM_CREDENTIALS_FILE || '.env.steam.portion'
  },

  // Historical message processing configuration
  historicalMessages: {
    // Base processing interval (aggressive for fast processing)
    baseIntervalSeconds: parseInt(process.env.HISTORICAL_MESSAGES_BASE_INTERVAL_SECONDS) || 1,
    
    // Exponential backoff on errors (x2 each retry)
    errorBackoffMultiplier: parseFloat(process.env.HISTORICAL_MESSAGES_ERROR_BACKOFF_MULTIPLIER) || 2,
    maxBackoffSeconds: parseInt(process.env.HISTORICAL_MESSAGES_MAX_BACKOFF_SECONDS) || 60,
    maxConsecutiveErrors: parseInt(process.env.HISTORICAL_MESSAGES_MAX_CONSECUTIVE_ERRORS) || 5,
    
    // Queue processing configuration
    backoffMinutes: process.env.BACKOFF_HISTORICAL_MESSAGES_MINUTES || '1,2,4,8,16,32,60,120,240,480'
  },

  // Monitoring and alerting configuration
  monitoring: {
    systemStatusIntervalMinutes: parseInt(process.env.MONITORING_SYSTEM_STATUS_INTERVAL_MINUTES) || 5,
    connectionHealthCheckEnabled: process.env.MONITORING_CONNECTION_HEALTH_CHECK_ENABLED !== 'false',
    lowSuccessRateThreshold: parseInt(process.env.MONITORING_LOW_SUCCESS_RATE_THRESHOLD) || 70
  },

  // Performance tuning configuration
  performance: {
    // Delays between operations to avoid overwhelming Steam/Django
    steamApiCallDelayMs: parseInt(process.env.STEAM_API_CALL_DELAY_MS) || 100,
    djangoApiCallDelayMs: parseInt(process.env.DJANGO_API_CALL_DELAY_MS) || 50,
    
    // Connection management
    tokenRefreshIntervalHours: parseInt(process.env.TOKEN_REFRESH_INTERVAL_HOURS) || 20,
    maxSteamApiCallsPerMinute: parseInt(process.env.MAX_STEAM_API_CALLS_PER_MINUTE) || 200,
    
    // Memory management
    enableMemoryMonitoring: process.env.ENABLE_MEMORY_MONITORING !== 'false'
  },

  // Error handling and retry configuration
  errorHandling: {
    // Connection error handling
    connectionErrors: {
      maxRetryAttempts: parseInt(process.env.CONNECTION_MAX_RETRY_ATTEMPTS) || 8,
      backoffDelaysSeconds: process.env.CONNECTION_BACKOFF_DELAYS_SECONDS || '15,30,60,120,240,480,960,1920',
      enableDetailedLogging: process.env.CONNECTION_DETAILED_LOGGING !== 'false'
    },
    
    // Django API error handling
    djangoApi: {
      maxRetryAttempts: parseInt(process.env.DJANGO_API_MAX_RETRY_ATTEMPTS) || 5,
      retryDelayMinutes: parseInt(process.env.DJANGO_API_RETRY_DELAY_MINUTES) || 5
    },
    
    // Global error handling
    enableDetailedErrorLogging: process.env.ENABLE_DETAILED_ERROR_LOGGING !== 'false',
    errorReportingEnabled: process.env.ERROR_REPORTING_ENABLED !== 'false'
  },

  // Steam API configuration with per-endpoint rate limiting
  steamApi: {
    // Global Steam API settings
    apiKey: process.env.STEAM_API_KEY,
    timeout: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TIMEOUT) || 10000,
    maxRetries: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_MAX_RETRIES) || 3,
    
    // Friends list endpoint configuration
    getFriendsList: {
      baseInterval: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_BASE_INTERVAL) || 15000, // 15 seconds
      intervals: [
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_1) || 15000,  // 15 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_2) || 30000,  // 30 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_3) || 60000,  // 60 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_4) || 120000, // 2 minutes
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_INTERVAL_5) || 240000  // 4 minutes
      ],
      resetTimeoutMinutes: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_RESET_TIMEOUT) || 4,
      maxConsecutiveErrors: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_FRIENDS_MAX_ERRORS) || 5
    },
    
    // Player summaries endpoint configuration
    getPlayerSummaries: {
      baseInterval: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_BASE_INTERVAL) || 15000, // 15 seconds
      intervals: [
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_1) || 15000,  // 15 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_2) || 30000,  // 30 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_3) || 60000,  // 60 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_4) || 120000, // 2 minutes
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_INTERVAL_5) || 240000  // 4 minutes
      ],
      resetTimeoutMinutes: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_RESET_TIMEOUT) || 4,
      maxConsecutiveErrors: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_SUMMARIES_MAX_ERRORS) || 5
    },
    
    // Future: Player inventory endpoint configuration
    getPlayerInventory: {
      baseInterval: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_BASE_INTERVAL) || 20000, // 20 seconds (slightly longer)
      intervals: [
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_INTERVAL_1) || 20000,  // 20 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_INTERVAL_2) || 40000,  // 40 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_INTERVAL_3) || 80000,  // 80 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_INTERVAL_4) || 160000, // 160 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_INTERVAL_5) || 320000  // 320 seconds (5.3 min)
      ],
      resetTimeoutMinutes: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_RESET_TIMEOUT) || 6,
      maxConsecutiveErrors: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_INVENTORY_MAX_ERRORS) || 3
    },
    
    // Future: Trade offers endpoint configuration
    getTradeOffers: {
      baseInterval: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_BASE_INTERVAL) || 10000, // 10 seconds (faster for monitoring)
      intervals: [
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_INTERVAL_1) || 10000,  // 10 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_INTERVAL_2) || 20000,  // 20 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_INTERVAL_3) || 40000,  // 40 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_INTERVAL_4) || 80000,  // 80 seconds
        parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_INTERVAL_5) || 160000  // 160 seconds (2.7 min)
      ],
      resetTimeoutMinutes: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_RESET_TIMEOUT) || 3,
      maxConsecutiveErrors: parseInt(process.env.AUTOMATE_TRADING_STEAM_API_TRADES_MAX_ERRORS) || 5
    }
  },

  // Development and debugging configuration
  development: {
    enableDebugMode: process.env.NODE_ENV === 'development',
    logConnectionStats: process.env.LOG_CONNECTION_STATS === 'true',
    simulateApiErrors: process.env.SIMULATE_API_ERRORS === 'true',
    
    // Testing overrides
    testMode: process.env.TEST_MODE === 'true',
    mockSteamApi: process.env.MOCK_STEAM_API === 'true',
    mockDjangoApi: process.env.MOCK_DJANGO_API === 'true'
  },

  orchestration: {
    // How often to check for tasks (milliseconds)
    processInterval: 5000, // 5 seconds
    
    // Maximum tasks to process per cycle
    batchSize: 3,
    
    // Enable detailed logging
    debugMode: false,
    
    // Auto-start on initialization
    autoStart: true
  },
  
  queues: {
    // Use Redis-backed task queues (via node_api_service) instead of file-based queues
    useRedis: process.env.QUEUES_USE_REDIS === 'true',

    // Lock timeout for file operations (milliseconds) - only used in file-based mode
    lockTimeout: 5000,

    // Retry delay for acquiring locks (milliseconds)
    lockRetryDelay: 50,

    // Maximum lock acquisition retries
    maxLockRetries: 100
  },

  baseAccounts: {
    ids: process.env.BASE_ACCOUNTS_IDS ?
      process.env.BASE_ACCOUNTS_IDS.split(',') : []
  },

  // AI configuration (Multiple providers with priority fallback)
  ai: {
    // Worker configuration
    processInterval: parseInt(process.env.AI_PROCESS_INTERVAL) || 3000, // 3 seconds
    batchSize: parseInt(process.env.AI_BATCH_SIZE) || 1, // Process 1 AI task per cycle (AI calls are slow)

    // Providers in priority order (try Gemini first, then Mistral)
    providers: [
      {
        name: 'gemini',
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', // Fast and cost-effective (Google recommended)
        maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS) || 500,
        temperature: parseFloat(process.env.GEMINI_TEMPERATURE) || 0.3,
        timeout: parseInt(process.env.GEMINI_TIMEOUT) || 30000,
        maxRetries: parseInt(process.env.GEMINI_MAX_RETRIES) || 2, // Fewer retries before fallback
        retryDelayMs: parseInt(process.env.GEMINI_RETRY_DELAY_MS) || 1000
      },
      {
        name: 'mistral',
        apiKey: process.env.MISTRAL_API_KEY,
        model: process.env.MISTRAL_MODEL || 'mistral-small-latest',
        maxTokens: parseInt(process.env.MISTRAL_MAX_TOKENS) || 500,
        temperature: parseFloat(process.env.MISTRAL_TEMPERATURE) || 0.3,
        timeout: parseInt(process.env.MISTRAL_TIMEOUT) || 30000,
        maxRetries: parseInt(process.env.MISTRAL_MAX_RETRIES) || 3,
        retryDelayMs: parseInt(process.env.MISTRAL_RETRY_DELAY_MS) || 1000
      }
    ]
  },

  // Trade Offer Worker configuration
  tradeOffer: {
    processInterval: parseInt(process.env.TRADE_OFFER_PROCESS_INTERVAL) || 4000, // 4 seconds
    batchSize: parseInt(process.env.TRADE_OFFER_BATCH_SIZE) || 2, // Process 2 tasks per cycle

    // Periodic sync configuration
    periodicSyncEnabled: process.env.TRADE_OFFER_PERIODIC_SYNC_ENABLED !== 'false', // Enabled by default
    periodicSyncIntervalHours: parseInt(process.env.TRADE_OFFER_PERIODIC_SYNC_INTERVAL_HOURS) || 12 // 12 hours default
  },

  // Admin Notification Worker configuration
  // Set ADMIN_NOTIFICATION_WORKER_ENABLED=false to disable (when using separate microservice)
  adminNotification: {
    enabled: process.env.ADMIN_NOTIFICATION_WORKER_ENABLED !== 'false', // Enabled by default
    processInterval: parseInt(process.env.NOTIFICATION_PROCESS_INTERVAL) || 5000,
    batchSize: parseInt(process.env.NOTIFICATION_BATCH_SIZE) || 3,
    stackCheckInterval: parseInt(process.env.NOTIFICATION_STACK_CHECK_INTERVAL) || 60000
  }
};