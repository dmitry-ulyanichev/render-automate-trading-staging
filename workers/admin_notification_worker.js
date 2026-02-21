// automate_trading/workers/admin_notification_worker.js
const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');
const TelegramNotifier = require('../utils/telegram_notifier');
const NotificationScheduler = require('../utils/notification_scheduler');
const NotificationStack = require('../utils/notification_stack');

/**
 * AdminNotificationWorker - Handles notification tasks with smart scheduling
 *
 * Purpose:
 * - Processes notification_queue tasks created by AiWorker for placeholder AI responses
 * - Sends Telegram notifications to admins based on work schedule
 * - Stacks notifications during off-hours and sends at work hour start
 * - Removes corresponding orchestration tasks to prevent infinite loops
 *
 * Flow:
 * - AiWorker creates notification task and updates orchestration ('consult_ai' -> 'notify_admin')
 * - AdminNotificationWorker checks if any admins are at work
 *   - If YES: Send immediately to active admins via Telegram
 *   - If NO: Stack notification for later
 * - Periodic check (every minute) sends stacked notifications when admins come online
 */
class AdminNotificationWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Worker configuration
    this.workerName = 'AdminNotificationWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.adminNotification?.processInterval || 5000; // 5 seconds default
    this.batchSize = config.adminNotification?.batchSize || 3; // Process up to 3 tasks per cycle
    this.stackCheckInterval = 60000; // 1 minute for checking stacked notifications

    // Initialize HTTP client for loading negotiation data
    this.httpClient = new HttpClient(config, logger);

    // Initialize queue managers
    this.notificationQueue = createQueueManager('notification_queue', config, logger, this.httpClient);
    this.orchestrationQueue = createQueueManager('orchestration_queue', config, logger, this.httpClient);

    // Initialize Telegram notifier
    this.telegramNotifier = new TelegramNotifier(config, logger);

    // Initialize notification scheduler
    this.notificationScheduler = new NotificationScheduler(config, logger);

    // Initialize notification stack
    this.notificationStack = new NotificationStack(config, logger);

    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      sentImmediately: 0,
      stacked: 0,
      stackedSent: 0,
      errors: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };

    // Timers
    this.processTimer = null;
    this.stackCheckTimer = null;
    this.statsTimer = null;

    this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms, Stack check: ${this.stackCheckInterval}ms`);
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

    // Fetch admin Telegram IDs on startup
    await this.telegramNotifier.getAdminTelegramIds();

    // Start processing loop
    this.startProcessingLoop();

    // Start stack check loop
    this.startStackCheckLoop();

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

    if (this.stackCheckTimer) {
      clearInterval(this.stackCheckTimer);
      this.stackCheckTimer = null;
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
   * Start the stack check loop (sends stacked notifications when admins come online)
   */
  startStackCheckLoop() {
    this.stackCheckTimer = setInterval(async () => {
      if (!this.isRunning || this.isPaused) {
        return;
      }

      try {
        await this.checkAndSendStackedNotifications();
      } catch (error) {
        this.logger.error(`${this.workerName} stack check error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.stackCheckInterval);
  }

  /**
   * Start statistics reporting
   */
  startStatsReporting() {
    // Report stats every 60 seconds
    this.statsTimer = setInterval(() => {
      if (this.stats.tasksProcessed > 0 || this.stats.errors > 0) {
        this.logger.info(`${this.workerName} Stats - Processed: ${this.stats.tasksProcessed}, Sent: ${this.stats.sentImmediately}, Stacked: ${this.stats.stacked}, StackedSent: ${this.stats.stackedSent}, Errors: ${this.stats.errors}`);
      }
    }, 60000);
  }

  /**
   * Process a batch of tasks from the notification queue
   */
  async processBatch() {
    try {
      // Get next batch of tasks (WITHOUT auto-remove - we'll remove explicitly)
      const tasks = await this.notificationQueue.getNextTasks(this.batchSize);

      if (tasks.length === 0) {
        return; // No tasks to process
      }

      this.logger.info(`${this.workerName} processing ${tasks.length} notification task(s)`);

      // Process each task
      for (const task of tasks) {
        try {
          await this.processTask(task);

          // Explicitly remove the task from notification queue after successful processing
          const removed = await this.notificationQueue.removeTask(task.taskID);
          if (removed) {
            this.logger.info(`${this.workerName} ✅ Removed notification task ${task.taskID} from queue`);
          } else {
            this.logger.warn(`${this.workerName} ⚠️  Failed to remove notification task ${task.taskID} from queue`);
          }

          this.stats.tasksProcessed++;
          this.stats.lastProcessedAt = new Date().toISOString();
        } catch (error) {
          this.logger.error(`${this.workerName} failed to process task ${task.taskID}: ${error.message}`);

          // Still remove the task even if processing failed (don't retry indefinitely)
          const removed = await this.notificationQueue.removeTask(task.taskID);
          if (removed) {
            this.logger.info(`${this.workerName} ❌ Removed failed notification task ${task.taskID} from queue`);
          }

          this.stats.errors++;
        }
      }
    } catch (error) {
      this.logger.error(`${this.workerName} batch processing error: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single notification task
   * Checks if admins are at work -> send immediately or stack
   */
  async processTask(task) {
    const { taskID, notificationType, metadata, priority } = task;

    this.logger.info(`${this.workerName} Processing notification for ${taskID}`);

    // Parse task ID to get Steam IDs
    const steamIds = this.parseTaskID(taskID);

    // Load negotiation data to get our_steam_login and friend_steam_username
    let ourSteamLogin = steamIds.ourSteamId; // Fallback to Steam ID
    let friendSteamUsername = steamIds.friendSteamId; // Fallback to Steam ID

    try {
      const negotiationsData = await this.httpClient.loadNegotiations(steamIds.ourSteamId);

      if (negotiationsData) {
        // Get our_steam_login from root level
        ourSteamLogin = negotiationsData.our_steam_login || steamIds.ourSteamId;

        // Get friend_steam_username from specific negotiation
        const negotiation = negotiationsData.negotiations?.[steamIds.friendSteamId];
        if (negotiation) {
          friendSteamUsername = negotiation.friend_steam_username || steamIds.friendSteamId;
        }
      }
    } catch (error) {
      this.logger.warn(`${this.workerName} Could not load negotiation data: ${error.message} - using Steam IDs as fallback`);
    }

    // Check which admins are currently at work
    const activeAdmins = this.notificationScheduler.getActiveAdmins();

    if (activeAdmins.length > 0) {
      // Admins are online - try to send immediately
      this.logger.info(`${this.workerName} ${activeAdmins.length} admin(s) online, sending immediately`);

      const sendSuccess = await this.sendNotificationToAdmins(activeAdmins, ourSteamLogin, friendSteamUsername);

      if (sendSuccess) {
        this.stats.sentImmediately++;
      } else {
        // Failed to send - add to stack
        this.logger.warn(`${this.workerName} Failed to send, adding to stack`);
        await this.notificationStack.addNotification(ourSteamLogin, friendSteamUsername);
        this.stats.stacked++;
      }
    } else {
      // No admins online - add to stack
      this.logger.info(`${this.workerName} No admins online, adding to stack`);
      await this.notificationStack.addNotification(ourSteamLogin, friendSteamUsername);
      this.stats.stacked++;
    }

    // Remove the corresponding orchestration task
    await this.removeOrchestrationTask(taskID);

    this.logger.info(`${this.workerName} ✅ Notification task completed for ${taskID}`);
  }

  /**
   * Check and send stacked notifications when admins come online
   * Sends in batches to respect Telegram's 4096 character limit
   */
  async checkAndSendStackedNotifications() {
    // Get currently active admins
    const activeAdmins = this.notificationScheduler.getActiveAdmins();

    if (activeAdmins.length === 0) {
      return; // No admins online
    }

    // Check if there are stacked notifications
    if (!await this.notificationStack.hasNotifications()) {
      return; // No stacked notifications
    }

    // Get all stacked notifications
    const notifications = await this.notificationStack.getNotifications();

    this.logger.info(`${this.workerName} Sending ${notifications.length} stacked notification(s) to ${activeAdmins.length} admin(s)`);

    try {
      // Group notifications by login for formatting
      const byLogin = {};
      for (const notif of notifications) {
        if (!byLogin[notif.login]) {
          byLogin[notif.login] = [];
        }
        byLogin[notif.login].push({ friend: notif.friend, time: notif.time });
      }

      // Format message (respects 4096 character limit)
      const formatted = this.telegramNotifier.formatNotificationMessage(byLogin);

      // Send to ALL active admins (they all get the batch)
      const result = await this.telegramNotifier.sendToAdmins(activeAdmins, formatted.message);

      if (result.success) {
        this.logger.info(`${this.workerName} ✅ Sent ${formatted.included.length} stacked notifications to ${result.sentTo.length} admin(s): ${result.sentTo.join(', ')}`);

        if (formatted.truncated) {
          this.logger.info(`${this.workerName} ⚠️  Message was truncated (${formatted.included.length}/${formatted.totalCount} notifications sent)`);
        }

        this.stats.stackedSent += formatted.included.length;

        // Only clear the notifications that were actually sent
        await this.notificationStack.removeNotifications(formatted.included);

        if (formatted.truncated) {
          this.logger.info(`${this.workerName} 📋 ${formatted.totalCount - formatted.included.length} notifications remain in stack`);
        }
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to send stacked notifications, keeping in stack for retry`);
      }
    } catch (error) {
      this.logger.error(`${this.workerName} Error sending stacked notifications: ${error.message}`);
      // Keep in stack for retry
    }
  }

  /**
   * Send notification to specific admins via Telegram
   */
  async sendNotificationToAdmins(admins, ourSteamLogin, friendSteamUsername) {
    try {
      // Create notification data grouped by login
      const byLogin = {
        [ourSteamLogin]: [
          {
            friend: friendSteamUsername,
            time: new Date().toISOString()
          }
        ]
      };

      // Format message
      const formatted = this.telegramNotifier.formatNotificationMessage(byLogin);

      // Send to admins
      const result = await this.telegramNotifier.sendToAdmins(admins, formatted.message);

      if (result.success) {
        this.logger.info(`${this.workerName} ✅ Sent notification to ${result.sentTo.length} admin(s): ${result.sentTo.join(', ')}`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to send notification to admins`);
      }

      return result.success;
    } catch (error) {
      this.logger.error(`${this.workerName} Error sending notification: ${error.message}`);
      return false;
    }
  }

  /**
   * Remove orchestration task after notification is handled
   */
  async removeOrchestrationTask(taskID) {
    try {
      // Get all orchestration tasks
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();

      // Find the specific task
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

      if (!orchestrationTask) {
        this.logger.warn(`${this.workerName} No orchestration task found with taskID ${taskID} - may have been already removed`);
        return;
      }

      // Check if it has notify_admin in pending_tasks
      if (orchestrationTask.pending_tasks && orchestrationTask.pending_tasks.includes('notify_admin')) {
        this.logger.info(`${this.workerName} Orchestration task ${taskID} still has pending_tasks: [${orchestrationTask.pending_tasks.join(', ')}]`);

        // Remove notify_admin from pending_tasks
        const updatedPendingTasks = orchestrationTask.pending_tasks.filter(pt => pt !== 'notify_admin');

        if (updatedPendingTasks.length > 0) {
          // Still has other pending tasks - just update
          await this.orchestrationQueue.updateTask(taskID, {
            pending_tasks: updatedPendingTasks,
            updated_at: new Date().toISOString()
          });
          this.logger.info(`${this.workerName} Updated orchestration task ${taskID} pending_tasks to: [${updatedPendingTasks.join(', ')}]`);
        } else {
          // No more pending tasks - remove orchestration task
          const removed = await this.orchestrationQueue.removeTask(taskID);
          if (removed) {
            this.logger.info(`${this.workerName} ✅ Removed orchestration task ${taskID} (no more pending tasks)`);
          }
        }
      } else {
        // No notify_admin in pending_tasks - remove orchestration task anyway
        const removed = await this.orchestrationQueue.removeTask(taskID);
        if (removed) {
          this.logger.info(`${this.workerName} ✅ Removed orchestration task ${taskID}`);
        }
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to remove orchestration task ${taskID}: ${error.message}`);
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
  async getStats() {
    let stackCount = 0;
    try {
      stackCount = await this.notificationStack.getCount();
    } catch (error) {
      this.logger.warn(`${this.workerName} Could not get stack count: ${error.message}`);
    }

    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      stackCount: stackCount,
      scheduleInfo: this.notificationScheduler.getScheduleInfo(),
      queueStats: {
        notification: this.notificationQueue.getStats(),
        orchestration: this.orchestrationQueue.getStats()
      }
    };
  }
}

module.exports = AdminNotificationWorker;
