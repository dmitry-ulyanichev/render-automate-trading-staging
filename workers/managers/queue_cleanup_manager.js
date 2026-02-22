// automate_trading/workers/managers/queue_cleanup_manager.js

const createQueueManager = require('../../utils/queue_factory');
const HttpClient = require('../../utils/http_client');

class QueueCleanupManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Initialize HTTP client for Redis queue operations
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers for all known queues
    this.queueManagers = {};
    this.initializeQueueManagers();

    this.logger.debug('QueueCleanupManager initialized');
  }

  /**
   * Initialize queue managers for all known queues
   */
  initializeQueueManagers() {
    const queueNames = [
      'orchestration_queue',
      'inventory_queue',
      'language_queue',
      'ai_queue',
      'trade_offer_queue',
      'message_queue',
      'remove_friend_queue',
      'follow_up_queue'
    ];

    for (const queueName of queueNames) {
      try {
        this.queueManagers[queueName] = createQueueManager(queueName, this.config, this.logger, this.httpClient);
        this.logger.debug(`Initialized queue manager for ${queueName}`);
      } catch (error) {
        this.logger.warn(`Failed to initialize queue manager for ${queueName}: ${error.message}`);
      }
    }
  }

  /**
   * Clean all tasks for a specific friend from all queues
   * @param {string} accountSteamId - Our Steam ID
   * @param {string} friendSteamId - Friend's Steam ID  
   * @returns {Promise<Object>} Cleanup results
   */
  async cleanupTasksForFriend(accountSteamId, friendSteamId) {
    const targetTaskId = `${accountSteamId}_${friendSteamId}`;
    const results = {
      success: true,
      cleaned_queues: [],
      failed_queues: [],
      total_tasks_removed: 0
    };

    this.logger.debug(`Starting queue cleanup for friend ${friendSteamId} (taskID: ${targetTaskId})`);

    // Clean each queue
    for (const [queueName, queueManager] of Object.entries(this.queueManagers)) {
      try {
        const removedCount = await this.cleanupQueue(queueManager, queueName, targetTaskId);
        
        if (removedCount > 0) {
          results.cleaned_queues.push({
            queue: queueName,
            tasks_removed: removedCount
          });
          results.total_tasks_removed += removedCount;
          
          this.logger.info(`Cleaned ${removedCount} task(s) from ${queueName} for friend ${friendSteamId}`);
        } else {
          this.logger.debug(`No tasks found in ${queueName} for friend ${friendSteamId}`);
        }
        
      } catch (error) {
        this.logger.error(`Failed to clean ${queueName} for friend ${friendSteamId}: ${error.message}`);
        results.failed_queues.push({
          queue: queueName,
          error: error.message
        });
        results.success = false;
      }
    }

    // Log summary
    if (results.total_tasks_removed > 0) {
      this.logger.info(`Queue cleanup completed for friend ${friendSteamId}: removed ${results.total_tasks_removed} task(s) from ${results.cleaned_queues.length} queue(s)`);
    } else {
      this.logger.debug(`Queue cleanup completed for friend ${friendSteamId}: no tasks found to remove`);
    }

    if (results.failed_queues.length > 0) {
      this.logger.warn(`Queue cleanup had ${results.failed_queues.length} failure(s) for friend ${friendSteamId}`);
    }

    return results;
  }

  /**
   * Clean all tasks for multiple friends from all queues (bulk operation)
   * @param {string} accountSteamId - Our Steam ID
   * @param {Array<string>} friendSteamIds - Array of friend Steam IDs
   * @returns {Promise<Object>} Bulk cleanup results
   */
  async cleanupTasksForFriends(accountSteamId, friendSteamIds) {
    const results = {
      success: true,
      friends_processed: [],
      total_tasks_removed: 0,
      failed_friends: []
    };

    this.logger.info(`Starting bulk queue cleanup for ${friendSteamIds.length} friends`);

    // Process each friend
    for (const friendSteamId of friendSteamIds) {
      try {
        const friendResult = await this.cleanupTasksForFriend(accountSteamId, friendSteamId);
        
        results.friends_processed.push({
          friend_steam_id: friendSteamId,
          tasks_removed: friendResult.total_tasks_removed,
          cleaned_queues: friendResult.cleaned_queues.length,
          success: friendResult.success
        });
        
        results.total_tasks_removed += friendResult.total_tasks_removed;
        
        if (!friendResult.success) {
          results.success = false;
        }
        
      } catch (error) {
        this.logger.error(`Failed bulk cleanup for friend ${friendSteamId}: ${error.message}`);
        results.failed_friends.push({
          friend_steam_id: friendSteamId,
          error: error.message
        });
        results.success = false;
      }
    }

    // Log bulk summary
    const processedCount = results.friends_processed.length;
    const failedCount = results.failed_friends.length;
    
    this.logger.info(`Bulk queue cleanup completed: processed ${processedCount}/${friendSteamIds.length} friends, removed ${results.total_tasks_removed} total task(s)`);
    
    if (failedCount > 0) {
      this.logger.warn(`Bulk queue cleanup had ${failedCount} friend(s) with failures`);
    }

    return results;
  }

  /**
   * Clean tasks from a specific queue for a specific taskID
   * Uses removeTask() which works for both file-based and Redis-backed queues
   * @param {QueueManager|RedisQueueManager} queueManager - Queue manager instance
   * @param {string} queueName - Name of the queue for logging
   * @param {string} targetTaskId - Target task ID to remove
   * @returns {Promise<number>} Number of tasks removed
   */
  async cleanupQueue(queueManager, queueName, targetTaskId) {
    try {
      const removed = await queueManager.removeTask(targetTaskId);

      if (removed) {
        this.logger.debug(`Removing task from ${queueName}: ${targetTaskId}`);
        return 1;
      }

      return 0;

    } catch (error) {
      this.logger.error(`Error cleaning queue ${queueName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get cleanup statistics for debugging/monitoring
   * @returns {Promise<Object>} Statistics about queue states
   */
  async getCleanupStatistics() {
    const stats = {
      queues: {},
      total_tasks: 0,
      timestamp: new Date().toISOString()
    };

    for (const [queueName, queueManager] of Object.entries(this.queueManagers)) {
      try {
        const tasks = await queueManager.getTasks();
        const taskCount = Array.isArray(tasks) ? tasks.length : 0;
        
        stats.queues[queueName] = {
          task_count: taskCount,
          status: 'accessible'
        };
        
        stats.total_tasks += taskCount;
        
      } catch (error) {
        stats.queues[queueName] = {
          task_count: 0,
          status: 'error',
          error: error.message
        };
      }
    }

    return stats;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      // QueueManager instances don't need explicit cleanup
      this.queueManagers = {};
      this.logger.info('QueueCleanupManager cleanup completed');
    } catch (error) {
      this.logger.error(`Error during QueueCleanupManager cleanup: ${error.message}`);
    }
  }
}

module.exports = QueueCleanupManager;