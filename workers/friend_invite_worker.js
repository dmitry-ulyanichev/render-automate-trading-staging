// automate_trading/workers/friend_invite_worker.js

const HttpClient = require('../utils/http_client');
const SteamSessionManager = require('../shared/steam_session_manager');

const QUEUE_INVITE = 'friend_invite_queue';
const QUEUE_RESULTS = 'friend_invite_results';

/**
 * FriendInviteWorker - Polls friend_invite_queue for invite tasks,
 * claims tasks for accounts this instance manages, sends invites
 * using existing persistent Steam connections, and writes results
 * to friend_invite_results queue.
 *
 * Follows the MessageWorker pattern (start/stop/pause/resume).
 * Uses setTimeout-based loop so a long-running invite batch blocks
 * further polling until it finishes.
 */
class FriendInviteWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    this.workerName = 'FriendInviteWorker';
    this.isRunning = false;
    this.isPaused = false;

    // Configurable intervals
    this.pollInterval = config.friendInvite?.pollInterval || 5000;       // 5s default
    this.delayBetweenInvites = config.friendInvite?.delayBetweenInvites || 2000; // 2s default

    // HTTP client for queue access
    this.httpClient = new HttpClient(config, logger);

    // Statistics
    this.stats = {
      tasksProcessed: 0,
      tasksClaimed: 0,
      tasksSkipped: 0,
      invitesSent: 0,
      invitesFailed: 0,
      errors: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };

    // Timer
    this.pollTimer = null;
    this.statsTimer = null;

    this.logger.info(`${this.workerName} initialized - Poll interval: ${this.pollInterval}ms, Invite delay: ${this.delayBetweenInvites}ms`);
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    this.logger.info(`Starting ${this.workerName}...`);
    this.isRunning = true;
    this.stats.startedAt = new Date().toISOString();

    this.scheduleNextPoll();
    this.startStatsReporting();

    this.logger.info(`${this.workerName} started - polling ${QUEUE_INVITE}`);
  }

  stop() {
    if (!this.isRunning) return;

    this.logger.info(`Stopping ${this.workerName}...`);
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    this.logger.info(`${this.workerName} stopped`);
  }

  pause() {
    this.isPaused = true;
    this.logger.info(`${this.workerName} paused`);
  }

  resume() {
    this.isPaused = false;
    this.logger.info(`${this.workerName} resumed`);
  }

  // ==================== POLLING LOOP ====================

  scheduleNextPoll() {
    if (!this.isRunning) return;

    this.pollTimer = setTimeout(async () => {
      try {
        await this.processCycle();
      } catch (error) {
        this.logger.error(`${this.workerName} cycle error: ${error.message}`);
        this.stats.errors++;
      }
      this.scheduleNextPoll();
    }, this.pollInterval);
  }

  async processCycle() {
    if (this.isPaused) return;

    this.stats.cycleCount++;

    // Step 1: Peek at all tasks in the shared queue
    let tasks;
    try {
      tasks = await this.httpClient.taskQueueGetAll(QUEUE_INVITE);
    } catch (error) {
      this.logger.error(`${this.workerName} failed to peek queue: ${error.message}`);
      return;
    }

    if (!tasks || tasks.length === 0) return;

    // Step 2: Get active sessions, build Set of managed online Steam IDs
    const activeSessions = SteamSessionManager.listActiveSessions();
    const managedAccountIds = new Set();
    const managedSteamIds = new Set();

    for (const session of activeSessions) {
      if (session.isOnline) {
        managedAccountIds.add(session.accountId);
        managedSteamIds.add(session.steamId);
      }
    }

    if (managedAccountIds.size === 0) return;

    // Step 3: Filter tasks to those whose accountSteamId is managed by us
    const myTasks = tasks.filter(task => {
      const data = task.data || task;
      return managedSteamIds.has(data.accountSteamId);
    });

    if (myTasks.length === 0) return;

    this.logger.info(`${this.workerName} found ${myTasks.length} tasks for our accounts (${tasks.length} total in queue)`);

    // Step 4: Try to claim and process ONE task per cycle
    for (const task of myTasks) {
      const taskData = task.data || task;
      const taskID = task.taskID || taskData.taskID;

      // Attempt to claim by removing from queue
      let claimed;
      try {
        claimed = await this.httpClient.taskQueueRemove(QUEUE_INVITE, taskID);
      } catch (error) {
        // Task was already claimed by another instance or doesn't exist
        this.logger.debug(`${this.workerName} could not claim task ${taskID}: ${error.message}`);
        this.stats.tasksSkipped++;
        continue;
      }

      if (!claimed) {
        this.stats.tasksSkipped++;
        continue;
      }

      // Successfully claimed — process it
      this.stats.tasksClaimed++;
      this.logger.info(`${this.workerName} claimed task ${taskID} for account ${taskData.username}`);

      await this.processInviteTask(taskData, taskID);

      // Process only one task per cycle, then return to polling
      break;
    }
  }

  // ==================== TASK PROCESSING ====================

  async processInviteTask(taskData, taskID) {
    const { accountId, accountSteamId, username, targets, options } = taskData;
    const startTime = Date.now();

    const result = {
      taskID: `result_${taskID}`,
      batchTaskID: taskID,
      accountId,
      accountSteamId,
      username,
      success: false,
      results: {
        successful: [],
        failed: [],
        temporaryFailures: [],
        limitReached: false,
        invitationErrorCount: 0,
        accountBanned: false
      },
      account_updates: {
        slots_used: 0,
        new_overall_slots: null,
        cleanup_performed: false,
        slots_freed: 0
      },
      cooldown_info: {
        should_apply: false,
        error_codes: [],
        reason: null
      },
      completed_at: null
    };

    try {
      // Step 1: Get session
      const sessionResult = SteamSessionManager.getSessionForInvites(accountId);

      if (!sessionResult.available) {
        this.logger.warn(`${this.workerName} session unavailable for ${username}: ${sessionResult.reason}`);
        // Re-queue with delay
        await this.requeueTask(taskData, taskID, 60000);
        return;
      }

      const client = sessionResult.steamClient;
      SteamSessionManager.markSessionUsed(accountId);

      // Step 2: Refresh live slot count from client.myFriends
      const liveSlotCount = this.countLiveSlots(client);
      result.account_updates.new_overall_slots = liveSlotCount;

      this.logger.info(`${this.workerName} [${username}] Live slots: ${liveSlotCount}/300`);

      // Step 3: Calculate capacity
      const account = {
        weekly_invite_slots: targets.length, // invite_friends already estimated capacity
        overall_friend_slots: liveSlotCount
      };

      const capacity = this.calculateAccountCapacity(account, targets.length);
      this.logger.info(`${this.workerName} [${username}] Capacity: can_send=${capacity.can_send}, max_sendable=${capacity.max_sendable}, needs_cleanup=${capacity.needs_cleanup}`);

      if (!capacity.can_send) {
        result.results.limitReached = true;
        result.success = true;
        await this.writeResult(result);
        return;
      }

      // Step 4: Cleanup old invites if needed
      if (capacity.needs_cleanup && capacity.cleanup_needed > 0) {
        const oldestPendingInvites = options?.oldest_pending_invites || [];
        const cleanupResult = await this.cleanupOldInvites(
          client, capacity.cleanup_needed, oldestPendingInvites
        );

        if (cleanupResult.success) {
          result.account_updates.cleanup_performed = true;
          result.account_updates.slots_freed = cleanupResult.slots_freed;
          result.account_updates.new_overall_slots = cleanupResult.new_overall_slots;
          this.logger.info(`${this.workerName} [${username}] Cleanup freed ${cleanupResult.slots_freed} slots`);
        } else {
          this.logger.warn(`${this.workerName} [${username}] Cleanup failed: ${cleanupResult.error}`);
        }
      }

      // Step 5: Recalculate after cleanup
      const finalAccount = {
        weekly_invite_slots: targets.length,
        overall_friend_slots: result.account_updates.new_overall_slots
      };
      const finalCapacity = this.calculateAccountCapacity(finalAccount, targets.length);
      const actualBatchSize = Math.min(targets.length, finalCapacity.max_sendable);
      const targetsToProcess = targets.slice(0, actualBatchSize);

      this.logger.info(`${this.workerName} [${username}] Sending ${targetsToProcess.length} invites...`);

      // Step 6: Send invites
      const inviteResults = await this.sendInvitesWithEarlyDetection(
        client, targetsToProcess, options?.delay_between_invites_ms || this.delayBetweenInvites
      );

      // Step 7: Build result
      result.results = inviteResults;
      result.success = true;

      const slotsUsed = inviteResults.successful.length;
      result.account_updates.slots_used = slotsUsed;
      result.account_updates.new_overall_slots = (result.account_updates.new_overall_slots || liveSlotCount) + slotsUsed;

      // Determine cooldown
      if (inviteResults.invitationErrorCount > 0) {
        result.cooldown_info = {
          should_apply: true,
          error_codes: this.extractErrorCodes(inviteResults.failed),
          reason: 'invitation_errors'
        };
      }

      this.stats.invitesSent += inviteResults.successful.length;
      this.stats.invitesFailed += inviteResults.failed.length;

      this.logger.info(`${this.workerName} [${username}] Complete: ${inviteResults.successful.length} sent, ${inviteResults.failed.length} failed (${Date.now() - startTime}ms)`);

    } catch (error) {
      this.logger.error(`${this.workerName} [${username}] Error: ${error.message}`);
      result.success = false;
      result.error = error.message;
      this.stats.errors++;
    }

    // Write result
    result.completed_at = new Date().toISOString();
    await this.writeResult(result);
    this.stats.tasksProcessed++;
    this.stats.lastProcessedAt = new Date().toISOString();
  }

  // ==================== INVITE SENDING ====================

  /**
   * Send invites with early detection of critical errors (15, 25, 84, 17)
   * Ported from steam_worker/src/worker_logic.js:281-379
   */
  async sendInvitesWithEarlyDetection(client, targets, delayMs) {
    const results = {
      successful: [],
      failed: [],
      temporaryFailures: [],
      limitReached: false,
      invitationErrorCount: 0,
      accountBanned: false
    };

    const workerCooldownErrors = [15];
    const accountLimitErrors = [25, 84];
    const accountBannedErrors = [17];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      try {
        const inviteResult = await this.addFriend(client, target.slug);

        if (inviteResult.success) {
          results.successful.push(target.slug);
          this.logger.debug(`${this.workerName} [${i + 1}/${targets.length}] invite sent to ${target.slug}`);
        } else {
          const errorCode = inviteResult.eresult;
          const errorType = this.classifyError(errorCode);

          results.failed.push({
            steamId: target.slug,
            error: inviteResult.error,
            errorCode,
            errorType
          });

          if (accountLimitErrors.includes(errorCode) || inviteResult.limitReached) {
            results.limitReached = true;
            this.logger.warn(`${this.workerName} account limit reached (error ${errorCode})`);
          }

          if (workerCooldownErrors.includes(errorCode)) {
            results.invitationErrorCount++;
            this.logger.warn(`${this.workerName} rate limit error ${errorCode}, stopping batch`);
            for (let j = i + 1; j < targets.length; j++) {
              results.temporaryFailures.push(targets[j].slug);
            }
            break;
          }

          if (accountLimitErrors.includes(errorCode)) {
            this.logger.warn(`${this.workerName} account limit error ${errorCode}, stopping batch`);
            for (let j = i + 1; j < targets.length; j++) {
              results.temporaryFailures.push(targets[j].slug);
            }
            break;
          }

          if (accountBannedErrors.includes(errorCode)) {
            results.accountBanned = true;
            this.logger.warn(`${this.workerName} account BANNED (error ${errorCode}), stopping`);
            for (let j = i + 1; j < targets.length; j++) {
              results.temporaryFailures.push(targets[j].slug);
            }
            break;
          }

          this.logger.debug(`${this.workerName} invite failed for ${target.slug}: ${inviteResult.error} (code: ${errorCode})`);
        }
      } catch (error) {
        this.logger.error(`${this.workerName} exception sending invite to ${target.slug}: ${error.message}`);
        results.failed.push({
          steamId: target.slug,
          error: error.message,
          errorCode: null,
          errorType: 'temporary'
        });
      }

      // Delay between invites (except after last one)
      if (i < targets.length - 1) {
        await this.wait(delayMs);
      }
    }

    return results;
  }

  /**
   * Add friend by Steam ID with timeout.
   * Ported from steam_worker/src/steam_connector.js:158-241
   */
  async addFriend(client, steamId) {
    if (!client || !client.steamID) {
      return { success: false, error: 'Steam client not connected', eresult: null };
    }

    return new Promise((resolve) => {
      let timeoutOccurred = false;

      const timeout = setTimeout(async () => {
        timeoutOccurred = true;
        this.logger.warn(`${this.workerName} timeout sending invite to ${steamId}`);

        // Check if the invite was actually sent despite timeout
        await this.wait(2000);
        const verification = this.verifyInviteStatus(client, steamId);

        if (verification.inviteSent) {
          this.logger.info(`${this.workerName} verified: invite to ${steamId} WAS sent despite timeout`);
          resolve({ success: true, eresult: 1, verifiedAfterTimeout: true });
        } else if (verification.alreadyFriends) {
          resolve({ success: false, error: 'Already friends', eresult: 14, errorType: 'definitive' });
        } else {
          resolve({ success: false, error: 'Friend invite timeout', eresult: 29, errorType: 'temporary' });
        }
      }, 30000);

      client.addFriend(steamId, (err, personaName) => {
        if (timeoutOccurred) return;
        clearTimeout(timeout);

        if (err) {
          resolve(this.mapSteamErrorToResult(err));
        } else {
          resolve({ success: true, message: `Invite sent to ${personaName || steamId}`, eresult: 1 });
        }
      });
    });
  }

  /**
   * Map Steam error to result object.
   * Ported from steam_worker/src/steam_connector.js:246-274
   */
  mapSteamErrorToResult(err) {
    const eresult = err.eresult || 0;
    const message = err.message || 'Unknown error';

    const errorMap = {
      14: { type: 'definitive', message: 'Already friends', limitReached: false },
      15: { type: 'temporary', message: 'Access denied (rate limit)', limitReached: false },
      17: { type: 'definitive', message: 'Account banned', limitReached: false },
      25: { type: 'temporary', message: 'Limit exceeded', limitReached: true },
      29: { type: 'temporary', message: 'Timeout', limitReached: false },
      40: { type: 'definitive', message: 'Blocked by user', limitReached: false },
      84: { type: 'temporary', message: 'Rate limit reached', limitReached: true }
    };

    const errorInfo = errorMap[eresult] || { type: 'temporary', message, limitReached: false };

    return {
      success: false,
      error: errorInfo.message,
      eresult,
      errorType: errorInfo.type,
      limitReached: errorInfo.limitReached
    };
  }

  /**
   * Verify if invite was sent by checking client.myFriends.
   */
  verifyInviteStatus(client, steamId) {
    try {
      const friends = client.myFriends || {};
      const relationship = friends[steamId];

      return {
        inviteSent: relationship === 4 || relationship === 2, // invite_sent or ignored
        alreadyFriends: relationship === 3
      };
    } catch (error) {
      return { inviteSent: false, alreadyFriends: false };
    }
  }

  // ==================== CLEANUP ====================

  /**
   * Cleanup old invites to free slots.
   * Ported from steam_worker/src/steam_invite_cleaner.js
   */
  async cleanupOldInvites(client, slotsToFree, oldestPendingInvites = []) {
    try {
      const friends = client.myFriends || {};

      // Get current pending invites (relationship=4)
      const pendingInvites = [];
      for (const [steamId, relationship] of Object.entries(friends)) {
        if (relationship === 4) {
          pendingInvites.push(steamId);
        }
      }

      const beforeTotal = Object.keys(friends).length;
      this.logger.info(`${this.workerName} [CLEANUP] Current state: ${beforeTotal}/300 total, ${pendingInvites.length} pending sent`);

      // Select invites to cancel with DB prioritization
      const toCancel = this.selectInvitesToCancel(pendingInvites, slotsToFree, oldestPendingInvites);

      if (toCancel.length === 0) {
        return { success: true, slots_freed: 0, new_overall_slots: beforeTotal };
      }

      this.logger.info(`${this.workerName} [CLEANUP] Canceling ${toCancel.length} invites...`);

      let freedCount = 0;
      for (const steamId of toCancel) {
        try {
          client.removeFriend(steamId);
          freedCount++;
          this.logger.debug(`${this.workerName} [CLEANUP] canceled ${steamId}`);
        } catch (error) {
          this.logger.warn(`${this.workerName} [CLEANUP] failed to cancel ${steamId}: ${error.message}`);
        }
        await this.wait(500);
      }

      // Re-count after cleanup
      const afterTotal = Object.keys(client.myFriends || {}).length;

      return {
        success: true,
        slots_freed: freedCount,
        new_overall_slots: afterTotal
      };

    } catch (error) {
      return { success: false, error: error.message, slots_freed: 0 };
    }
  }

  /**
   * Select invites to cancel, prioritizing those from the DB's oldest list.
   * Ported from steam_worker/src/steam_invite_cleaner.js:121-163
   */
  selectInvitesToCancel(pendingInvites, slotsNeeded, oldestPendingInvites = []) {
    if (pendingInvites.length === 0) return [];

    const toCancel = [];
    const pendingSet = new Set(pendingInvites);

    // Priority 1: Cancel from oldestPendingInvites that exist in Steam's pending list
    if (oldestPendingInvites && oldestPendingInvites.length > 0) {
      for (const item of oldestPendingInvites) {
        if (toCancel.length >= slotsNeeded) break;
        const steamId = typeof item === 'string' ? item : item.steam_id;
        if (pendingSet.has(steamId)) {
          toCancel.push(steamId);
          pendingSet.delete(steamId);
        }
      }
    }

    // Priority 2: Take any remaining pending invites
    if (toCancel.length < slotsNeeded) {
      const remaining = Array.from(pendingSet).slice(0, slotsNeeded - toCancel.length);
      toCancel.push(...remaining);
    }

    return toCancel;
  }

  // ==================== CAPACITY CALCULATION ====================

  /**
   * Calculate account capacity based on weekly and overall limits.
   * Ported from steam_worker/src/worker_logic.js:200-274
   */
  calculateAccountCapacity(account, requestedCount) {
    const weeklySlots = account.weekly_invite_slots || 0;
    const overallSlots = account.overall_friend_slots;

    if (weeklySlots <= 0) {
      return { can_send: false, max_sendable: 0, needs_cleanup: false, cleanup_needed: 0, weekly_limited: true };
    }

    if (overallSlots === null || overallSlots === undefined) {
      return { can_send: true, max_sendable: Math.min(requestedCount, weeklySlots), needs_cleanup: false, cleanup_needed: 0 };
    }

    const MAX_OVERALL_SLOTS = 300;
    const maxSendable = Math.min(requestedCount, weeklySlots);
    const targetSlotsBeforeInvites = MAX_OVERALL_SLOTS - maxSendable;

    if (overallSlots <= targetSlotsBeforeInvites) {
      return { can_send: true, max_sendable: maxSendable, needs_cleanup: false, cleanup_needed: 0, weekly_limited: weeklySlots < requestedCount };
    }

    const cleanupNeeded = overallSlots - targetSlotsBeforeInvites;

    return {
      can_send: true,
      max_sendable: maxSendable,
      needs_cleanup: true,
      cleanup_needed: cleanupNeeded,
      weekly_limited: weeklySlots < requestedCount,
      overall_limited: true
    };
  }

  // ==================== HELPERS ====================

  /**
   * Count live slots from client.myFriends
   */
  countLiveSlots(client) {
    const friends = client.myFriends || {};
    return Object.keys(friends).length;
  }

  classifyError(errorCode) {
    const definitiveErrors = [14, 40, 17];
    if (definitiveErrors.includes(errorCode)) return 'definitive';
    return 'temporary';
  }

  extractErrorCodes(failedResults) {
    const codes = failedResults.map(f => f.errorCode).filter(c => c !== null && c !== undefined);
    return [...new Set(codes)];
  }

  async writeResult(result) {
    try {
      await this.httpClient.taskQueueAdd(QUEUE_RESULTS, {
        taskID: result.taskID,
        data: result
      });
      this.logger.debug(`${this.workerName} wrote result ${result.taskID} to ${QUEUE_RESULTS}`);
    } catch (error) {
      this.logger.error(`${this.workerName} failed to write result: ${error.message}`);
    }
  }

  async requeueTask(taskData, originalTaskID, delayMs) {
    this.logger.info(`${this.workerName} re-queuing task ${originalTaskID} with ${delayMs}ms delay`);
    await this.wait(delayMs);
    try {
      await this.httpClient.taskQueueAdd(QUEUE_INVITE, {
        taskID: originalTaskID,
        data: taskData
      });
    } catch (error) {
      this.logger.error(`${this.workerName} failed to re-queue task: ${error.message}`);
    }
  }

  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==================== STATS ====================

  startStatsReporting() {
    this.statsTimer = setInterval(() => {
      if (this.stats.tasksProcessed > 0 || this.stats.cycleCount % 60 === 0) {
        this.logger.info(
          `${this.workerName} stats: cycles=${this.stats.cycleCount}, claimed=${this.stats.tasksClaimed}, ` +
          `processed=${this.stats.tasksProcessed}, invites=${this.stats.invitesSent}, ` +
          `failed=${this.stats.invitesFailed}, errors=${this.stats.errors}`
        );
      }
    }, 60000);
  }

  getWorkerStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      workerName: this.workerName
    };
  }

  getStats() {
    return this.getWorkerStats();
  }
}

module.exports = FriendInviteWorker;
