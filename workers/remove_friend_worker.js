// automate_trading/workers/remove_friend_worker.js

const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');
const DjangoClient = require('../shared/django_client');
const SteamSessionManager = require('../shared/steam_session_manager');

/**
 * RemoveFriendWorker - Dummy implementation for Step 3
 * Processes remove_friend_queue tasks and updates orchestration pending_tasks
 */
class RemoveFriendWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Worker configuration
    this.workerName = 'RemoveFriendWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.removeFriend?.processInterval || 5000; // 5 seconds default
    this.batchSize = config.removeFriend?.batchSize || 5; // Process up to 5 tasks per cycle
    
    // Initialize HTTP client for negotiations
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.removeFriendQueue = createQueueManager('remove_friend_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);
    this.followUpQueue = createQueueManager('follow_up_queue', config, logger, this.httpClient);

    // Initialize Django client for Link.status updates
    this.djangoClient = new DjangoClient();

    // Initialize Steam Session Manager for Steam operations
    this.steamSessionManager = SteamSessionManager;

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
   * Process a batch of tasks from the remove friend queue
   */
  async processBatch() {
    try {
      // Get next batch of tasks to process (remove them from queue)
      const tasks = await this.removeFriendQueue.getNextTasks(this.batchSize, true);
      
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
        }
      }
    } catch (error) {
      this.logger.error(`${this.workerName} batch processing error: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single remove friend task (REAL IMPLEMENTATION FOR STEP 7)
   * MODIFIED: Now implements actual removal steps instead of dummy simulation
   */
  async processTask(task) {
    const { taskID, reason } = task;
    
    this.logger.info(`${this.workerName}: Processing friend removal for ${taskID} (reason: ${reason || 'not specified'})`);
    
    // Parse task ID to get Steam IDs
    const steamIds = this.parseTaskID(taskID);
    
    try {
      // ✅ STEP 1: Check the follow-up queue for tasks involving this friend; remove if found
      const followUpResult = await this.checkAndRemoveFollowUpTasks(taskID);
      this.logger.info(`${this.workerName}: Follow-up cleanup: ${followUpResult.removed} task(s) removed`);
      
      // ✅ STEP 2: Remove the negotiation for this friend
      const negotiationResult = await this.removeNegotiation(taskID);
      if (negotiationResult.success) {
        if (negotiationResult.removed) {
          this.logger.info(`${this.workerName}: Negotiation removal: Successfully removed (previous state: ${negotiationResult.previousState})`);
        } else {
          this.logger.info(`${this.workerName}: Negotiation removal: Already clean (not found)`);
        }
      } else {
        this.logger.error(`${this.workerName}: Negotiation removal failed: ${negotiationResult.error}`);
        // Continue with other steps even if negotiation removal fails
      }
      
      // ✅ STEP 3: Update database Link.status depending on scenario
      const linkUpdateResult = await this.updateLinkStatus(taskID, reason);

      // FIXED: Always capture steamAccountId (even if Link update fails)
      const steamAccountId = linkUpdateResult.steamAccountId || null;

      if (linkUpdateResult.success) {
        this.logger.info(`${this.workerName}: Link status update: Successfully updated to '${linkUpdateResult.status}' (reason: ${reason})`);
      } else {
        this.logger.error(`${this.workerName}: Link status update failed: ${linkUpdateResult.error}`);
        // Continue with other steps even if link update fails
      }
      
      // ✅ STEP 4: Remove SteamFriend entry in database
      const steamFriendResult = await this.removeSteamFriendEntry(taskID, steamAccountId);
      if (steamFriendResult.success) {
        if (steamFriendResult.removed) {
          this.logger.info(`${this.workerName}: SteamFriend removal: Successfully removed friend relationship`);
        } else {
          this.logger.info(`${this.workerName}: SteamFriend removal: No relationship found to remove (already clean)`);
        }
      } else {
        this.logger.error(`${this.workerName}: SteamFriend removal failed: ${steamFriendResult.error}`);
        // Continue with other steps even if friend removal fails
      }
      
      // ✅ STEP 5: Cancel friendship on Steam
      const steamRemovalResult = await this.removeSteamFriendship(taskID);
      if (steamRemovalResult.success) {
        if (steamRemovalResult.removed) {
          this.logger.info(`${this.workerName}: Steam friendship removal: Successfully removed friend on Steam`);
        } else {
          this.logger.info(`${this.workerName}: Steam friendship removal: ${steamRemovalResult.message || 'Skipped (no session available)'}`);
        }
      } else {
        this.logger.error(`${this.workerName}: Steam friendship removal failed: ${steamRemovalResult.error}`);
        // Not a critical failure - we've already cleaned up our data
      }

      // If Steam friendship wasn't actually removed (no session), schedule a retry via follow-up queue
      if (steamRemovalResult.success && !steamRemovalResult.removed) {
        await this.scheduleRetryViaFollowUp(taskID, reason);
        this.logger.info(`${this.workerName}: ⏳ Scheduled retry for Steam friendship removal of ${taskID} in 6 hours`);
      } else {
        this.logger.info(`${this.workerName}: ✅ Successfully completed removal process for ${taskID}`);
      }
      
    } catch (error) {
      this.logger.error(`${this.workerName}: ❌ Error during removal process for ${taskID}: ${error.message}`);
      throw error; // Re-throw to be handled by batch processor
    }
  }

  /**
   * Check the follow-up queue for tasks involving this friend and remove them
   * This is step 1 of the RemoveFriendWorker implementation for Step 7
   */
  async checkAndRemoveFollowUpTasks(taskID) {
    try {
      // Initialize follow-up queue manager if not already done
      if (!this.followUpQueue) {
        this.followUpQueue = createQueueManager('follow_up_queue', this.config, this.logger, this.httpClient);
      }

      this.logger.info(`${this.workerName}: Checking follow-up queue for tasks related to ${taskID}`);

      // Get all follow-up tasks
      const followUpTasks = await this.followUpQueue.getTasks();
      
      // Filter tasks that match our taskID (same friend)
      const relatedTasks = followUpTasks.filter(task => task.taskID === taskID);

      if (relatedTasks.length === 0) {
        this.logger.info(`${this.workerName}: No follow-up tasks found for ${taskID}`);
        return { removed: 0, tasks: [] };
      }

      // Remove each related task
      const removedTasks = [];
      for (const followUpTask of relatedTasks) {
        try {
          const removed = await this.followUpQueue.removeTask(followUpTask.taskID);
          if (removed) {
            removedTasks.push({
              taskID: followUpTask.taskID,
              executeTime: followUpTask.execute,
              createdAt: followUpTask.created_at
            });
            this.logger.info(`${this.workerName}: ✅ Removed follow-up task ${followUpTask.taskID}`);
          }
        } catch (error) {
          this.logger.error(`${this.workerName}: Failed to remove follow-up task ${followUpTask.taskID}: ${error.message}`);
        }
      }

      this.logger.info(`${this.workerName}: Successfully removed ${removedTasks.length} follow-up task(s) for ${taskID}`);

      return {
        removed: removedTasks.length,
        tasks: removedTasks
      };

    } catch (error) {
      this.logger.error(`${this.workerName}: Error checking/removing follow-up tasks for ${taskID}: ${error.message}`);
      return { removed: 0, tasks: [], error: error.message };
    }
  }

  /**
   * Remove the negotiation for this friend
   * This is step 2 of the RemoveFriendWorker implementation for Step 7
   */
  async removeNegotiation(taskID) {
    try {
      const { ourSteamId, friendSteamId } = this.parseTaskID(taskID);

      this.logger.info(`${this.workerName}: Removing negotiation for friend ${friendSteamId} from account ${ourSteamId}`);

      // Use HttpClient to call the DELETE API endpoint directly
      const response = await this.httpClient.delete(`/negotiations/${ourSteamId}/friend/${friendSteamId}`);
      
      if (response.success && response.removed) {
        this.logger.info(`${this.workerName}: ✅ Successfully removed negotiation for friend ${friendSteamId} (previous state: ${response.previous_state})`);
        return { 
          success: true, 
          removed: true, 
          previousState: response.previous_state 
        };
      } else if (response.success && !response.removed) {
        // No negotiation found - already clean
        this.logger.info(`${this.workerName}: ✅ No negotiation found for friend ${friendSteamId} - already clean`);
        return { 
          success: true, 
          removed: false, 
          reason: 'not_found' 
        };
      } else {
        this.logger.error(`${this.workerName}: ❌ Failed to remove negotiation for friend ${friendSteamId}: ${response.error}`);
        return { 
          success: false, 
          error: response.error 
        };
      }

    } catch (error) {
      this.logger.error(`${this.workerName}: ❌ Error removing negotiation for ${taskID}: ${error.message}`);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Update Link status based on removal reason
   * This is step 3 of the RemoveFriendWorker implementation for Step 7
   */
  async updateLinkStatus(taskID, reason) {
    try {
      const { ourSteamId, friendSteamId } = this.parseTaskID(taskID);

      // Map reason to status
      let status;
      switch (reason) {
        case 'No items of interest':
          status = 'EMPTY';
          break;
        case 'Friend not responding':
          status = 'UNRESPONSIVE';
          break;
        default:
          status = 'CANCELED';
          break;
      }

      this.logger.info(`${this.workerName}: Updating Link status for friend ${friendSteamId} to '${status}' (reason: ${reason || 'not specified'})`);

      // Get steam_account_id from ourSteamId
      const accountResult = await this.djangoClient.getSteamAccountIdBySteamId(ourSteamId);

      if (!accountResult.success) {
        return {
          success: false,
          error: `Failed to get Steam account ID for ${ourSteamId}: ${accountResult.error}`,
          steamAccountId: null  // Still return null if we couldn't get the account ID
        };
      }

      const steamAccountId = accountResult.steam_account_id;
      this.logger.debug(`${this.workerName}: Found Steam account ID ${steamAccountId} for Steam ID ${ourSteamId}`);

      // Update Link status using Django client
      const updateResult = await this.djangoClient.updateLinkStatus(friendSteamId, steamAccountId, status);

      if (updateResult.success) {
        this.logger.info(`${this.workerName}: ✅ Successfully updated Link status to '${status}' for Steam ID ${friendSteamId}`);
        return {
          success: true,
          status: status,
          link_id: updateResult.link_id,
          old_status: updateResult.old_status,
          steamAccountId: steamAccountId
        };
      } else {
        // FIXED: Return steamAccountId even when Link update fails
        // This allows subsequent steps to proceed even if Link doesn't exist in database
        return {
          success: false,
          error: updateResult.error || 'Unknown error from updateLinkStatus',
          steamAccountId: steamAccountId  // Return steamAccountId for subsequent steps
        };
      }

    } catch (error) {
      this.logger.error(`${this.workerName}: ❌ Error updating Link status for ${taskID}: ${error.message}`);
      return {
        success: false,
        error: error.message,
        steamAccountId: null  // No steamAccountId available on exception
      };
    }
  }

  /**
   * Remove SteamFriend entry from database
   * This is step 4 of the RemoveFriendWorker implementation for Step 7
   */
  async removeSteamFriendEntry(taskID, steamAccountId) {
    try {
      const { friendSteamId } = this.parseTaskID(taskID);

      this.logger.info(`${this.workerName}: Removing SteamFriend entry for account ID ${steamAccountId}, friend ${friendSteamId}`);

      // Remove the friend relationship using Django client
      const removeResult = await this.djangoClient.removeSteamFriend(steamAccountId, friendSteamId);
      
      if (removeResult.success) {
        return { 
          success: true, 
          removed: removeResult.removed,
          message: removeResult.message
        };
      } else {
        return { 
          success: false, 
          error: removeResult.error || 'Unknown error from removeSteamFriend' 
        };
      }

    } catch (error) {
      this.logger.error(`${this.workerName}: ❌ Error removing SteamFriend entry for ${taskID}: ${error.message}`);
      return { 
        success: false, 
        error: error.message 
      };
    }
  }

  /**
   * Remove friendship on Steam platform
   * This is step 5 of the RemoveFriendWorker implementation for Step 7
   */
  async removeSteamFriendship(taskID) {
    try {
      const { ourSteamId, friendSteamId } = this.parseTaskID(taskID);

      this.logger.info(`${this.workerName}: Attempting to remove Steam friendship for ${friendSteamId} from account ${ourSteamId}`);

      // Get session for our Steam account
      const sessionResult = this.steamSessionManager.getSessionForMessaging(ourSteamId);

      if (!sessionResult.available) {
        this.logger.warn(`${this.workerName}: Cannot remove Steam friendship - ${sessionResult.reason}`);
        return {
          success: true, // Not a critical failure
          removed: false,
          message: `Session not available: ${sessionResult.reason}`
        };
      }

      const { steamClient } = sessionResult;

      if (!steamClient) {
        this.logger.warn(`${this.workerName}: Cannot remove Steam friendship - Steam client not available`);
        return {
          success: true, // Not a critical failure
          removed: false,
          message: 'Steam client not available in session'
        };
      }

      // Call removeFriend on the Steam client (synchronous method)
      this.logger.info(`${this.workerName}: Calling removeFriend for ${friendSteamId}...`);

      try {
        // removeFriend is a synchronous method in steam-user library
        steamClient.removeFriend(friendSteamId);

        this.logger.info(`${this.workerName}: ✅ Successfully called removeFriend for ${friendSteamId}`);

        return {
          success: true,
          removed: true,
          message: 'Steam friendship removed successfully'
        };

      } catch (removeFriendError) {
        this.logger.error(`${this.workerName}: Exception calling removeFriend for ${friendSteamId}: ${removeFriendError.message}`);
        return {
          success: false,
          removed: false,
          error: `Failed to call removeFriend: ${removeFriendError.message}`
        };
      }

    } catch (error) {
      this.logger.error(`${this.workerName}: ❌ Error removing Steam friendship for ${taskID}: ${error.message}`);
      return {
        success: false,
        removed: false,
        error: error.message
      };
    }
  }

  /**
   * Schedule a retry for Steam friendship removal via the follow-up queue.
   * When the follow-up task expires, FollowUpWorker will create a new remove-friend task.
   */
  async scheduleRetryViaFollowUp(taskID, reason) {
    const { ourSteamId, friendSteamId } = this.parseTaskID(taskID);

    const followUpTask = {
      taskID: taskID,
      execute: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), // 6 hours
      action: 'create_remove_friend_task',
      reason: reason,
      our_steam_id: ourSteamId,
      friend_steam_id: friendSteamId,
      created_at: new Date().toISOString()
    };

    await this.followUpQueue.addTask(followUpTask);
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
   * Simulate work for dummy implementation
   */
  async simulateWork(minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
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
        removeFriend: this.removeFriendQueue.getStats(),
        orchestration: this.orchestrationQueue.getStats()
      }
    };
  }
}

module.exports = RemoveFriendWorker;