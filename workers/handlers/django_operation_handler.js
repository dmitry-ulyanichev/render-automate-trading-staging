// automate_trading/workers/handlers/django_operation_handler.js

/**
 * Handles Django API operations with retry logic
 * 
 * Responsible for:
 * - Queuing failed Django operations for retry
 * - Retrying operations with exponential backoff
 * - Managing operation lifecycle and limits
 * - Providing statistics and monitoring data
 * - Supporting various Django operation types
 */
class DjangoOperationHandler {
  constructor(djangoClient, logger) {
    this.djangoClient = djangoClient;
    this.logger = logger;
    
    // Failed operations queue
    this.failedOperations = new Map(); // operationId -> operationData
    
    // Operation configuration
    this.defaultMaxAttempts = 5;
    this.defaultRetryDelay = 5 * 60 * 1000; // 5 minutes
    this.maxRetryDelay = 60 * 60 * 1000; // 1 hour max
    this.backoffMultiplier = 2;
    
    this.logger.info('DjangoOperationHandler initialized');
  }

  /**
   * Queue a failed Django operation for retry
   * 
   * @param {string} operationType - Type of operation (updateFriendRelationship, updateLinkStatus, etc.)
   * @param {Object} operationData - Data needed to retry the operation
   * @param {Object} options - Optional configuration (maxAttempts, retryDelay)
   */
  queueFailedOperation(operationType, operationData, options = {}) {
    const operationId = this.generateOperationId(operationType, operationData);
    
    const operation = {
      id: operationId,
      type: operationType,
      data: operationData,
      attempts: 0,
      maxAttempts: options.maxAttempts || this.defaultMaxAttempts,
      nextRetry: Date.now() + (options.retryDelay || this.defaultRetryDelay),
      backoffMultiplier: this.backoffMultiplier,
      createdAt: Date.now(),
      lastAttemptAt: null,
      lastError: null
    };
    
    this.failedOperations.set(operationId, operation);
    
    this.logger.info(`Queued failed Django operation: ${operationType} (queue size: ${this.failedOperations.size})`);
    
    return operationId;
  }

  /**
   * Generate unique operation ID
   */
  generateOperationId(operationType, operationData) {
    const timestamp = Date.now();
    const randomPart = Math.random().toString(36).substr(2, 9);
    const accountId = operationData.accountId || 'unknown';
    const friendSteamId = operationData.friendSteamId || 'unknown';
    
    return `${operationType}_${accountId}_${friendSteamId}_${timestamp}_${randomPart}`;
  }

