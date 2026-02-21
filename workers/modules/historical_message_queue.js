// automate_trading/workers/modules/historical_message_queue.js

/**
 * In-memory queue system for historical message loading tasks
 *
 * Features:
 * - In-memory storage (no persistence between runs)
 * - Exponential backoff with configurable intervals
 * - Task deduplication
 * - Priority system
 * - Rate limit handling
 *
 * NOTE: Queue is cleared on service restart - tasks are recreated when accounts reconnect
 */
class HistoricalMessageQueue {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Backoff configuration from env or default
    this.backoffMinutes = this.parseBackoffConfig(
      process.env.BACKOFF_HISTORICAL_MESSAGES_MINUTES || '1,2,4,8,16,32,60,120,240,480'
    );

    // In-memory queue storage
    this.queue = null;

    this.logger.info(`HistoricalMessageQueue initialized (in-memory) - backoff levels: ${this.backoffMinutes.length}`);
  }

  /**
   * Parse backoff configuration from string
   */
  parseBackoffConfig(configString) {
    try {
      return configString.split(',').map(str => parseInt(str.trim()));
    } catch (error) {
      this.logger.warn(`Invalid backoff config: ${configString}, using default`);
      return [1, 2, 4, 8, 16, 32, 60, 120, 240, 480];
    }
  }

  /**
   * Create default empty queue structure
   */
  createEmptyQueue() {
    return {
      tasks: {},
      stats: {
        totalEnqueued: 0,
        totalProcessed: 0,
        totalFailed: 0
      }
    };
  }

  /**
   * Initialize queue in memory
   */
  async initialize() {
    this.queue = this.createEmptyQueue();
    this.logger.info('Historical message queue initialized in memory');
  }

  /**
   * Generate unique task ID
   */
  generateTaskId(accountId, friendSteamId) {
    return `hist_msg_${accountId}_${friendSteamId}_${Date.now()}`;
  }

  /**
   * Check if task already exists for this account-friend pair
   */
  taskExists(accountId, friendSteamId) {
    try {
      if (!this.queue || !this.queue.tasks) {
        return false;
      }

      for (const task of Object.values(this.queue.tasks)) {
        if (task && task.accountId === accountId && task.friendSteamId === friendSteamId) {
          return true;
        }
      }
      return false;
    } catch (error) {
      this.logger.error(`Error checking if task exists: ${error.message}`);
      return false;
    }
  }

  /**
   * Enqueue new historical message task
   */
  async enqueueTask(accountId, friendSteamId, accountSteamId, priority = 'normal') {
    try {
      // Validate input parameters
      if (!accountId || !friendSteamId || !accountSteamId) {
        throw new Error(`Invalid parameters: accountId=${accountId}, friendSteamId=${friendSteamId}, accountSteamId=${accountSteamId}`);
      }

      // Check for existing task
      if (this.taskExists(accountId, friendSteamId)) {
        this.logger.debug(`Task already exists for account ${accountId} friend ${friendSteamId}`);
        return null;
      }

      const taskId = this.generateTaskId(accountId, friendSteamId);
      const now = Date.now();

      const task = {
        id: taskId,
        accountId: accountId,
        friendSteamId: friendSteamId,
        accountSteamId: accountSteamId,
        priority: priority,
        createdAt: new Date().toISOString(),
        attempts: 0,
        nextAttempt: now, // Available immediately
        status: 'pending'
      };

      this.queue.tasks[taskId] = task;
      this.queue.stats.totalEnqueued++;

      this.logger.info(`Enqueued historical message task: ${taskId}`);
      return taskId;

    } catch (error) {
      this.logger.error(`Error enqueuing task: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get next task ready for processing
   */
  async getNextTask() {
    try {
      const now = Date.now();

      // Ensure tasks object exists
      if (!this.queue || !this.queue.tasks) {
        return null;
      }

      // Find all ready tasks
      const readyTasks = Object.values(this.queue.tasks).filter(task =>
        task &&
        task.status === 'pending' &&
        typeof task.nextAttempt === 'number' &&
        now >= task.nextAttempt
      );

      if (readyTasks.length === 0) {
        return null;
      }

      // Sort by priority (high first) then by nextAttempt (oldest first)
      readyTasks.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority === 'high' ? -1 : 1;
        }
        return a.nextAttempt - b.nextAttempt;
      });

      return readyTasks[0];

    } catch (error) {
      this.logger.error(`Error getting next task: ${error.message}`);
      return null;
    }
  }

  /**
   * Mark task as processing
   */
  async markTaskProcessing(taskId) {
    try {
      const task = this.queue.tasks[taskId];

      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      task.status = 'processing';
      task.attempts++;
      task.lastAttemptAt = new Date().toISOString();

    } catch (error) {
      this.logger.error(`Error marking task as processing: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark task as completed successfully
   */
  async markTaskCompleted(taskId) {
    try {
      const task = this.queue.tasks[taskId];

      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      delete this.queue.tasks[taskId];
      this.queue.stats.totalProcessed++;

      this.logger.info(`Task completed: ${taskId}`);

    } catch (error) {
      this.logger.error(`Error marking task as completed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark task as failed and schedule retry with exponential backoff
   */
  async markTaskFailed(taskId, error) {
    try {
      const task = this.queue.tasks[taskId];

      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const attemptIndex = Math.min(task.attempts - 1, this.backoffMinutes.length - 1);
      const backoffMinutes = this.backoffMinutes[attemptIndex];

      // Reset to beginning if we reached max backoff
      if (attemptIndex === this.backoffMinutes.length - 1) {
        task.attempts = 1;
        this.logger.warn(`Task ${taskId} reached max backoff, resetting to beginning`);
      }

      task.status = 'pending';
      task.nextAttempt = Date.now() + (backoffMinutes * 60 * 1000);
      task.lastError = error.message;
      task.lastErrorAt = new Date().toISOString();

      this.logger.warn(`Task failed: ${taskId}, retry in ${backoffMinutes}min (attempt ${task.attempts})`);

    } catch (saveError) {
      this.logger.error(`Error marking task as failed: ${saveError.message}`);
      throw saveError;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    try {
      const now = Date.now();

      let pending = 0;
      let processing = 0;
      let readyNow = 0;
      let waitingRetry = 0;

      // Safely iterate through tasks
      if (this.queue && this.queue.tasks) {
        for (const task of Object.values(this.queue.tasks)) {
          if (!task || typeof task !== 'object') continue;

          if (task.status === 'pending') {
            pending++;
            if (typeof task.nextAttempt === 'number' && now >= task.nextAttempt) {
              readyNow++;
            } else {
              waitingRetry++;
            }
          } else if (task.status === 'processing') {
            processing++;
          }
        }
      }

      return {
        total: this.queue && this.queue.tasks ? Object.keys(this.queue.tasks).length : 0,
        pending: pending,
        processing: processing,
        readyNow: readyNow,
        waitingRetry: waitingRetry,
        totalEnqueued: this.queue?.stats?.totalEnqueued || 0,
        totalProcessed: this.queue?.stats?.totalProcessed || 0,
        totalFailed: this.queue?.stats?.totalFailed || 0,
        timestamp: Date.now()
      };

    } catch (error) {
      this.logger.error(`Error getting queue stats: ${error.message}`);
      return {
        total: 0,
        pending: 0,
        processing: 0,
        readyNow: 0,
        waitingRetry: 0,
        totalEnqueued: 0,
        totalProcessed: 0,
        totalFailed: 0,
        timestamp: Date.now(),
        error: error.message
      };
    }
  }

  /**
   * Clean up old completed/failed tasks (optional maintenance)
   */
  async cleanupOldTasks(maxAgeHours = 24) {
    try {
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);

      let removedCount = 0;

      if (this.queue && this.queue.tasks) {
        for (const [taskId, task] of Object.entries(this.queue.tasks)) {
          if (!task || typeof task !== 'object') {
            delete this.queue.tasks[taskId];
            removedCount++;
            continue;
          }

          const taskTime = new Date(task.createdAt).getTime();

          if (taskTime < cutoffTime && (task.status === 'completed' || task.attempts > 10)) {
            delete this.queue.tasks[taskId];
            removedCount++;
          }
        }
      }

      if (removedCount > 0) {
        this.logger.info(`Cleaned up ${removedCount} old tasks`);
      }

      return removedCount;

    } catch (error) {
      this.logger.error(`Error cleaning up old tasks: ${error.message}`);
      return 0;
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    this.logger.info('HistoricalMessageQueue cleanup - clearing in-memory queue');
    this.queue = null;
  }
}

module.exports = HistoricalMessageQueue;