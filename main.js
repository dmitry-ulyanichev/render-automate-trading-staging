// automate_trading/main.js
const config = require('./config/config');
const HandleFriendsWorker = require('./workers/handle_friends_worker');
const HistoricalMessageWorker = require('./workers/historical_message_worker');

// Orchestration System Workers
const OrchestrationWorker = require('./workers/orchestration_worker');
// InventoryWorker has been moved to automate_trading_workers service
// LanguageWorker has been moved to automate_trading_workers service
// AIWorker has been moved to automate_trading_workers service
// FollowUpWorker has been moved to automate_trading_workers service
const MessageWorker = require('./workers/message_worker');
const TradeOfferWorker = require('./workers/trade_offer_worker');
const RemoveFriendWorker = require('./workers/remove_friend_worker');
const AdminNotificationWorker = require('./workers/admin_notification_worker');
// OrchestrationCleanupWorker has been moved to automate_trading_workers service
const FriendInviteWorker = require('./workers/friend_invite_worker');

const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const SteamSessionManager = require('./shared/steam_session_manager');
const HttpClient = require('./utils/http_client');

// Simple logging function
function logToFile(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [MAIN] ${level.toUpperCase()}: ${message}\n`;
  
  // Check if this level should be logged
  if (!shouldLog(level)) {
    return;
  }
  
  console.log(logMessage.trim());

  if (!config.logging.consoleOnly) {
    const logDir = path.dirname(config.logging.file);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(config.logging.file, logMessage);
  }
}

function shouldLog(messageLevel) {
  const configLevel = config.logging.level;
  
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  
  return levels[messageLevel] <= levels[configLevel];
}

class TradingAutomationService {
  constructor() {
    this.workers = new Map();
    this.isShuttingDown = false;
    this.monitoringTimer = null;
    
    this.logger = this.createLogger();
  }

  /**
   * Create a comprehensive logger with all standard levels
   */
  createLogger() {
    const logLevels = ['error', 'warn', 'info', 'debug', 'trace'];
    const logger = {};
    
    // Create methods for all standard log levels
    logLevels.forEach(level => {
      logger[level] = (msg, ...args) => {
        // Handle objects/additional arguments
        let message = msg;
        if (args.length > 0) {
          message = `${msg} ${args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
          ).join(' ')}`;
        }
        logToFile(message, level);
      };
    });
    
    // Add convenience methods
    logger.log = logger.info; // Alias for info
    logger.verbose = logger.debug; // Alias for debug
    
    return logger;
  }

  async start() {
    this.logger.info('Starting Trading Automation Service - Full Orchestration Mode');
    
    try {
      // Validate configuration
      await this.validateConfig();
      
      // Initialize workers
      await this.initializeWorkers();
      
      // Start workers
      await this.startWorkers();
      
      // Start monitoring
      this.startMonitoring();
      
      this.logger.info('Trading Automation Service started successfully with orchestration system');

      // Start health endpoint on Render (keeps service alive)
      if (process.env.RENDER) {
        this.startHealthServer();
      }

      // Set up graceful shutdown handlers
      this.setupShutdownHandlers();
      
    } catch (error) {
      this.logger.error(`Failed to start service: ${error.message}`);
      process.exit(1);
    }
  }

  async validateConfig() {
    // Check required environment variables
    const required = [
      'DJANGO_BASE_URL',
      'LINK_HARVESTER_API_KEY',
      'STEAM_API_KEY'
    ];

    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Check .env.steam.portion file exists
    const credentialsFile = config.persistentConnections.credentialsFile;
    if (!await fs.pathExists(credentialsFile)) {
      this.logger.warn(`${credentialsFile} file not found - credential authentication may fail`);
    }

    // Check node_api_service configuration
    if (!config.nodeApiService.baseUrl || !config.nodeApiService.apiKey) {
      throw new Error('Node API Service configuration incomplete');
    }

    // Check data directories exist
    const requiredDirs = [
      path.join(__dirname, 'data', 'queues'),
      path.join(__dirname, 'data', 'logs')
    ];

    for (const dir of requiredDirs) {
      await fs.ensureDir(dir);
    }
  }

    async initializeWorkers() {
    this.logger.info('Initializing workers...');

    // Initialize core workers first
    const handleFriendsWorker = new HandleFriendsWorker(config);
    this.workers.set('handleFriends', handleFriendsWorker);
    
    const historicalMessageWorker = new HistoricalMessageWorker(config);
    this.workers.set('historicalMessages', historicalMessageWorker);
    
    // Initialize orchestration system workers
    const orchestrationWorker = new OrchestrationWorker(config, this.logger);
    this.workers.set('orchestration', orchestrationWorker);
    
    // LanguageWorker runs in automate_trading_workers service
    // AIWorker runs in automate_trading_workers service

    const messageWorker = new MessageWorker(config, this.logger);
    this.workers.set('message', messageWorker);
    
    const tradeOfferWorker = new TradeOfferWorker(config, this.logger);
    this.workers.set('tradeOffer', tradeOfferWorker);
    
    const removeFriendWorker = new RemoveFriendWorker(config, this.logger);
    this.workers.set('removeFriend', removeFriendWorker);
    
    // FollowUpWorker runs in automate_trading_workers service

    // AdminNotificationWorker is optional - can be disabled when using separate microservice
    if (config.adminNotification?.enabled !== false) {
      const adminNotificationWorker = new AdminNotificationWorker(config, this.logger);
      this.workers.set('adminNotification', adminNotificationWorker);
      this.logger.info('  AdminNotificationWorker: enabled');
    } else {
      this.logger.info('  AdminNotificationWorker: disabled (using separate microservice)');
    }

    // OrchestrationCleanupWorker runs in automate_trading_workers service

    const friendInviteWorker = new FriendInviteWorker(config, this.logger);
    this.workers.set('friendInvite', friendInviteWorker);

    // Setup cross-worker dependencies
    await this.setupWorkerDependencies();

    this.logger.info('✓ All workers initialized successfully');
    this.logger.info('  Core Workers: HandleFriends, FriendInvite, HistoricalMessage');
    this.logger.info('  Orchestration Workers: Orchestration, Message, TradeOffer, RemoveFriend');
    this.logger.info('  (InventoryWorker, OrchestrationCleanupWorker, LanguageWorker, AIWorker, FollowUpWorker run in automate_trading_workers service)');
  }

  /**
   * Setup dependencies between workers
   */
  async setupWorkerDependencies() {
    const handleFriendsWorker = this.workers.get('handleFriends');
    const historicalMessageWorker = this.workers.get('historicalMessages');
    const orchestrationWorker = this.workers.get('orchestration');
    
    // Core worker dependencies (existing)
    if (handleFriendsWorker && historicalMessageWorker) {
      // Give HandleFriendsWorker access to the historical message queue
      const historicalQueue = historicalMessageWorker.messageQueue;
      
      // Set the queue in the SteamEventHandler
      handleFriendsWorker.steamEventHandler.setHistoricalMessageQueue(historicalQueue);
      
      // Give HistoricalMessageWorker access to negotiation manager
      const negotiationManager = handleFriendsWorker.negotiationManager;
      historicalMessageWorker.setNegotiationManager(negotiationManager);
      
      this.logger.info('✓ Core worker dependencies configured');
    }
    
    // Orchestration worker dependencies (new)
    if (orchestrationWorker) {
      // Initialize templates and prompts through the TemplatePromptManager
      try {
        // The TemplatePromptManager is now initialized within OrchestrationWorker
        // We just need to ensure it's loaded
        await orchestrationWorker.templatePromptManager.initializeTemplatesPrompts();
        this.logger.info('✓ TemplatePromptManager templates and prompts initialized');
      } catch (error) {
        this.logger.warn(`⚠ TemplatePromptManager initialization failed: ${error.message}`);
      }
    }
    
    // Wire session status publisher so worker services can query session health
    // via node_api_service GET /sessions/:steamId without touching this process.
    try {
      const sessionPublisherClient = new HttpClient(config, this.logger);
      SteamSessionManager.setPublisher(async (steamId, status) => {
        await sessionPublisherClient.post(`/sessions/${steamId}`, status);
      });
      this.logger.info('✓ Session status publisher wired to node_api_service');
    } catch (error) {
      // Non-fatal: workers will fall back to 'unknown' connection status
      this.logger.warn(`⚠ Session status publisher setup failed: ${error.message}`);
    }
  }

  /**
   * Start all workers in the correct order
   */
  async startWorkers() {
    // Start workers in optimal order
    const startOrder = [
      'handleFriends',       // Start first - creates persistent Steam connections
      'friendInvite',        // Start second - friend invite processing (needs active sessions)
      'historicalMessages',  // Start third - background message processing
      'orchestration',       // Start fourth - central brain of the system
      // 'inventory' runs in automate_trading_workers service
      // 'language' runs in automate_trading_workers service
      // 'ai' runs in automate_trading_workers service
      'message',             // Start sixth - message sending
      'tradeOffer',          // Start seventh - trade offer management
      'removeFriend',        // Start eighth - friend removal
      // 'followUp' runs in automate_trading_workers service
      'adminNotification',   // Start ninth - admin notification processing
      // 'orchestrationCleanup' runs in automate_trading_workers service
    ];
    
    for (const workerName of startOrder) {
      const worker = this.workers.get(workerName);
      
      if (!worker) {
        this.logger.warn(`Worker '${workerName}' not found - skipping`);
        continue;
      }
      
      try {
        await worker.start();
        this.logger.info(`✓ ${workerName} worker started`);
        
        // Small delay between worker starts to prevent resource conflicts
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        this.logger.error(`✗ Failed to start ${workerName} worker: ${error.message}`);
        
        // For critical workers, abort startup
        if (['handleFriends', 'orchestration'].includes(workerName)) {
          throw new Error(`Critical worker ${workerName} failed to start`);
        }
      }
    }

    this.logger.info('✓ All workers started successfully');
  }

  /**
   * Start monitoring system
   */
  startMonitoring() {
    this.monitoringTimer = setInterval(async () => {
      if (!this.isShuttingDown) {
        try {
          const stats = await this.getServiceStats();
          
          // Log summary every 5 minutes
          const now = new Date();
          if (now.getMinutes() % 5 === 0 && now.getSeconds() < 5) {
            this.logger.info(`📊 Service Stats - Workers: ${Object.keys(stats.workers).length}, Uptime: ${Math.floor(stats.uptime / 60)}min`);
            
            // Log worker activity
            for (const [workerName, workerStats] of Object.entries(stats.workers)) {
              if (workerStats.tasksProcessed > 0) {
                this.logger.info(`  ${workerName}: ${workerStats.tasksProcessed} tasks processed, ${workerStats.errors || 0} errors`);
              }
            }
          }
        } catch (error) {
          this.logger.error(`Monitoring error: ${error.message}`);
        }
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Start a minimal HTTP server for Render health checks
   */
  startHealthServer() {
    const port = process.env.PORT || 10000;
    this.healthServer = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.healthServer.listen(port, '0.0.0.0', () => {
      this.logger.info(`Health endpoint listening on port ${port}`);
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupShutdownHandlers() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) {
        return;
      }
      
      this.isShuttingDown = true;
      this.logger.info(`Received ${signal} - shutting down gracefully...`);
      
      try {
        // Clear monitoring timer
        if (this.monitoringTimer) {
          clearInterval(this.monitoringTimer);
        }
        
        // Stop workers in reverse order
        const stopOrder = [
          // 'orchestrationCleanup' runs in automate_trading_workers service
          'adminNotification',
          // 'followUp' runs in automate_trading_workers service
          'removeFriend', 'tradeOffer', 'message',
          // 'ai' runs in automate_trading_workers service
          'orchestration',
          // 'language' runs in automate_trading_workers service
          // 'inventory' runs in automate_trading_workers service
          'historicalMessages', 'friendInvite', 'handleFriends'
        ];
        
        for (const workerName of stopOrder) {
          const worker = this.workers.get(workerName);
          if (worker && typeof worker.stop === 'function') {
            try {
              await worker.stop();
              this.logger.info(`✓ ${workerName} worker stopped`);
            } catch (error) {
              this.logger.error(`✗ Error stopping ${workerName} worker: ${error.message}`);
            }
          }
        }
        
        this.logger.info('✓ All workers stopped - shutdown complete');
        process.exit(0);
        
      } catch (error) {
        this.logger.error(`Shutdown error: ${error.message}`);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error(`Uncaught exception: ${error.message}`);
      this.logger.error(error.stack);
      shutdown('uncaughtException');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
      shutdown('unhandledRejection');
    });
  }

  /**
   * Get comprehensive service statistics for monitoring
   */
  async getServiceStats() {
    const stats = {
      mode: 'orchestration_system',
      workers: {},
      queues: {},
      timestamp: Date.now(),
      uptime: process.uptime()
    };

    // Collect stats from each worker (some may be async)
    for (const [workerName, worker] of this.workers) {
      try {
        if (typeof worker.getWorkerStats === 'function') {
          stats.workers[workerName] = worker.getWorkerStats();
        } else if (typeof worker.getStats === 'function') {
          const result = worker.getStats();
          // Handle both sync and async getStats
          stats.workers[workerName] = result instanceof Promise ? await result : result;
        } else {
          stats.workers[workerName] = { status: 'running', statsNotAvailable: true };
        }
      } catch (error) {
        stats.workers[workerName] = { error: error.message };
      }
    }

    return stats;
  }

  /**
   * Force reconnection for debugging (can be called externally)
   */
  async forceReconnectAccount(accountId) {
    const handleFriendsWorker = this.workers.get('handleFriends');
    if (handleFriendsWorker && typeof handleFriendsWorker.forceReconnectAccount === 'function') {
      return await handleFriendsWorker.forceReconnectAccount(accountId);
    } else {
      throw new Error('HandleFriendsWorker not available or method not found');
    }
  }

  /**
   * Get orchestration system status (for debugging/monitoring)
   */
  async getOrchestrationStatus() {
    const orchestrationWorker = this.workers.get('orchestration');
    if (orchestrationWorker && typeof orchestrationWorker.getStats === 'function') {
      return orchestrationWorker.getStats();
    } else {
      throw new Error('OrchestrationWorker not available');
    }
  }

  /**
   * Emergency pause all orchestration workers (for debugging)
   */
  pauseOrchestrationSystem() {
    const orchestrationWorkers = [
      // 'inventory' runs in automate_trading_workers service
      'orchestration', 'language',
      // 'ai' runs in automate_trading_workers service
      'message', 'tradeOffer', 'removeFriend',
      // 'followUp' runs in automate_trading_workers service
      'adminNotification'
    ];

    for (const workerName of orchestrationWorkers) {
      const worker = this.workers.get(workerName);
      if (worker && typeof worker.pause === 'function') {
        worker.pause();
        this.logger.info(`⏸ ${workerName} worker paused`);
      }
    }
  }

  /**
   * Resume all orchestration workers
   */
  resumeOrchestrationSystem() {
    const orchestrationWorkers = [
      // 'inventory' runs in automate_trading_workers service
      'orchestration', 'language',
      // 'ai' runs in automate_trading_workers service
      'message', 'tradeOffer', 'removeFriend',
      // 'followUp' runs in automate_trading_workers service
      'adminNotification'
    ];

    for (const workerName of orchestrationWorkers) {
      const worker = this.workers.get(workerName);
      if (worker && typeof worker.resume === 'function') {
        worker.resume();
        this.logger.info(`▶ ${workerName} worker resumed`);
      }
    }
  }
}

// Start the service
if (require.main === module) {
  const service = new TradingAutomationService();
  service.start().catch(error => {
    console.error('Failed to start Trading Automation Service:', error);
    process.exit(1);
  });
}

module.exports = TradingAutomationService;