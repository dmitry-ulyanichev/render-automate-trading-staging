// automate_trading/workers/historical_message_worker.js

const BaseWorker = require('./base_worker');
const HistoricalMessageQueue = require('./modules/historical_message_queue');
const HistoricalMessageLoader = require('./modules/historical_message_loader');
const NegotiationTaskCoordinator = require('./managers/negotiation_task_coordinator');
const HttpClient = require('../utils/http_client');
const createQueueManager = require('../utils/queue_factory');

class HistoricalMessageWorker extends BaseWorker {
  constructor(config) {
    super('HistoricalMessageWorker', config);

    // Use standard logger from BaseWorker (removed custom logging)
    
    // Initialize queue and loader
    this.messageQueue = new HistoricalMessageQueue(config, this.logger);
    this.messageLoader = new HistoricalMessageLoader(this.logger);

    // Initialize task coordinator
    this.taskCoordinator = new NegotiationTaskCoordinator(config, this.logger);

    // Dependencies (will be set by main worker)
    this.negotiationManager = null;

    this.httpClient = new HttpClient(config, this.logger);

    // Initialize trade offer queue for creating update tasks
    this.tradeOfferQueue = createQueueManager('trade_offer_queue', config, this.logger, this.httpClient);
    
    // Worker state
    this.isProcessingTask = false;
    this.workCycleCount = 0;
    this.tasksProcessed = 0;
    this.tasksCompleted = 0;
    this.tasksFailed = 0;
    
    // Exponential backoff configuration
    this.baseInterval = config.historicalMessages.baseIntervalSeconds * 1000; // Convert to ms
    this.currentInterval = this.baseInterval;
    this.errorBackoffMultiplier = config.historicalMessages.errorBackoffMultiplier;
    this.maxBackoffInterval = config.historicalMessages.maxBackoffSeconds * 1000; // Convert to ms
    this.maxConsecutiveErrors = config.historicalMessages.maxConsecutiveErrors;
    
    // Error tracking
    this.consecutiveErrors = 0;
    this.lastSuccessTime = null;
    this.lastErrorTime = null;
    
    this.logger.info(`HistoricalMessageWorker initialized with exponential backoff`);
    this.logger.info(`Base interval: ${this.baseInterval/1000}s, backoff multiplier: ${this.errorBackoffMultiplier}x, max backoff: ${this.maxBackoffInterval/1000}s`);
  }

  /**
   * Set negotiation manager dependency (called from main worker)
   */
  setNegotiationManager(negotiationManager) {
    this.negotiationManager = negotiationManager;
  }

  async initialize() {
    this.logger.info('Initializing HistoricalMessageWorker...');
    
    // Initialize the queue
    await this.messageQueue.initialize();
    
    // Log queue stats
    const stats = await this.messageQueue.getQueueStats();
    if (stats) {
      this.logger.info(`Queue initialized: ${stats.total} tasks (${stats.readyNow} ready, ${stats.waitingRetry} waiting)`);
    }
    
    this.logger.info('HistoricalMessageWorker initialization complete');
  }

  getInterval() {
    return this.currentInterval;
  }

  /**
   * Increase interval with exponential backoff
   */
  increaseInterval() {
    const previousInterval = this.currentInterval;
    this.currentInterval = Math.min(
      this.currentInterval * this.errorBackoffMultiplier,
      this.maxBackoffInterval
    );
    
    const prevSeconds = Math.round(previousInterval / 1000 * 100) / 100;
    const newSeconds = Math.round(this.currentInterval / 1000 * 100) / 100;
    
    this.logger.warn(`Error detected - increasing interval from ${prevSeconds}s to ${newSeconds}s (error #${this.consecutiveErrors})`);
    
    if (this.currentInterval === this.maxBackoffInterval) {
      this.logger.warn(`Maximum backoff interval reached (${newSeconds}s) - will maintain until success`);
    }
  }

  /**
   * Reset interval to base value on success
   */
  resetInterval() {
    if (this.currentInterval > this.baseInterval) {
      const prevSeconds = Math.round(this.currentInterval / 1000 * 100) / 100;
      const baseSeconds = Math.round(this.baseInterval / 1000 * 100) / 100;
      
      this.currentInterval = this.baseInterval;
      this.consecutiveErrors = 0;
      
      this.logger.info(`Success detected - resetting interval from ${prevSeconds}s back to ${baseSeconds}s`);
    }
  }

  /**
   * Handle success (reset backoff)
   */
  handleSuccess() {
    this.lastSuccessTime = Date.now();
    this.resetInterval();
  }

