// automate_trading/workers/managers/decision_execution_manager.js
const createQueueManager = require('../../utils/queue_factory');

/**
 * DecisionExecutionManager - Handles execution of decisions by creating corresponding tasks
 */
class DecisionExecutionManager {
  constructor(config, logger, httpClient, templatePromptManager) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient;
    this.templatePromptManager = templatePromptManager;
    
    // Queue managers cache
    this.queueManagers = {};
    
    // Statistics tracking
    this.stats = {
      tasksCreated: 0,
      errors: 0
    };
  }

  /**
   * Get or create queue manager for a specific queue
   */
  getQueueManager(queueName) {
    if (!this.queueManagers[queueName]) {
      this.queueManagers[queueName] = createQueueManager(queueName, this.config, this.logger, this.httpClient);
    }
    return this.queueManagers[queueName];
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
   * Execute decisions by creating tasks in appropriate queues
   */
  async executeDecisions(task, decisions) {
    const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
    
    for (const decision of decisions) {
      try {
        switch (decision.type) {
          case 'inventory_check':
            const targetSteamID = decision.target === 'our' ? ourSteamId : friendSteamId;
            await this.createInventoryTask(
              task.taskID,
              targetSteamID,
              task.priority || 'normal'
            );
            break;
            
          case 'language_detection':
            await this.createLanguageTask(
              task.taskID,
              task.priority || 'normal',
              'player_summaries'  // Always use player_summaries method
            );
            break;
            
          case 'send_message':
            await this.createMessageTask(
              task.taskID,
              decision.template,
              decision.language || 'English', // Use language from decision object (task context)
              task.priority || 'normal',
              decision.variables || {} // Pass variables if present
            );
            break;

          case 'trade_offer':
            await this.createTradeOfferTask(
              task.taskID,
              decision.action,
              decision.itemsToGive || [],
              decision.itemsToReceive || [],
              task.priority || 'normal',
              decision.action_id || null // Support for AI requested actions
            );
            break;
            
          case 'consult_ai':
            // Pass decision object to createAITask for new prompt system
            await this.createAITask(
              task.taskID,
              task.context,
              task.priority || 'normal',
              decision // Pass the entire decision object
            );
            break;
            
          case 'remove_friend':
            if (decision.immediately) {
              await this.createRemoveFriendTask(
                task.taskID,
                task.priority || 'low',
                0, // delayMs = 0 for immediately
                decision.reason || null // Pass the reason
              );
            } else if (decision.delay) {
              // Create scheduled task for the future
              await this.createRemoveFriendTask(
                task.taskID,
                task.priority || 'low',
                decision.delay,
                decision.reason || null // Pass the reason for delayed as well
              );
            }
            break;
            
          case 'check_base_accounts':
            this.logger.info(`DecisionExecutionManager: Would check base accounts for ${task.taskID}`);
            break;
            
          default:
            this.logger.warn(`DecisionExecutionManager: Unknown decision type: ${decision.type}`);
        }
        
        if (decision.createTask) {
          this.stats.tasksCreated++;
        }
        
      } catch (error) {
        this.logger.error(`DecisionExecutionManager: Failed to execute decision ${decision.type}: ${error.message}`);
        this.stats.errors++;
        throw error;
      }
    }
  }

  /**
   * Create inventory check task
   */
  async createInventoryTask(taskID, targetSteamID, priority) {
    const inventoryQueue = this.getQueueManager('inventory_queue');
    
    const task = {
      taskID: taskID,
      execute: new Date().toISOString(),
      priority: priority,
      targetSteamID: targetSteamID,
      created_at: new Date().toISOString()
    };
    
    const added = await inventoryQueue.addTask(task);
    
    if (added) {
      this.logger.info(`DecisionExecutionManager: Created inventory task for ${targetSteamID}`);
    } else {
      this.logger.debug(`DecisionExecutionManager: Inventory task already exists for ${taskID}`);
    }
    
    return added;
  }

  /**
   * Create language detection task with new method-based structure
   */
  async createLanguageTask(taskID, priority, method = 'player_summaries') {
    const languageQueue = this.getQueueManager('language_queue');
    
    // Validate method parameter
    const validMethods = ['player_summaries', 'text_analysis', 'ai_analysis', 'selenium_scraping'];
    if (!validMethods.includes(method)) {
      this.logger.warn(`DecisionExecutionManager: Invalid language detection method '${method}', defaulting to 'player_summaries'`);
      method = 'player_summaries';
    }
    
    // Determine priority based on method (more advanced methods get higher priority)
    const methodPriorities = {
      'player_summaries': priority, // Use provided priority
      'text_analysis': priority === 'low' ? 'normal' : priority, // Bump up if low
      'ai_analysis': 'high', // AI analysis always high priority
      'selenium_scraping': 'high' // Selenium is resource-intensive, prioritize
    };
    
    const task = {
      taskID: taskID,
      execute: new Date().toISOString(),
      priority: methodPriorities[method],
      method: method,
      attempts: 0,
      partial_data: {
        friends_list: [],
        friends_obtained_at: null,
        method_progress: {}
      },
      created_at: new Date().toISOString()
    };
    
    const added = await languageQueue.addTask(task);
    
    if (added) {
      this.logger.info(`DecisionExecutionManager: Created language detection task (method: ${method}, priority: ${methodPriorities[method]})`);
    } else {
      this.logger.debug(`DecisionExecutionManager: Language task already exists for ${taskID}`);
    }
    
    return added;
  }

  /**
   * Create message task
   */
  async createMessageTask(taskID, template, language, priority, variables = {}) {
    const messageQueue = this.getQueueManager('message_queue');

    // Language is now passed from task context (via decision object) - no need to load from negotiation JSON
    
    // Resolve template to actual messages using TemplatePromptManager
    const templateResult = this.templatePromptManager.getTemplate(template, language);

    // No fallback to English - if template not found, throw error
    // OrchestrationWorker will handle this by creating AI translation task
    if (!templateResult.found) {
      throw new Error(`Template '${template}' not found for language '${language}'`);
    }

    let messages = [...templateResult.messages];

    // Process variables if any
    if (variables && Object.keys(variables).length > 0) {
      messages = messages.map(message => {
        let processedMessage = message;
        for (const [key, value] of Object.entries(variables)) {
          processedMessage = processedMessage.replace(`{${key}}`, value);
        }
        return processedMessage;
      });
    }
    
    const task = {
      taskID: taskID,
      execute: new Date(Date.now()).toISOString(),
      priority: priority,
      messages: messages, // Array of actual messages instead of template name
      language: language,
      originalTemplate: template, // Keep for debugging
      created_at: new Date().toISOString()
    };
    
    const added = await messageQueue.addTask(task);
    
    if (added) {
      this.logger.info(`DecisionExecutionManager: Created message task with ${messages.length} messages (${language})`);
    } else {
      this.logger.debug(`DecisionExecutionManager: Message task already exists for ${taskID}`);
    }
    
    return added;
  }

  /**
   * Create trade offer task
   */
  async createTradeOfferTask(taskID, action, itemsToGive, itemsToReceive, priority, actionId = null) {
    const tradeOfferQueue = this.getQueueManager('trade_offer_queue');
    
    const task = {
      taskID: taskID,
      execute: new Date().toISOString(),
      priority: priority,
      action: action,
      params: {
        items_to_give: itemsToGive,
        items_to_receive: itemsToReceive
      },
      // Include action_id for AI requested actions tracking
      ...(actionId && { action_id: actionId }),
      created_at: new Date().toISOString()
    };
    
    const added = await tradeOfferQueue.addTask(task);
    
    if (added) {
      this.logger.info(`DecisionExecutionManager: Created trade offer task - ${action} with ${itemsToReceive.length} items to receive, ${itemsToGive.length} items to give`);
    } else {
      this.logger.debug(`DecisionExecutionManager: Trade offer task already exists for ${taskID}`);
    }
    
    return added;
  }

  /**
   * Create AI consultation task - Uses TemplatePromptManager for prompt generation
   */
  async createAITask(taskID, context, priority, decision = {}) {
    const aiQueue = this.getQueueManager('ai_queue');
    
    let prompt;
    
    // Use TemplatePromptManager for prompt generation if promptScenario is provided
    if (decision.promptScenario && decision.variables) {
      const promptResult = this.templatePromptManager.buildPrompt(decision.promptScenario, decision.variables);
      
      if (promptResult.success) {
        prompt = promptResult.prompt;
        this.logger.info(`DecisionExecutionManager: Using structured prompt for scenario '${decision.promptScenario}'`);
      } else {
        this.logger.warn(`DecisionExecutionManager: Failed to build structured prompt: ${promptResult.reason}, falling back to legacy prompt`);
        prompt = this.generateAIPrompt(context);
      }
    } else {
      // Fallback to legacy prompt generation
      prompt = this.generateAIPrompt(context);
      this.logger.info(`DecisionExecutionManager: Using legacy prompt generation`);
    }
    
    // Include context for legacy tasks (no promptScenario) or non-translation scenarios
    const shouldIncludeContext = !decision.promptScenario || !decision.promptScenario.startsWith('translate_');

    const task = {
      taskID: taskID,
      execute: new Date(Date.now() + 60000).toISOString(), // Wait 60 seconds
      priority: priority,
      prompt: prompt,
      // Include context for legacy tasks and non-translation scenarios (translations only need prompt + variables)
      ...(shouldIncludeContext && { context: context }),
      // Include prompt metadata for AI worker
      promptScenario: decision.promptScenario || null,
      variables: decision.variables || {},
      created_at: new Date().toISOString()
    };
    
    const added = await aiQueue.addTask(task);
    
    if (added) {
      const promptType = decision.promptScenario ? 'structured' : 'legacy';
      this.logger.info(`DecisionExecutionManager: Created AI consultation task with ${promptType} prompt`);
    } else {
      this.logger.debug(`DecisionExecutionManager: AI task already exists for ${taskID}`);
    }
    
    return added;
  }

  /**
   * Create remove friend task
   */
  async createRemoveFriendTask(taskID, priority, delayMs = 0, reason = null) {
    const removeFriendQueue = this.getQueueManager('remove_friend_queue');
    
    const executeTime = delayMs > 0 ? 
      new Date(Date.now() + delayMs).toISOString() :
      new Date().toISOString();
    
    const task = {
      taskID: taskID,
      execute: executeTime,
      priority: priority,
      reason: reason, // Reason field to distinguish removal types
      created_at: new Date().toISOString()
    };
    
    const added = await removeFriendQueue.addTask(task);
    
    if (added) {
      const delayDesc = delayMs > 0 ? 
        ` (delayed ${Math.round(delayMs / 1000 / 60)} minutes)` : 
        ' (immediate)';
      
      const reasonDesc = reason ? ` - Reason: ${reason}` : '';
      
      this.logger.info(`DecisionExecutionManager: Created remove friend task${delayDesc}${reasonDesc}`);
    } else {
      this.logger.debug(`DecisionExecutionManager: Remove friend task already exists for ${taskID}`);
    }
    
    return added;
  }

  /**
   * Generate AI prompt based on context
   * (Legacy method - kept for backwards compatibility)
   */
  generateAIPrompt(context) {
    const parts = [];
    
    // Add negotiation state
    parts.push(`Current state: ${context.state}`);
    
    // Add objective
    if (context.objective) {
      parts.push(`Objective: ${context.objective}`);
    }
    
    // Add inventory info
    if (context.inventory) {
      const totalValue = context.inventory.reduce((sum, item) => 
        sum + (item.price || 0) * (item.quantity || 1), 0
      );
      parts.push(`Friend has ${context.inventory.length} items worth ${totalValue.toFixed(2)}`);
    }
    
    if (context.our_inventory) {
      const ourValue = context.our_inventory.reduce((sum, item) => 
        sum + (item.price || 0) * (item.quantity || 1), 0
      );
      parts.push(`We have ${context.our_inventory.length} items worth ${ourValue.toFixed(2)}`);
    }
    
    // Add recent messages
    if (context.messages && context.messages.length > 0) {
      const recentMessages = context.messages.slice(-3); // Last 3 messages
      parts.push(`Recent messages: ${recentMessages.length}`);
      
      // Add last message preview
      const lastMessage = recentMessages[recentMessages.length - 1];
      if (lastMessage) {
        parts.push(`Last ${lastMessage.direction} message: "${lastMessage.message.substring(0, 50)}..."`);
      }
    }
    
    // Add trade offer info
    if (context.trade_offers && context.trade_offers.length > 0) {
      const activeOffers = context.trade_offers.filter(offer => {
        const lastState = offer.state_history?.[offer.state_history.length - 1];
        return lastState?.state === 'Active';
      });
      parts.push(`Active trade offers: ${activeOffers.length}`);
    }
    
    // Add special situations
    if (context.inventory_private === true) {
      parts.push('Situation: Friend has private inventory');
    }
    
    if (context.redirected_to && context.redirected_to.length > 0) {
      parts.push(`Redirected to: ${context.redirected_to.length} accounts`);
    }
    
    return parts.join('. ');
  }

  /**
   * Get execution statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      tasksCreated: 0,
      errors: 0
    };
  }
}

module.exports = DecisionExecutionManager;