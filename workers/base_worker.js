const winston = require('winston');

class BaseWorker {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.isRunning = false;
    this.intervalId = null;
    
    // Set up logger
    const transports = [new winston.transports.Console()];
    if (!config.logging.consoleOnly) {
      transports.push(new winston.transports.File({ filename: config.logging.file }));
    }
    this.logger = winston.createLogger({
      level: config.logging.level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${this.name}] ${level}: ${message}`;
        })
      ),
      transports
    });
  }

  async start() {
    if (this.isRunning) {
      this.logger.warn('Worker is already running');
      return;
    }

    this.isRunning = true;
    
    try {
      await this.initialize();
      this.scheduleWork();
    } catch (error) {
      this.logger.error(`Failed to start worker: ${error.message}`);
      this.isRunning = false;
      throw error;
    }
  }

  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.cleanup();
  }

  scheduleWork() {
    const interval = this.getInterval();
    
    this.intervalId = setInterval(async () => {
      if (!this.isRunning) {
        return;
      }

      try {
        await this.doWork();
      } catch (error) {
        this.logger.error(`Work cycle failed: ${error.message}`);
      }
    }, interval);

    // Run first cycle immediately
    this.doWork().catch(error => {
      this.logger.error(`Initial work cycle failed: ${error.message}`);
    });
  }

  // Abstract methods to be implemented by subclasses
  async initialize() {
    // Override in subclass
  }

  async doWork() {
    throw new Error('doWork() must be implemented by subclass');
  }

  getInterval() {
    throw new Error('getInterval() must be implemented by subclass');
  }

  cleanup() {
    // Override in subclass if needed
  }
}

module.exports = BaseWorker;