  /**
   * Handle error (increase backoff)
   */
  handleError(error) {
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.logger.error(`Maximum consecutive errors (${this.maxConsecutiveErrors}) reached - maintaining max backoff`);
      this.currentInterval = this.maxBackoffInterval;
    } else {
      this.increaseInterval();
    }
  }

  async doWork() {
    this.workCycleCount++;
    this.logger.debug(`Work cycle #${this.workCycleCount} started (interval: ${this.currentInterval/1000}s)`);
    
    // Early exit if still processing previous task
    if (this.isProcessingTask) {
      this.logger.debug('Still processing previous task, skipping cycle');
      return;
    }

    try {
      // Get next task from queue
      const task = await this.messageQueue.getNextTask();
      
      if (!task) {
        this.logger.debug('No tasks ready for processing');
        
        // Reset interval if no tasks (system is idle and healthy)
        if (this.currentInterval > this.baseInterval) {
          this.logger.debug('Queue empty - resetting to base interval');
          this.resetInterval();
        }
        
        // Periodically log queue stats when idle
        if (this.workCycleCount % 20 === 0) { // Every 20 cycles when idle
          await this.logQueueStatus();
        }
        
        return;
      }

      // Process the task
      const taskResult = await this.processTask(task);
      
      // Handle success/error for backoff
      if (taskResult.success) {
        this.handleSuccess();
      } else if (taskResult.shouldBackoff) {
        this.handleError(new Error(taskResult.error));
      }
      // If shouldBackoff is false, don't modify interval (neutral result)
      
      this.logger.debug(`Work cycle #${this.workCycleCount} completed`);
      
    } catch (error) {
      this.logger.error(`Error in work cycle: ${error.message}`);
      this.handleError(error);
    }
  }

  /**
   * Process a single historical message task with enhanced error classification
   */
  async processTask(task) {
    this.isProcessingTask = true;
    this.tasksProcessed++;
    
    const { id: taskId, accountId, friendSteamId, accountSteamId } = task;
    
    try {
      this.logger.info(`Processing task ${taskId}: account ${accountId} friend ${friendSteamId}`);
      
      // Mark task as processing
      await this.messageQueue.markTaskProcessing(taskId);
      
      // Load historical messages using existing session
      const result = await this.messageLoader.loadHistoricalMessages(task);
      
      if (result.success) {
        // Merge messages into negotiation (pass moreAvailable for hybrid replace/merge logic)
        await this.mergeHistoricalMessages(task, result.messages, result.moreAvailable);

        // Mark task as completed
        await this.messageQueue.markTaskCompleted(taskId);
        
        this.tasksCompleted++;
        this.logger.info(`✓ Task ${taskId} completed: ${result.totalCount} messages loaded`);
        
        return { success: true };
        
      } else {
        // Handle failure with enhanced error classification
        const error = new Error(result.error);
        const isSystemError = this.isSystemError(error);
        
        if (result.shouldRetry) {
          await this.messageQueue.markTaskFailed(taskId, error);
          this.logger.warn(`✗ Task ${taskId} failed (will retry): ${result.error}`);
          
          // Only backoff for system errors (session unavailable, network issues)
          return { 
            success: false, 
            error: result.error,
            shouldBackoff: isSystemError 
          };
        } else {
          await this.messageQueue.markTaskCompleted(taskId); // Remove non-retryable tasks
          this.tasksFailed++;
          this.logger.error(`✗ Task ${taskId} failed (non-retryable): ${result.error}`);
          
          return { 
            success: false, 
            error: result.error,
            shouldBackoff: false 
          };
        }
      }
      
    } catch (error) {
      this.logger.error(`Error processing task ${taskId}: ${error.message}`);
      
      try {
        await this.messageQueue.markTaskFailed(taskId, error);
      } catch (queueError) {
        this.logger.error(`Error marking task as failed: ${queueError.message}`);
      }
      
      this.tasksFailed++;
      
      return { 
        success: false, 
        error: error.message,
        shouldBackoff: this.isSystemError(error)
      };
      
    } finally {
      this.isProcessingTask = false;
    }
  }

  /**
   * Determine if error should trigger backoff (system errors vs task-specific errors)
   */
  isSystemError(error) {
    const message = error.message.toLowerCase();
    
    // System errors that affect all tasks (should trigger backoff)
    const systemErrorPatterns = [
      'no active session available',
      'session exists but is offline', 
      'session is stale',
      'steam client is not logged in',
      'rate limit',
      'too many requests',
      'service unavailable',
      'network',
      'timeout',
      'connection'
    ];
    
    return systemErrorPatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Merge historical messages into existing negotiation
   * Always merges when we have existing messages to preserve stored history
   * (Steam cleans up old messages, so we can't trust moreAvailable for retention decisions)
   * @param {Object} task - The task object
   * @param {Array} historicalMessages - Messages from Steam history
   * @param {boolean} moreAvailable - Whether Steam has more history (for logging only)
   */
  async mergeHistoricalMessages(task, historicalMessages, moreAvailable = false) {

    const { accountId, friendSteamId, accountSteamId } = task;

    try {
      // Load existing negotiation using HttpClient
      const negotiations = await this.httpClient.loadNegotiations(accountSteamId);

      // Get or create negotiation for this friend
      if (!negotiations.negotiations[friendSteamId]) {
        // NOTE: The new HttpClient.loadNegotiations returns the 'negotiations' object
        // so we need to ensure the negotiation structure is consistent
        negotiations.negotiations[friendSteamId] = {
          messages: [],
          state: 'initiating', // New friends start in the 'initiating' state
          updated_at: new Date().toISOString(),
          followUpCount: 0,
          friend_steam_id: friendSteamId
        };
        this.logger.debug(`Created new negotiation for historical messages: ${friendSteamId}`);
      }

      const negotiation = negotiations.negotiations[friendSteamId];
      const existingMessages = negotiation.messages || [];

      // UPDATED: Handle new friends with no historical messages
      if (!historicalMessages || historicalMessages.length === 0) {
        this.logger.debug(`No historical messages to merge for task ${task.id}`);

        // Update negotiation state based on existing messages (if any)
        this.updateNegotiationState(negotiation);

        // Save negotiation using HttpClient
        await this.httpClient.saveNegotiations(accountSteamId, negotiations);

        // Always call task coordinator to ensure proper task creation
        // (even if we have existing messages from previous runs)
        try {
          await this.taskCoordinator.handleLastMessage(negotiation, accountSteamId);
          this.logger.debug(`Task coordination completed for ${accountSteamId} -> ${friendSteamId}`);
        } catch (coordinatorError) {
          this.logger.error(`Task coordination failed for ${accountSteamId} -> ${friendSteamId}: ${coordinatorError.message}`);
        }

        return;
      }

      const previousMessageCount = existingMessages.length;

      // ALWAYS MERGE LOGIC:
      // - Steam cleans up old messages over time
      // - moreAvailable: false means "Steam has no more history currently available",
      //   NOT "this is the complete conversation history ever"
      // - Only replace when we have no existing messages (nothing to lose)
      // - Otherwise always merge to preserve older messages we already stored
      let finalMessages;
      let operationType;

      if (existingMessages.length === 0) {
        // Safe to replace - we have nothing to lose
        // IMPORTANT: Sort the messages chronologically (Steam doesn't guarantee order)
        finalMessages = [...historicalMessages].sort((a, b) =>
          new Date(a.timestamp) - new Date(b.timestamp)
        );
        operationType = 'replace';
        this.logger.debug(`Using REPLACE strategy for ${friendSteamId} (no existing messages)`);
      } else {
        // Always merge when we have existing messages - preserve our stored history
        // even if Steam has cleaned up older messages on their end
        finalMessages = this.mergeMessageArrays(existingMessages, historicalMessages);
        operationType = 'merge';
        this.logger.debug(`Using MERGE strategy for ${friendSteamId} (existing: ${existingMessages.length}, historical: ${historicalMessages.length})`);
      }

      // Check if any new incoming messages were added
      const newMessagesAdded = finalMessages.length - previousMessageCount;
      const hasNewIncomingMessages = this.hasNewIncomingMessages(
        existingMessages,
        finalMessages,
        accountSteamId
      );
      
      // Update negotiation
      negotiation.messages = finalMessages;
      negotiation.updated_at = new Date().toISOString();
      
      // Reset followUpCount if we found new incoming messages
      if (hasNewIncomingMessages) {
        negotiation.followUpCount = 0;
        this.logger.debug(`Reset followUpCount to 0 due to new incoming message(s) for friend ${friendSteamId}`);
      }
      
      // UPDATED: Update negotiation state with corrected states
      this.updateNegotiationState(negotiation);
      
      // Save updated negotiation using HttpClient
      await this.httpClient.saveNegotiations(accountSteamId, negotiations);

      // Check for trade offer messages in historical messages and trigger update if needed
      await this.checkForTradeOfferMessages(finalMessages, negotiations, accountSteamId);

      // NEW: Create orchestration/follow-up tasks based on conversation state
      try {
        await this.taskCoordinator.handleLastMessage(negotiation, accountSteamId);
        this.logger.debug(`Task coordination completed for ${accountSteamId} -> ${friendSteamId}`);
      } catch (coordinatorError) {
        // Don't fail the entire merge operation if task coordination fails
        this.logger.error(`Task coordination failed for ${accountSteamId} -> ${friendSteamId}: ${coordinatorError.message}`);
      }
      
      this.logger.info(`${operationType === 'replace' ? 'Replaced with' : 'Merged'} ${finalMessages.length} historical messages for account ${accountId} friend ${friendSteamId} (${newMessagesAdded >= 0 ? '+' : ''}${newMessagesAdded} net change)${hasNewIncomingMessages ? ' (followUpCount reset)' : ''}`);
      
    } catch (error) {
      this.logger.error(`Error merging historical messages: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if any new incoming messages were added during merge
   */
  hasNewIncomingMessages(existingMessages, mergedMessages, ourAccountSteamId) {
    // If no new messages were added, no incoming messages
    if (mergedMessages.length <= existingMessages.length) {
      return false;
    }
    
    // Create a set of existing message timestamps + directions for quick lookup
    const existingMessageKeys = new Set();
    existingMessages.forEach(msg => {
      const key = `${new Date(msg.timestamp).getTime()}_${msg.direction}_${msg.sender_steam_id}`;
      existingMessageKeys.add(key);
    });
    
    // Check if any of the merged messages are new incoming messages
    for (const msg of mergedMessages) {
      const key = `${new Date(msg.timestamp).getTime()}_${msg.direction}_${msg.sender_steam_id}`;
      
      // If this message wasn't in existing messages and it's incoming (from friend)
      if (!existingMessageKeys.has(key) && 
          msg.direction === 'incoming' && 
          msg.sender_steam_id !== ourAccountSteamId) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Merge historical messages with existing messages, avoiding duplicates (unchanged)
   */
  mergeMessageArrays(existingMessages, historicalMessages) {
    // Create a Set of existing message keys for deduplication
    const existingKeys = new Set();
    existingMessages.forEach(msg => {
      const key = `${new Date(msg.timestamp).getTime()}_${msg.direction}`;
      existingKeys.add(key);
    });
    
    // Filter out duplicates from historical messages
    const newMessages = historicalMessages.filter(msg => {
      const key = `${new Date(msg.timestamp).getTime()}_${msg.direction}`;
      return !existingKeys.has(key);
    });
    
    // Combine and sort by timestamp
    const allMessages = [...existingMessages, ...newMessages];
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    return allMessages;
  }

  /**
   * UPDATED: Update negotiation state based on the last message with corrected states
   */
  /**
   * Check if a message is a game invite
   */
  isGameInvite(message) {
    return message && message.message &&
           message.message.includes('[gameinvite') &&
           message.message.includes('[/gameinvite]');
  }

  updateNegotiationState(negotiation) {
    const messages = negotiation.messages;

    if (messages.length === 0) {
      // CHANGED: Use 'initiating' instead of 'pending_initiation'
      negotiation.state = 'initiating';
      this.logger.debug(`Negotiation state set to 'initiating' (no messages)`);
      return;
    }

    // Get the most recent message
    const lastMessage = messages[messages.length - 1];

    // If last message was incoming, check if it's a real message (not a game invite)
    if (lastMessage.direction === 'incoming') {
      // Exclude automated messages like game invites - treat them like no message
      if (this.isGameInvite(lastMessage)) {
        negotiation.state = 'initiating';
        this.logger.debug(`Negotiation state set to 'initiating' (last message was game invite)`);
      } else {
        // Real incoming message - we need to reply
        negotiation.state = 'replying';
        this.logger.debug(`Negotiation state set to 'replying' (last message was incoming)`);
      }
    } else {
      // If last message was outgoing, we're waiting for their reply
      // KEEP: This matches OrchestrationWorker expectations
      negotiation.state = 'waiting_for_reply';
      this.logger.debug(`Negotiation state set to 'waiting_for_reply' (last message was outgoing)`);
    }
  }

  /**
   * Log queue status periodically
   */
  async logQueueStatus() {
    try {
      const stats = await this.messageQueue.getQueueStats();
      if (stats && stats.total > 0) {
        this.logger.info(`Queue status: ${stats.total} total (${stats.readyNow} ready, ${stats.waitingRetry} waiting, ${stats.processing} processing)`);
      }
    } catch (error) {
      this.logger.warn(`Error getting queue status: ${error.message}`);
    }
  }

  /**
   * Get worker statistics for monitoring
   */
  getWorkerStats() {
    return {
      workCycleCount: this.workCycleCount,
      tasksProcessed: this.tasksProcessed,
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      isProcessingTask: this.isProcessingTask,
      
      // Backoff statistics
      backoffStats: {
        baseInterval: this.baseInterval,
        currentInterval: this.currentInterval,
        consecutiveErrors: this.consecutiveErrors,
        isInBackoff: this.currentInterval > this.baseInterval,
        backoffMultiplier: this.errorBackoffMultiplier,
        maxBackoffInterval: this.maxBackoffInterval,
        lastSuccessTime: this.lastSuccessTime,
        lastErrorTime: this.lastErrorTime
      },
      
      timestamp: Date.now()
    };
  }

  /**
   * Check for trade offer messages in historical messages and trigger update if needed
   * Compares newest trade offer message timestamp with trade_offers_updated_at
   * @param {Array} messages - Array of messages to check
   * @param {Object} negotiations - Full negotiations object with trade_offers_updated_at
   * @param {string} accountSteamId - Account Steam ID
   */
  async checkForTradeOfferMessages(messages, negotiations, accountSteamId) {
    try {
      const tradeOfferPattern = /\[tradeoffer\s+sender=\d+\s+id=\d+\]\[\/tradeoffer\]/;

      // Find all trade offer messages
      const tradeOfferMessages = messages.filter(msg =>
        msg.text && tradeOfferPattern.test(msg.text)
      );

      if (tradeOfferMessages.length === 0) {
        return; // No trade offer messages found
      }

      // Find the newest trade offer message
      const newestTradeOfferMsg = tradeOfferMessages.reduce((newest, current) => {
        return new Date(current.timestamp) > new Date(newest.timestamp) ? current : newest;
      });

      const newestTradeOfferTimestamp = new Date(newestTradeOfferMsg.timestamp);
      const tradeOffersUpdatedAt = negotiations.trade_offers_updated_at
        ? new Date(negotiations.trade_offers_updated_at)
        : null;

      this.logger.debug(`Found ${tradeOfferMessages.length} trade offer message(s), newest at ${newestTradeOfferTimestamp.toISOString()}`);

      // Check if trade offer message is newer than last update
      if (!tradeOffersUpdatedAt || newestTradeOfferTimestamp > tradeOffersUpdatedAt) {
        this.logger.info(`Trade offer message (${newestTradeOfferTimestamp.toISOString()}) is newer than last update (${tradeOffersUpdatedAt?.toISOString() || 'never'})`);

        // Check if there's already a trade offer update task for this account
        const existingTasks = await this.tradeOfferQueue.getTasks();
        const existingTask = existingTasks.find(
          task => task.taskID === accountSteamId && task.action === 'updateTradeOffers'
        );

        if (existingTask) {
          this.logger.debug(`Trade offer update task already exists for ${accountSteamId}, skipping`);
          return;
        }

        // Create trade offer update task
        const syncTask = {
          taskID: accountSteamId,
          action: 'updateTradeOffers',
          priority: 5, // High priority
          params: {
            reason: 'historical_message_sync'
          },
          created_at: new Date().toISOString()
        };

        await this.tradeOfferQueue.addTask(syncTask);
        this.logger.info(`✅ Created trade offer update task for ${accountSteamId} (triggered by historical [tradeoffer] message)`);
      } else {
        this.logger.debug(`Trade offer message timestamp is not newer than last update, skipping task creation`);
      }

    } catch (error) {
      this.logger.error(`Error checking for trade offer messages: ${error.message}`);
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Cleanup worker resources (unchanged)
   */
  async cleanup() {
    this.logger.info('HistoricalMessageWorker cleanup started');
    
    try {
      // Cleanup queue and loader
      await this.messageQueue.cleanup();
      await this.messageLoader.cleanup();
      
      // Log final stats
      const finalStats = this.getWorkerStats();
      this.logger.info(`Final stats: ${finalStats.tasksCompleted} completed, ${finalStats.tasksFailed} failed, ${finalStats.tasksProcessed} total processed`);
      this.logger.info(`Final backoff: ${finalStats.backoffStats.currentInterval/1000}s interval after ${finalStats.backoffStats.consecutiveErrors} consecutive errors`);
      
      this.logger.info('HistoricalMessageWorker cleanup completed');
    } catch (error) {
      this.logger.error(`Error during worker cleanup: ${error.message}`);
    }
  }
}

module.exports = HistoricalMessageWorker;