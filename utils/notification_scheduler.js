// automate_trading/utils/notification_scheduler.js

const HttpClient = require('./http_client');

/**
 * NotificationScheduler - Manages notification schedule with hot-reload
 * Converts server time to Madrid time for schedule checks
 * Determines which admins are currently "at work"
 * Loads schedule from node_api_service (centralized, not instance-specific)
 */
class NotificationScheduler {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // HTTP client for loading schedule from API
    this.httpClient = new HttpClient(config, logger);

    // Schedule data
    this.schedule = null;
    this.timezone = 'Europe/Madrid';
    this.checkIntervalSeconds = 60;
    this.lastLoadedAt = 0;
    this.reloadIntervalMs = 5 * 60 * 1000; // 5 minutes

    // Load schedule on initialization (async, will be available soon)
    this.loadSchedule();

    this.logger.info('[NOTIFICATION_SCHEDULER] Initialized', {
      timezone: this.timezone
    });
  }

  /**
   * Load schedule from node_api_service
   * Called on initialization and periodically for hot-reload
   */
  async loadSchedule() {
    try {
      this.logger.debug('[NOTIFICATION_SCHEDULER] Loading schedule from API');

      // Load from node_api_service
      const response = await this.httpClient.axios.get('/notification-schedule');

      if (!response.data || !response.data.success) {
        this.logger.error('[NOTIFICATION_SCHEDULER] Failed to load schedule from API', {
          error: response.data?.error || 'Unknown error'
        });
        this.schedule = [];
        return;
      }

      const data = response.data.data;

      this.schedule = data.schedule || [];
      this.timezone = data.timezone || 'Europe/Madrid';
      this.checkIntervalSeconds = data.check_interval_seconds || 60;
      this.lastLoadedAt = Date.now();

      this.logger.info('[NOTIFICATION_SCHEDULER] Loaded schedule from API', {
        timezone: this.timezone,
        scheduleItems: this.schedule.length,
        checkInterval: this.checkIntervalSeconds
      });

    } catch (error) {
      this.logger.error('[NOTIFICATION_SCHEDULER] Error loading schedule from API', {
        error: error.message
      });
      this.schedule = [];
    }
  }

  /**
   * Check if schedule needs to be reloaded (hot-reload)
   */
  checkAndReloadSchedule() {
    const now = Date.now();
    if (now - this.lastLoadedAt > this.reloadIntervalMs) {
      this.logger.info('[NOTIFICATION_SCHEDULER] Hot-reloading schedule');
      this.loadSchedule();
    }
  }

  /**
   * Get admins who are currently "at work" based on schedule
   * Converts server time to Madrid time for comparison
   * @returns {Array<string>} - Array of admin usernames currently at work
   */
  getActiveAdmins() {
    // Hot-reload check
    this.checkAndReloadSchedule();

    if (!this.schedule || this.schedule.length === 0) {
      this.logger.debug('[NOTIFICATION_SCHEDULER] No schedule configured, no active admins');
      return [];
    }

    // Get current time in Madrid timezone
    const nowMadrid = new Date(new Date().toLocaleString('en-US', { timeZone: this.timezone }));
    const dayOfWeek = nowMadrid.toLocaleDateString('en-US', { weekday: 'long', timeZone: this.timezone }).toLowerCase();
    const currentTime = this.formatTime(nowMadrid);

    this.logger.debug('[NOTIFICATION_SCHEDULER] Checking active admins', {
      madridTime: nowMadrid.toISOString(),
      dayOfWeek,
      currentTime
    });

    // Find all active schedule periods for current day
    const activeAdminsSet = new Set();

    for (const period of this.schedule) {
      if (period.day.toLowerCase() !== dayOfWeek) {
        continue;
      }

      // Check if current time is within this period
      if (this.isTimeInRange(currentTime, period.start, period.end)) {
        // Add admins from this period
        const admins = period.admins || [];

        // Resolve 'all' to all admins
        if (admins.includes('all')) {
          const allAdminsEnv = process.env.AUTOMATE_TRADING_ADMIN || 'Professor,ready_set_grow,impassive_hawk';
          const allAdminsList = allAdminsEnv.split(',').map(name => name.trim());
          allAdminsList.forEach(admin => activeAdminsSet.add(admin));
        } else {
          admins.forEach(admin => activeAdminsSet.add(admin));
        }

        this.logger.debug('[NOTIFICATION_SCHEDULER] Found active period', {
          day: period.day,
          start: period.start,
          end: period.end,
          admins: admins
        });
      }
    }

    const activeAdmins = Array.from(activeAdminsSet);

    // this.logger.info('[NOTIFICATION_SCHEDULER] Active admins', {
    //   count: activeAdmins.length,
    //   admins: activeAdmins,
    //   madridTime: currentTime,
    //   dayOfWeek
    // });

    return activeAdmins;
  }

  /**
   * Check if current time is within a time range
   * @param {string} current - Current time in HH:MM format
   * @param {string} start - Start time in HH:MM format
   * @param {string} end - End time in HH:MM format
   * @returns {boolean}
   */
  isTimeInRange(current, start, end) {
    const currentMinutes = this.timeToMinutes(current);
    const startMinutes = this.timeToMinutes(start);
    const endMinutes = this.timeToMinutes(end);

    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  /**
   * Convert time string HH:MM to minutes since midnight
   * @param {string} time - Time in HH:MM format
   * @returns {number} - Minutes since midnight
   */
  timeToMinutes(time) {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Format Date object to HH:MM string
   * @param {Date} date - Date object
   * @returns {string} - Time in HH:MM format
   */
  formatTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  /**
   * Get current Madrid time as Date object
   * @returns {Date}
   */
  getMadridTime() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: this.timezone }));
  }

  /**
   * Get schedule info (for debugging)
   * @returns {Object}
   */
  getScheduleInfo() {
    return {
      timezone: this.timezone,
      scheduleItems: this.schedule?.length || 0,
      lastLoadedAt: new Date(this.lastLoadedAt).toISOString(),
      madridTime: this.getMadridTime().toISOString(),
      activeAdmins: this.getActiveAdmins()
    };
  }
}

module.exports = NotificationScheduler;