  /**
   * Retry all failed operations that are ready
   */
  async retryFailedOperations() {
    if (this.failedOperations.size === 0) return;
    
    const now = Date.now();
    const readyOperations = [];
    
    // Find operations ready for retry
    for (const [operationId, operation] of this.failedOperations) {
      if (now >= operation.nextRetry) {
        readyOperations.push([operationId, operation]);
      }
    }
    
    if (readyOperations.length === 0) return;
    
    this.logger.info(`Retrying ${readyOperations.length} failed Django operations`);
    
    for (const [operationId, operation] of readyOperations) {
      await this.retryOperation(operationId, operation);
      
      // Small delay between retries to avoid overwhelming Django
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Retry individual operation
   */
  async retryOperation(operationId, operation) {
    operation.attempts++;
    operation.lastAttemptAt = Date.now();
    
    try {
      let success = false;
      
      switch (operation.type) {
        case 'updateFriendRelationship':
          success = await this.retryUpdateFriendRelationship(operation);
          break;
          
        case 'updateLinkStatus':
          success = await this.retryUpdateLinkStatus(operation);
          break;
          
        case 'updateFriendsList':
          success = await this.retryUpdateFriendsList(operation);
          break;
          
        case 'updateAuthToken':
          success = await this.retryUpdateAuthToken(operation);
          break;
          
        default:
          this.logger.warn(`Unknown operation type: ${operation.type}`);
          this.failedOperations.delete(operationId);
          return;
      }
      
      if (success) {
        this.logger.info(`✓ Successfully retried ${operation.type} after ${operation.attempts} attempts`);
        this.failedOperations.delete(operationId);
      }
      
    } catch (error) {
      operation.lastError = error.message;
      
      if (operation.attempts >= operation.maxAttempts) {
        this.logger.error(`✗ Giving up on ${operation.type} after ${operation.attempts} attempts: ${error.message}`);
        this.failedOperations.delete(operationId);
      } else {
        // Calculate next retry with exponential backoff
        const backoffDelay = Math.min(
          this.defaultRetryDelay * Math.pow(operation.backoffMultiplier, operation.attempts - 1),
          this.maxRetryDelay
        );
        operation.nextRetry = Date.now() + backoffDelay;
        
        const nextRetryMin = Math.round(backoffDelay / 60000);
        this.logger.warn(`✗ ${operation.type} failed (attempt ${operation.attempts}/${operation.maxAttempts}), retrying in ${nextRetryMin}min: ${error.message}`);
      }
    }
  }

  /**
   * Retry updateFriendRelationship operation
   */
  async retryUpdateFriendRelationship(operation) {
    const { accountId, friendSteamId, relationship } = operation.data;
    
    try {
      await this.djangoClient.updateFriendRelationship(accountId, friendSteamId, relationship);
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retry updateLinkStatus operation
   */
  async retryUpdateLinkStatus(operation) {
    const { friendSteamId, accountId, status } = operation.data;
    
    try {
      await this.djangoClient.updateLinkStatus(friendSteamId, accountId, status);
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retry updateFriendsList operation
   */
  async retryUpdateFriendsList(operation) {
    const { accountId, friends } = operation.data;
    
    try {
      await this.djangoClient.updateFriendsList(accountId, friends);
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retry updateAuthToken operation
   */
  async retryUpdateAuthToken(operation) {
    const { accountId, tokenValue, isValid } = operation.data;
    
    try {
      await this.djangoClient.updateAuthToken(accountId, tokenValue, isValid);
      return true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get operation statistics for monitoring
   */
  getOperationStats() {
    const now = Date.now();
    let readyCount = 0;
    let waitingCount = 0;
    const operationTypes = {};
    
    for (const operation of this.failedOperations.values()) {
      if (now >= operation.nextRetry) {
        readyCount++;
      } else {
        waitingCount++;
      }
      
      operationTypes[operation.type] = (operationTypes[operation.type] || 0) + 1;
    }
    
    return {
      queueSize: this.failedOperations.size,
      readyForRetry: readyCount,
      waitingForRetry: waitingCount,
      operationTypes: operationTypes,
      timestamp: now
    };
  }

  /**
   * Get detailed operation information for debugging
   */
  getOperationDetails() {
    const operations = [];
    
    for (const operation of this.failedOperations.values()) {
      const nextRetryIn = Math.max(0, Math.ceil((operation.nextRetry - Date.now()) / 1000));
      const ageSeconds = Math.ceil((Date.now() - operation.createdAt) / 1000);
      
      operations.push({
        id: operation.id,
        type: operation.type,
        attempts: operation.attempts,
        maxAttempts: operation.maxAttempts,
        nextRetryIn: nextRetryIn,
        ageSeconds: ageSeconds,
        lastError: operation.lastError,
        data: {
          accountId: operation.data.accountId,
          friendSteamId: operation.data.friendSteamId,
          // Don't expose sensitive data like tokens
        }
      });
    }
    
    // Sort by next retry time (soonest first)
    return operations.sort((a, b) => a.nextRetryIn - b.nextRetryIn);
  }

  /**
   * Remove operations older than specified age (cleanup)
   */
  cleanupOldOperations(maxAgeMs = 24 * 60 * 60 * 1000) { // 24 hours default
    const now = Date.now();
    let removedCount = 0;
    
    for (const [operationId, operation] of this.failedOperations) {
      const age = now - operation.createdAt;
      
      if (age > maxAgeMs) {
        this.failedOperations.delete(operationId);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      this.logger.info(`Cleaned up ${removedCount} old operations from queue`);
    }
    
    return removedCount;
  }

  /**
   * Cancel specific operation by ID
   */
  cancelOperation(operationId) {
    const operation = this.failedOperations.get(operationId);
    
    if (operation) {
      this.failedOperations.delete(operationId);
      this.logger.info(`Cancelled operation: ${operation.type} (${operationId})`);
      return true;
    }
    
    return false;
  }

  /**
   * Cancel all operations of a specific type
   */
  cancelOperationsByType(operationType) {
    let cancelledCount = 0;
    
    for (const [operationId, operation] of this.failedOperations) {
      if (operation.type === operationType) {
        this.failedOperations.delete(operationId);
        cancelledCount++;
      }
    }
    
    if (cancelledCount > 0) {
      this.logger.info(`Cancelled ${cancelledCount} operations of type: ${operationType}`);
    }
    
    return cancelledCount;
  }

  /**
   * Cancel all operations for a specific account
   */
  cancelOperationsByAccount(accountId) {
    let cancelledCount = 0;
    
    for (const [operationId, operation] of this.failedOperations) {
      if (operation.data.accountId === accountId) {
        this.failedOperations.delete(operationId);
        cancelledCount++;
      }
    }
    
    if (cancelledCount > 0) {
      this.logger.info(`Cancelled ${cancelledCount} operations for account: ${accountId}`);
    }
    
    return cancelledCount;
  }

  /**
   * Force retry of specific operation (ignore timing)
   */
  async forceRetryOperation(operationId) {
    const operation = this.failedOperations.get(operationId);
    
    if (!operation) {
      throw new Error(`Operation not found: ${operationId}`);
    }
    
    this.logger.info(`Force retrying operation: ${operation.type} (${operationId})`);
    
    // Temporarily set nextRetry to now
    const originalNextRetry = operation.nextRetry;
    operation.nextRetry = Date.now();
    
    try {
      await this.retryOperation(operationId, operation);
    } catch (error) {
      // Restore original nextRetry if operation still exists
      if (this.failedOperations.has(operationId)) {
        operation.nextRetry = originalNextRetry;
      }
      throw error;
    }
  }

  /**
   * Get queue health status
   */
  getQueueHealth() {
    const stats = this.getOperationStats();
    const now = Date.now();
    
    // Calculate average age of operations
    let totalAge = 0;
    let oldestAge = 0;
    
    for (const operation of this.failedOperations.values()) {
      const age = now - operation.createdAt;
      totalAge += age;
      oldestAge = Math.max(oldestAge, age);
    }
    
    const averageAgeMinutes = stats.queueSize > 0 ? Math.round((totalAge / stats.queueSize) / 60000) : 0;
    const oldestAgeMinutes = Math.round(oldestAge / 60000);
    
    return {
      healthy: stats.queueSize < 100 && oldestAgeMinutes < 60, // Less than 100 ops and oldest < 1 hour
      queueSize: stats.queueSize,
      averageAgeMinutes: averageAgeMinutes,
      oldestAgeMinutes: oldestAgeMinutes,
      readyForRetry: stats.readyForRetry,
      timestamp: now
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    this.logger.info('DjangoOperationHandler cleanup started');
    
    // Log final queue status
    const stats = this.getOperationStats();
    if (stats.queueSize > 0) {
      this.logger.warn(`${stats.queueSize} operations remaining in queue during cleanup`);
    }
    
    // Clear the queue
    this.failedOperations.clear();
    
    this.logger.info('DjangoOperationHandler cleanup completed');
  }
}

module.exports = DjangoOperationHandler;