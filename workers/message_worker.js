// automate_trading/workers/message_worker.js
const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');

/**
 * MessageWorker - Processes message_queue tasks and updates orchestration pending_tasks
 * UPDATED: Real implementation with follow-up count management
 */
class MessageWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Worker configuration
    this.workerName = 'MessageWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.message?.processInterval || 1500; // 1.5 seconds default
    this.batchSize = config.message?.batchSize || 4; // Process up to 4 tasks per cycle
    
    // Initialize HTTP client for negotiation updates
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.messageQueue = createQueueManager('message_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.followUpQueue = createQueueManager('follow_up_queue', config, logger, this.httpClient);
    this.removeFriendQueue = createQueueManager('remove_friend_queue', config, logger, this.httpClient);
    
    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      tasksSkipped: 0,
      errors: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };
    
    // Timers
    this.processTimer = null;
    this.statsTimer = null;
    
    this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms, Batch size: ${this.batchSize}`);
  }

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    this.logger.info(`Starting ${this.workerName}...`);
    
    this.isRunning = true;
    this.stats.startedAt = new Date().toISOString();
    
    // Start processing loop
    this.startProcessingLoop();
    
    // Start statistics reporting
    this.startStatsReporting();
    
    this.logger.info(`${this.workerName} started successfully`);
  }

  /**
   * Stop the worker
   */
  stop() {
    if (!this.isRunning) {
      this.logger.warn(`${this.workerName} is not running`);
      return;
    }

    this.logger.info(`Stopping ${this.workerName}...`);
    
    this.isRunning = false;
    
    // Clear timers
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    this.logger.info(`${this.workerName} stopped`);
  }

  /**
   * Pause the worker
   */
  pause() {
    this.isPaused = true;
    this.logger.info(`${this.workerName} paused`);
  }

  /**
   * Resume the worker
   */
  resume() {
    this.isPaused = false;
    this.logger.info(`${this.workerName} resumed`);
  }

  /**
   * Start the main processing loop
   */
  startProcessingLoop() {
    this.processTimer = setInterval(async () => {
      if (!this.isRunning || this.isPaused) {
        return;
      }

      try {
        await this.processBatch();
        this.stats.cycleCount++;
      } catch (error) {
        this.logger.error(`${this.workerName} processing error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.processInterval);
  }

  /**
   * Start statistics reporting
   */
  startStatsReporting() {
    // Report stats every 60 seconds
    this.statsTimer = setInterval(() => {
      if (this.stats.tasksProcessed > 0 || this.stats.errors > 0) {
        this.logger.info(`${this.workerName} Stats - Processed: ${this.stats.tasksProcessed}, Skipped: ${this.stats.tasksSkipped}, Errors: ${this.stats.errors}, Cycles: ${this.stats.cycleCount}`);
      }
    }, 60000);
  }

  /**
   * Process a batch of tasks from the message queue
   */
  async processBatch() {
    try {
      // Get next batch of tasks to process (remove them from queue)
      const tasks = await this.messageQueue.getNextTasks(this.batchSize, true);
      
      if (tasks.length === 0) {
        return; // No tasks to process
      }

      this.logger.info(`${this.workerName} processing ${tasks.length} tasks`);

      // Process each task
      for (const task of tasks) {
        try {
          await this.processTask(task);
          this.stats.tasksProcessed++;
          this.stats.lastProcessedAt = new Date().toISOString();
        } catch (error) {
          this.logger.error(`${this.workerName} failed to process task ${task.taskID}: ${error.message}`);
          this.stats.errors++;

          // Clean up orphaned orchestration task to prevent it from being stuck forever
          // This handles ALL error types (not just connection errors)
          await this.cleanupOrchestrationTaskOnFailure(task.taskID, error.message);
        }
      }
    } catch (error) {
      this.logger.error(`${this.workerName} batch processing error: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single message task
   * UPDATED: Real implementation that sends messages via Steam and manages follow-up count
   */
  async processTask(task) {
    const { taskID, messages, message, language, priority, originalTemplate } = task;

    // Handle both formats: messages (array) or message (string/array)
    const messagesToSend = messages || message || [];
    const messageArray = Array.isArray(messagesToSend) ? messagesToSend : [messagesToSend];

    this.logger.info(`${this.workerName} Processing message sending for ${taskID}`);
    this.logger.info(`${this.workerName} Messages to send: ${messageArray.length}, Language: ${language || 'unknown'}, Template: ${originalTemplate || 'direct'}`);

    // Parse task ID to get Steam IDs
    const steamIds = this.parseTaskID(taskID);

    try {
      // Send each message via Steam with human-like delays
      // Returns array of timestamps for when each message was actually sent
      const sentTimestamps = await this.sendMessagesToFriend(steamIds.ourSteamId, steamIds.friendSteamId, messageArray);
      // this.logger.info(`${this.workerName} Real message sending through Steam temporarily disabled for testing purposes.`);

      this.logger.info(`${this.workerName} Successfully sent ${messageArray.length} message(s) to ${steamIds.friendSteamId}`);

      // Save sent messages to negotiation JSON with their actual send timestamps
      await this.saveOutgoingMessages(steamIds.ourSteamId, steamIds.friendSteamId, messageArray, sentTimestamps);

    } catch (error) {
      // Check if error is due to unavailable connection
      const isConnectionError = error.message.includes('Steam session not available') ||
                                error.message.includes('Session exists but is offline') ||
                                error.message.includes('No session found');

      if (isConnectionError) {
        const SteamSessionManager = require('../shared/steam_session_manager');
        const retryCount = (task.retryCount || 0) + 1;

        // Check retry limit FIRST before calculating delay
        if (retryCount > 10) {
          this.logger.error(`${this.workerName} Max retries (10) exceeded for ${taskID}, giving up`);

          // Clean up the orchestration task to prevent it from being stuck forever
          await this.cleanupOrchestrationTaskOnFailure(taskID, error.message);

          return; // Exit without throwing - we've cleaned up properly
        }

        // Calculate exponential backoff delay: 120s * 2^(retryCount-1)
        // Retry 1: 120s, Retry 2: 240s, Retry 3: 480s, etc.
        const baseDelay = 120000; // 120 seconds
        const requeueDelay = baseDelay * Math.pow(2, retryCount - 1);

        this.logger.warn(`${this.workerName} Connection not available for ${taskID} (attempt ${retryCount}), re-queuing with ${Math.round(requeueDelay/1000)}s delay`);

        // Request priority connection for this account
        SteamSessionManager.requestPriorityConnection(steamIds.ourSteamId);
        this.logger.info(`${this.workerName} Requested priority connection for Steam ID ${steamIds.ourSteamId}`);

        // Re-add to queue with exponential backoff delay
        const delayedTask = {
          ...task,
          execute: new Date(Date.now() + requeueDelay).toISOString(),
          retryCount: retryCount,
          lastRetryReason: 'connection_unavailable',
          lastRetryAt: new Date().toISOString()
        };

        await this.messageQueue.addTask(delayedTask);
        this.logger.info(`${this.workerName} Task ${taskID} re-queued successfully (retry ${retryCount}/10)`);

        return; // Exit gracefully - we've handled the error by re-queuing
      }

      // For other errors, throw as normal
      this.logger.error(`${this.workerName} Failed to send messages for ${taskID}: ${error.message}`);
      throw error;
    }

    // RACE CONDITION FIX: Skip clearing pending_tasks since we always delete the task anyway
    // This eliminates the race condition window where OrchestrationWorker could see
    // a task with empty pending_tasks before it gets deleted

    // UPDATED: Manage follow-up count based on orchestration task reason
    // This will delete the orchestration task at the end
    await this.manageFollowUpTask(taskID, steamIds);

    this.logger.info(`${this.workerName} Managed follow-up and removed orchestration task for ${taskID}`);
  }

  /**
   * Send messages to a friend via Steam with human-like typing delays
   * @param {string} ourSteamId - Our Steam ID
   * @param {string} friendSteamId - Friend's Steam ID
   * @param {Array<string>} messages - Array of messages to send
   * @returns {Array<string>} Array of ISO timestamps for each sent message
   */
  async sendMessagesToFriend(ourSteamId, friendSteamId, messages) {
    // Get the Steam session for our account using SteamSessionManager
    const SteamSessionManager = require('../shared/steam_session_manager');
    const sessionResult = SteamSessionManager.getSessionForMessaging(ourSteamId);

    if (!sessionResult.available) {
      throw new Error(`Steam session not available for ${ourSteamId}: ${sessionResult.reason}`);
    }

    const { steamClient, accountInfo } = sessionResult;
    this.logger.info(`${this.workerName} Using Steam session for ${accountInfo.username} (${accountInfo.steamId})`);

    // Track timestamps for each sent message
    const sentTimestamps = [];

    // Send each message with human-like delays
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Calculate typing delay based on message length (emulate human typing)
      const typingDelay = this.calculateTypingDelay(msg);

      // Log what we're doing
      const preview = msg.length > 50 ? msg.substring(0, 50) + '...' : msg;
      this.logger.info(`${this.workerName} [${i + 1}/${messages.length}] Typing delay: ${typingDelay}ms, sending: "${preview}"`);

      // Wait for "typing time" to emulate human behavior
      await this.delay(typingDelay);

      // Send the message via Steam
      try {
        steamClient.chat.sendFriendMessage(friendSteamId, msg);

        // Capture the actual send timestamp immediately after sending
        const sentAt = new Date().toISOString();
        sentTimestamps.push(sentAt);

        this.logger.info(`${this.workerName} [${i + 1}/${messages.length}] Message sent successfully at ${sentAt}`);

        // Mark session as used
        SteamSessionManager.markSessionUsed(accountInfo.accountId);

      } catch (error) {
        this.logger.error(`${this.workerName} Failed to send message ${i + 1}: ${error.message}`);
        throw error;
      }

      // Add a small delay between messages if there are multiple
      if (i < messages.length - 1) {
        const betweenMessageDelay = this.randomDelay(800, 2000);
        this.logger.debug(`${this.workerName} Waiting ${betweenMessageDelay}ms before next message...`);
        await this.delay(betweenMessageDelay);
      }
    }

    return sentTimestamps;
  }

  /**
   * Calculate human-like typing delay based on message length
   * Assumes average typing speed of 40-60 WPM (words per minute)
   * With some randomness to appear more natural
   * @param {string} message - The message to calculate typing delay for
   * @returns {number} Delay in milliseconds
   */
  calculateTypingDelay(message) {
    // Average character count per word (including spaces)
    const avgCharsPerWord = 5;

    // Convert to words
    const wordCount = message.length / avgCharsPerWord;

    // Average typing speed: 40-60 WPM (words per minute)
    // That's 0.67-1 words per second, or 1-1.5 seconds per word
    const baseWPM = 45; // middle of range
    const secondsPerWord = 60 / baseWPM;
    const baseDelay = wordCount * secondsPerWord * 1000; // Convert to milliseconds

    // Add randomness (±20%)
    const randomFactor = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
    const finalDelay = Math.floor(baseDelay * randomFactor);

    // Set reasonable bounds: minimum 1 second, maximum 30 seconds
    const minDelay = 1000;
    const maxDelay = 30000;

    return Math.max(minDelay, Math.min(maxDelay, finalDelay));
  }

  /**
   * Generate random delay between min and max milliseconds
   * @param {number} minMs - Minimum delay
   * @param {number} maxMs - Maximum delay
   * @returns {number} Random delay in milliseconds
   */
  randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Promise-based delay
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update orchestration task by removing completed pending task
   */
  async updateOrchestrationPendingTasks(taskID, completedTask) {
    try {
      this.logger.info(`${this.workerName} Attempting to update orchestration task ${taskID} - removing '${completedTask}'`);
      
      // Get all orchestration tasks
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      
      // Find the specific task
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);
      
      if (!orchestrationTask) {
        this.logger.error(`${this.workerName} No orchestration task found with taskID ${taskID}`);
        return;
      }

      // Remove the completed task from pending_tasks
      const updatedPendingTasks = (orchestrationTask.pending_tasks || [])
        .filter(pendingTask => pendingTask !== completedTask);
      
      // Update the orchestration task
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        pending_tasks: updatedPendingTasks,
        updated_at: new Date().toISOString()
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Successfully updated orchestration task ${taskID} - removed '${completedTask}'`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update orchestration task ${taskID}`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to update orchestration pending_tasks for ${taskID}: ${error.message}`);
      throw error;
    }
  }

  /**
   * NEW: Manage follow-up task creation/update based on orchestration task reason
   * This is the core logic for follow-up count management
   */
  async manageFollowUpTask(taskID, steamIds) {
    try {
      const { ourSteamId, friendSteamId } = steamIds;
      
      // Get the orchestration task to check its reason
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);
      
      if (!orchestrationTask) {
        this.logger.warn(`${this.workerName} No orchestration task found for ${taskID} - cannot determine reason`);
        return;
      }
      
      const reason = orchestrationTask.reason;
      const currentFollowUpCount = orchestrationTask.context?.followUpCount || 0;
      
      this.logger.info(`${this.workerName} Managing follow-up for ${taskID}: reason='${reason}', current count=${currentFollowUpCount}`);
      
      let newFollowUpCount;
      
      if (reason === 'follow_up') {
        // This is a follow-up message - increment the count
        newFollowUpCount = currentFollowUpCount + 1;
        this.logger.info(`${this.workerName} Follow-up message sent, incrementing count: ${currentFollowUpCount} → ${newFollowUpCount}`);
      } else {
        // This is a new conversation or reply - reset count to 0
        newFollowUpCount = 0;
        this.logger.info(`${this.workerName} New conversation (reason: ${reason}), resetting count to 0`);
      }
      
      // Update negotiation JSON with new count (source of truth)
      await this.updateNegotiationContext(ourSteamId, friendSteamId, {
        followUpCount: newFollowUpCount
      });
      
      // Check if we've reached the limit
      if (newFollowUpCount >= 4) {
        this.logger.info(`${this.workerName} Follow-up limit reached (count: ${newFollowUpCount}) - creating remove-friend task instead of follow-up`);
        
        // Remove the orchestration task since we're done with this negotiation
        await this.orchestrationQueue.removeTask(taskID);
        
        // Create remove-friend task with 20-hour delay
        await this.createRemoveFriendTask(taskID, 'low', 20 * 60 * 60 * 1000, 'Friend not responding');
        
      } else {
        // Create/update follow-up task with the new count
        await this.createFollowUpTask(taskID, newFollowUpCount);
        
        // Remove the orchestration task since message has been sent
        await this.orchestrationQueue.removeTask(taskID);
      }
      
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to manage follow-up task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up orchestration task when MessageWorker fails after max retries
   * This prevents orphaned orchestration tasks that remain stuck forever
   * @param {string} taskID - Task ID of the orchestration task to clean up
   * @param {string} errorMessage - The error message that caused the failure
   */
  async cleanupOrchestrationTaskOnFailure(taskID, errorMessage) {
    try {
      this.logger.info(`${this.workerName} Cleaning up orchestration task ${taskID} after final message failure`);

      // Try to get the orchestration task
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

      if (!orchestrationTask) {
        this.logger.warn(`${this.workerName} No orchestration task found for ${taskID} - already removed or doesn't exist`);
        return;
      }

      // Remove the orchestration task completely
      // We delete it instead of marking for review because:
      // 1. The account is offline and won't come back soon
      // 2. Keeping it just inflates the queue file size
      // 3. Logs already contain the error information
      await this.orchestrationQueue.removeTask(taskID);

      this.logger.info(`${this.workerName} Successfully removed orchestration task ${taskID} - reason: ${errorMessage}`);

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to cleanup orchestration task ${taskID}: ${error.message}`);
      // Don't throw - we want to continue even if cleanup fails
    }
  }

  /**
   * NEW: Create or update follow-up task with proper count and delay
   * @param {string} taskID - Task ID (format: ourSteamId_friendSteamId)
   * @param {number} followUpCount - Current follow-up count (0-3)
   */
  async createFollowUpTask(taskID, followUpCount) {
    try {
      const { ourSteamId, friendSteamId } = this.parseTaskID(taskID);
      
      // Calculate delay based on follow-up count (SCENARIO 16 rules)
      const delay = this.calculateFollowUpDelay(followUpCount);
      
      if (delay === null) {
        this.logger.warn(`${this.workerName} No delay calculated for count ${followUpCount} - should not happen`);
        return;
      }
      
      const executeTime = new Date(Date.now() + delay).toISOString();
      
      const followUpTask = {
        taskID: taskID,
        execute: executeTime,
        followUpCount: followUpCount,
        created_at: new Date().toISOString(),
        our_steam_id: ourSteamId,
        friend_steam_id: friendSteamId
      };
      
      const added = await this.followUpQueue.addTask(followUpTask);
      
      if (added) {
        const delayDesc = this.formatDelay(delay);
        this.logger.info(`${this.workerName} ✅ Created follow-up task for ${taskID} (count: ${followUpCount}, delay: ${delayDesc})`);
      } else {
        this.logger.debug(`${this.workerName} Follow-up task already exists for ${taskID} - may have been updated`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to create follow-up task: ${error.message}`);
      throw error;
    }
  }

  /**
   * NEW: Calculate follow-up delay based on SCENARIO 16 rules
   * @param {number} followUpCount - Current follow-up count (0-3)
   * @returns {number|null} Delay in milliseconds, or null if no more follow-ups
   */
  calculateFollowUpDelay(followUpCount) {
    // SCENARIO 16 rules:
    // 1st follow-up (count 0): 24 hours
    // 2nd follow-up (count 1): 24 hours
    // 3rd follow-up (count 2): 6 days
    // 4th follow-up (count 3): 24 hours
    // After 4th (count 4+): no more follow-ups
    
    switch (followUpCount) {
      case 0: // Schedule 1st follow-up
      case 1: // Schedule 2nd follow-up
        return 24 * 60 * 60 * 1000; // 24 hours
      case 2: // Schedule 3rd follow-up
        return 6 * 24 * 60 * 60 * 1000; // 6 days
      case 3: // Schedule 4th follow-up
        return 24 * 60 * 60 * 1000; // 24 hours
      default:
        return null; // No more follow-ups
    }
  }

  /**
   * NEW: Format delay for logging
   * @param {number} delayMs - Delay in milliseconds
   * @returns {string} Human readable delay
   */
  formatDelay(delayMs) {
    const hours = Math.floor(delayMs / (60 * 60 * 1000));
    if (hours < 24) {
      return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  /**
   * NEW: Update negotiation context via HTTP API
   * @param {string} ourSteamId - Our Steam ID
   * @param {string} friendSteamId - Friend's Steam ID
   * @param {Object} updates - Fields to update in negotiation
   */
  async updateNegotiationContext(ourSteamId, friendSteamId, updates) {
    try {
      // Load current negotiations
      const currentNegotiations = await this.httpClient.loadNegotiations(ourSteamId);

      // Ensure negotiation exists for this friend
      if (!currentNegotiations.negotiations[friendSteamId]) {
        this.logger.warn(`${this.workerName} Negotiation not found for ${friendSteamId}, cannot update`);
        return;
      }

      // Apply updates
      Object.assign(currentNegotiations.negotiations[friendSteamId], updates);
      currentNegotiations.negotiations[friendSteamId].updated_at = new Date().toISOString();

      // Save back via HTTP API
      await this.httpClient.saveNegotiations(ourSteamId, currentNegotiations);

      this.logger.info(`${this.workerName} Updated negotiation context for ${ourSteamId} -> ${friendSteamId}: ${JSON.stringify(updates)}`);

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to update negotiation context: ${error.message}`);
      throw error;
    }
  }

  /**
   * Save outgoing messages to negotiation JSON
   * Since friendMessageEcho doesn't fire reliably, we manually save sent messages
   * @param {string} ourSteamId - Our Steam ID
   * @param {string} friendSteamId - Friend's Steam ID
   * @param {Array<string>} messages - Array of messages that were sent
   * @param {Array<string>} sentTimestamps - Array of ISO timestamps for when each message was sent
   */
  async saveOutgoingMessages(ourSteamId, friendSteamId, messages, sentTimestamps) {
    try {
      // Load current negotiations
      const negotiations = await this.httpClient.loadNegotiations(ourSteamId);

      // Ensure negotiation exists for this friend
      if (!negotiations.negotiations[friendSteamId]) {
        this.logger.warn(`${this.workerName} Negotiation not found for ${friendSteamId}, cannot save outgoing messages`);
        return;
      }

      const negotiation = negotiations.negotiations[friendSteamId];

      // Create message objects for each sent message with their actual send timestamps
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const sentAt = sentTimestamps[i] || new Date().toISOString(); // Fallback if timestamp missing

        const messageObj = {
          id: `msg_${Date.parse(sentAt)}_${Math.random().toString(36).substr(2, 9)}`,
          timestamp: sentAt,
          direction: 'outgoing',
          message: msg,
          sender_steam_id: ourSteamId,
          sent_at: sentAt
        };

        negotiation.messages.push(messageObj);
      }

      // Update negotiation state and timestamp
      const lastTimestamp = sentTimestamps[sentTimestamps.length - 1] || new Date().toISOString();
      negotiation.state = 'awaiting_reply';
      negotiation.updated_at = lastTimestamp;

      // IMPORTANT: Reload negotiations before saving to avoid race conditions
      const freshNegotiations = await this.httpClient.loadNegotiations(ourSteamId);
      freshNegotiations.negotiations[friendSteamId] = negotiation;

      // Save back via HTTP API
      await this.httpClient.saveNegotiations(ourSteamId, freshNegotiations);

      this.logger.info(`${this.workerName} Saved ${messages.length} outgoing message(s) to negotiation JSON for ${friendSteamId}`);

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to save outgoing messages: ${error.message}`);
      // Don't throw - message sending succeeded, this is just logging
    }
  }

  /**
   * NEW: Create remove-friend task
   * @param {string} taskID - Task ID
   * @param {string} priority - Task priority
   * @param {number} delayMs - Delay in milliseconds
   * @param {string} reason - Reason for removal
   */
  async createRemoveFriendTask(taskID, priority, delayMs, reason) {
    try {
      const executeTime = new Date(Date.now() + delayMs).toISOString();
      
      const task = {
        taskID: taskID,
        execute: executeTime,
        priority: priority,
        reason: reason,
        created_at: new Date().toISOString()
      };
      
      const added = await this.removeFriendQueue.addTask(task);
      
      if (added) {
        const delayDesc = Math.round(delayMs / 1000 / 60 / 60);
        this.logger.info(`${this.workerName} ✅ Created remove-friend task for ${taskID} (delayed ${delayDesc}h, reason: ${reason})`);
      } else {
        this.logger.debug(`${this.workerName} Remove-friend task already exists for ${taskID}`);
      }
      
      return added;
      
    } catch (error) {
      this.logger.error(`${this.workerName} Failed to create remove-friend task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse taskID to extract Steam IDs
   */
  parseTaskID(taskID) {
    const parts = taskID.split('_');
    if (parts.length !== 2) {
      throw new Error(`Invalid taskID format: ${taskID}`);
    }
    return {
      ourSteamId: parts[0],
      friendSteamId: parts[1]
    };
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      queueStats: {
        message: this.messageQueue.getStats(),
        orchestration: this.orchestrationQueue.getStats(),
        followUp: this.followUpQueue.getStats()
      }
    };
  }
}

module.exports = MessageWorker;