// automate_trading/workers/managers/redirect_manager.js
const createQueueManager = require('../../utils/queue_factory');

class RedirectManager {
  constructor(config, logger, httpClient, negotiationContextUpdater, queueManager) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient;
    this.contextUpdater = negotiationContextUpdater;
    this.queueManager = queueManager; // This is the orchestration_queue manager

    // Queue managers for other queues (initialized on demand, same pattern as OrchestrationWorker)
    this.otherQueues = {};

    // API configuration for redirects endpoint
    this.apiBaseUrl = config.nodeApiService.baseUrl;
    this.apiKey = config.nodeApiService.apiKey;
    this.timeout = config.nodeApiService.timeout || 30000;
  }

  /**
   * Get or create queue manager for a specific queue
   */
  getQueueManager(queueName) {
    if (!this.otherQueues[queueName]) {
      this.otherQueues[queueName] = createQueueManager(queueName, this.config, this.logger, this.httpClient);
    }
    return this.otherQueues[queueName];
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
   * Make API request to redirects endpoint
   */
  async apiRequest(method, endpoint, data = null) {
    const axios = require('axios');
    const config = {
      method,
      url: `${this.apiBaseUrl}/redirects${endpoint}`,
      headers: {
        'X-API-Key': this.apiKey
      },
      timeout: this.timeout
    };
    if (data !== null && data !== undefined) {
      config.headers['Content-Type'] = 'application/json';
      config.data = data;
    }
    const response = await axios(config);
    return response.data;
  }

  /**
   * Add redirect entry via Redis API
   */
  async addRedirectEntry(ourSteamId, friendSteamId, redirectedTo = []) {
    try {
      const result = await this.apiRequest('POST', '/add', {
        ourSteamId,
        friendSteamId,
        redirectedTo
      });

      this.logger.info(`${result.operation} redirect entry for friend ${friendSteamId} from ${ourSteamId} -> ${redirectedTo.join(', ')}`);

    } catch (error) {
      this.logger.error(`Failed to add redirect entry: ${error.message}`);
    }
  }

  /**
   * Check redirects for referrer and process if found
   */
  async checkRedirects(task) {
    try {
      const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);

      // Look up redirect entry by friend Steam ID
      const result = await this.apiRequest('GET', `/${friendSteamId}`);

      if (!result.found) {
        this.logger.info(`DEBUG - No redirect entry found for friend ${friendSteamId}`);

        // Mark as checked even when no referrer found
        task.context.referrer_checked = true;

        // Update task in queue
        await this.queueManager.updateTask(task.taskID, {
          context: task.context
        });

        // Update negotiation JSON
        await this.contextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
          referrer_checked: true
        });

        return { found: false };
      }

      const entry = result.entry;
      const originalAccountId = entry.ourSteamId;

      // Clean up follow-up tasks for the redirected friend
      await this.cleanupFollowUpTasks(originalAccountId, friendSteamId);

      // Load original negotiation
      const originalNegotiation = await this.httpClient.loadNegotiations(originalAccountId);

      const originalFriendData = originalNegotiation.negotiations?.[friendSteamId];

      // Handle both cases properly
      if (!originalFriendData) {
        // CASE: Friend doesn't exist in referrer's JSON
        this.logger.info(`Referrer found but friend ${friendSteamId} missing from ${originalAccountId} negotiations`);

        // Mark as checked (no messages to copy)
        task.context.referrer_checked = true;

        // Update task in queue
        await this.queueManager.updateTask(task.taskID, {
          context: task.context
        });

        // Update negotiation JSON
        await this.contextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
          referrer_checked: true
        });

      } else if (originalFriendData.messages && originalFriendData.messages.length > 0) {
        // CASE: Friend exists and has messages
        this.logger.info(`Found ${originalFriendData.messages.length} messages from referrer ${originalAccountId}`);

        // Copy messages to task context
        task.context.referred_from_messages = [...originalFriendData.messages];
        task.context.referrer_checked = true;

        // Update the task in the queue to persist context changes
        await this.queueManager.updateTask(task.taskID, {
          context: task.context
        });

        // Also save to current negotiation JSON via HTTP API
        await this.contextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
          referred_from_messages: task.context.referred_from_messages,
          referrer_checked: true
        });

      } else {
        // CASE: Friend exists but has no messages
        this.logger.info(`Referrer found but no messages from ${originalAccountId}`);

        // Mark as checked (no messages to copy)
        task.context.referrer_checked = true;

        // Update task in queue
        await this.queueManager.updateTask(task.taskID, {
          context: task.context
        });

        // Update negotiation JSON
        await this.contextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
          referrer_checked: true
        });
      }

      // ALWAYS remove entry from Redis when referrer is found
      await this.apiRequest('DELETE', `/${friendSteamId}`);

      this.logger.info(`Removed redirect entry for friend ${friendSteamId}`);

      return {
        found: true,
        messageCount: originalFriendData?.messages?.length || 0
      };

    } catch (error) {
      this.logger.error(`Error checking redirects: ${error.message}`);
      return { found: false };
    }
  }

  /**
   * Clean up follow-up tasks when friend is redirected
   */
  async cleanupFollowUpTasks(originalAccountId, friendSteamId) {
    try {
      const followUpQueue = this.getQueueManager('follow_up_queue');
      const followUpTaskId = `${originalAccountId}_${friendSteamId}`;

      // Try to remove the follow-up task
      const removed = await followUpQueue.removeTask(followUpTaskId);

      if (removed) {
        this.logger.info(`Cleaned up follow-up task ${followUpTaskId} after redirect`);
      } else {
        this.logger.debug(`No follow-up task found to clean up for ${followUpTaskId}`);
      }

    } catch (error) {
      this.logger.error(`Error cleaning up follow-up tasks: ${error.message}`);
    }
  }
}

module.exports = RedirectManager;
