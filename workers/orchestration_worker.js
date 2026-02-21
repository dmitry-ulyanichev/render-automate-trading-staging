// automate_trading/workers/orchestration_worker.js

const createQueueManager = require('../utils/queue_factory');
const HttpClient = require('../utils/http_client');
const LanguageUtils = require('../utils/language_utils');
const TemplatePromptManager = require('../utils/template_prompt_manager');
const DecisionExecutionManager = require('./managers/decision_execution_manager');
const RedirectManager = require('./managers/redirect_manager');
const InventoryAssessmentManager = require('./managers/inventory_assessment_manager.js');
const NegotiationContextUpdater = require('../utils/negotiation_context_updater');

/**
 * OrchestrationWorker - Central brain of the orchestration system
 * Implements complete decision tree from flowchart
 */
class OrchestrationWorker {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    
    // Worker configuration
    this.workerName = 'OrchestrationWorker';
    this.isRunning = false;
    this.isPaused = false;
    this.processInterval = config.orchestration?.processInterval || 5000; // 5 seconds default
    this.batchSize = config.orchestration?.batchSize || 3; // Process up to 3 tasks per cycle
    
    // Initialize HTTP client
    this.httpClient = new HttpClient(config, logger);

    // Templates cache
    this.templates = null;
    this.templatesLoadedAt = null;

    // Prompts cache
    this.prompts = null;
    this.promptsLoadedAt = null;

    // Initialize queue manager
    this.queueManager = createQueueManager('orchestration_queue', config, logger, this.httpClient);

    // Initialize TemplatePromptManager
    this.templatePromptManager = new TemplatePromptManager(config, logger, this.httpClient);

    // Initialize DecisionExecutionManager
    this.decisionExecutionManager = new DecisionExecutionManager(
      config, 
      logger, 
      this.httpClient, 
      this.templatePromptManager
    );

    // Initialize new managers
    this.negotiationContextUpdater = new NegotiationContextUpdater(
      config, logger, this.httpClient
    );
    
    this.redirectManager = new RedirectManager(
      config, 
      logger, 
      this.httpClient, 
      this.negotiationContextUpdater,
      this.queueManager
    );

    // New manager
    this.inventoryAssessmentManager = new InventoryAssessmentManager(
      config, logger, this.httpClient
    );
    
    // Queue managers for other queues (initialized on demand)
    this.otherQueues = {};
    
    // Statistics tracking
    this.stats = {
      tasksProcessed: 0,
      tasksSkipped: 0,
      tasksCreated: 0,
      errors: 0,
      lastProcessedAt: null,
      startedAt: null,
      cycleCount: 0
    };
    
    // Timers
    this.processTimer = null;
    this.statsTimer = null;
    
    // this.logger.info(`${this.workerName} initialized - Process interval: ${this.processInterval}ms, Batch size: ${this.batchSize}`);
  }

  getTemplate(scenario, language) {
    return this.templatePromptManager.getTemplate(scenario, language);
  }

  buildPrompt(scenario, variables) {
    return this.templatePromptManager.buildPrompt(scenario, variables);
  }

  getTranslationScenario(templateName) {
    return this.templatePromptManager.getTranslationScenario(templateName);
  }

  /**
   * Unified method to determine if AI should be used instead of templates
   * @param {Object} ctx - Negotiation context
   * @param {string} scenario - Template scenario being considered
   * @returns {Object} Decision object with shouldUse flag and reason
   */
  shouldUseAI(ctx, scenario = null) {
    // PRIORITY 1: Always use AI if trade_offers is not empty
    if (ctx.trade_offers && ctx.trade_offers.length > 0) {
      return {
        shouldUse: true,
        reason: 'has_trade_offers',
        details: `Found ${ctx.trade_offers.length} trade offer(s)`
      };
    }

    // PRIORITY 2: Always use AI if there are incoming messages to analyze
    if (this.hasIncomingMessages(ctx)) {
      return {
        shouldUse: true,
        reason: 'has_incoming_messages',
        details: 'Need to analyze and respond to incoming messages'
      };
    }

    // PRIORITY 3: Use AI if state is 'replying' (should have been caught above, but safety check)
    if (ctx.state === 'replying') {
      return {
        shouldUse: true,
        reason: 'state_replying',
        details: 'State is replying but no incoming messages found - investigate'
      };
    }

    // PRIORITY 4: Use AI if no template available for scenario/language combination
    if (scenario && LanguageUtils.isLanguageKnown(ctx.language)) {
      const currentLang = LanguageUtils.getCurrentLanguage(ctx.language);
      const templateResult = this.getTemplate(scenario, currentLang);
      if (!templateResult.found) {
        return {
          shouldUse: true,
          reason: 'template_not_available',
          details: `No template for scenario '${scenario}' in language '${currentLang}' (${templateResult.reason})`,
          fallbackAvailable: !!templateResult.fallbackMessages,
          englishFallback: templateResult.fallbackMessages
        };
      }
    }

    // PRIORITY 5: Use templates for rule-based scenarios
    return {
      shouldUse: false,
      reason: 'use_templates',
      details: scenario ? `Template available for scenario '${scenario}' in language '${LanguageUtils.getCurrentLanguage(ctx.language) || 'English'}'` : 'No special conditions requiring AI'
    };
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
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn(`${this.workerName} is already running`);
      return;
    }

    // this.logger.info(`Starting ${this.workerName}...`);

    // Initialize templates and prompts through the manager
    await this.templatePromptManager.initializeTemplatesPrompts();
    
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
  async stop() {
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
    
    // Log final stats
    this.logStatistics();
    
    this.logger.info(`${this.workerName} stopped`);
  }

  /**
   * Pause processing temporarily
   */
  pause() {
    this.isPaused = true;
    this.logger.info(`${this.workerName} paused`);
  }

  /**
   * Resume processing
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
        await this.processTasks();
      } catch (error) {
        this.logger.error(`${this.workerName} process cycle error: ${error.message}`);
        this.stats.errors++;
      }
    }, this.processInterval);
    
    // Process immediately on start
    if (!this.isPaused) {
      this.processTasks().catch(error => {
        this.logger.error(`${this.workerName} initial process error: ${error.message}`);
      });
    }
  }

  /**
   * Get orchestration tasks ready for execution, excluding those with pending_tasks
   * Applies smart filtering: excludes blocked tasks, then prioritizes by priority and age
   * @param {number} batchSize - Maximum number of tasks to return
   * @returns {Promise<Array>} Array of executable orchestration tasks
   */
  async getExecutableOrchestrationTasks(batchSize) {
    try {
      // Get ALL tasks from queue (no filtering by QueueManager)
      const allTasks = await this.queueManager.getTasks();
      const now = Date.now();
      
      // Step 1: Filter tasks ready for execution (same logic as QueueManager.getNextTasks)
      const readyTasks = allTasks.filter(task => {
        if (task.execute) {
          const executeTime = new Date(task.execute).getTime();
          return executeTime <= now;
        }
        return true; // No execute time means ready immediately
      });
      
      // Step 2: Filter out tasks with non-empty pending_tasks (our main improvement)
      const executableTasks = readyTasks.filter(task => {
        return !task.pending_tasks || task.pending_tasks.length === 0;
      });
      
      // Step 3: Sort by priority and updated_at (following human's logic)
      executableTasks.sort((a, b) => {
        // Priority order: high > normal > low
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        const aPriority = priorityOrder[a.priority] ?? 1;
        const bPriority = priorityOrder[b.priority] ?? 1;
        
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        
        // If same priority, sort by updated_at (oldest first)
        const aTime = new Date(a.updated_at || a.created_at).getTime();
        const bTime = new Date(b.updated_at || b.created_at).getTime();
        return aTime - bTime;
      });
      
      // Step 4: Limit to batch size
      const selectedTasks = executableTasks.slice(0, batchSize);
      
      this.logger.debug(`${this.workerName}: Found ${allTasks.length} total, ${readyTasks.length} ready, ${executableTasks.length} executable, selected ${selectedTasks.length}`);
      
      return selectedTasks;
      
    } catch (error) {
      this.logger.error(`${this.workerName}: Error getting executable tasks: ${error.message}`);
      return [];
    }
  }

  /**
   * REPLACE the existing processTasks() method with this updated version
   */
  async processTasks() {
    this.stats.cycleCount++;
    
    try {
      // Use our new intelligent task selection instead of QueueManager.getNextTasks()
      const tasks = await this.getExecutableOrchestrationTasks(this.batchSize);
      
      if (tasks.length === 0) {
        // Check if there are any tasks at all vs. just blocked tasks
        const allTasks = await this.queueManager.getTasks();
        const blockedCount = allTasks.filter(task => 
          task.pending_tasks && task.pending_tasks.length > 0
        ).length;
        
        if (blockedCount > 0) {
          this.logger.debug(`${this.workerName} cycle #${this.stats.cycleCount}: ${blockedCount} tasks waiting for pending_tasks, 0 executable`);
        } else {
          this.logger.debug(`${this.workerName} cycle #${this.stats.cycleCount}: No tasks ready for processing`);
        }
        return;
      }
      
      this.logger.info(`${this.workerName} cycle #${this.stats.cycleCount}: Processing ${tasks.length} task(s)`);
      
      // Process each selected task
      for (const task of tasks) {
        await this.processTask(task);
      }
      
    } catch (error) {
      this.logger.error(`${this.workerName} error getting tasks: ${error.message}`);
      this.stats.errors++;
    }
  }

  /**
   * Process a single orchestration task
   */
  async processTask(task) {
    const startTime = Date.now();
    
    try {
      this.logger.info(`${this.workerName}: Processing task ${task.taskID}`);
      
      // Check if task has pending sub-tasks
      if (task.pending_tasks && task.pending_tasks.length > 0) {
        this.logger.info(`${this.workerName}: Task ${task.taskID} waiting for pending tasks: [${task.pending_tasks.join(', ')}]`);
        this.stats.tasksSkipped++;
        return; // Don't remove from queue, will retry next cycle
      }
      
      // Validate task structure
      if (!task.context) {
        throw new Error(`Task ${task.taskID} missing context`);
      }
      
      // Ensure task has proper timestamps
      if (!task.execute) {
        task.execute = new Date().toISOString();
      }
      
      // Log context for debugging
      this.logTaskContext(task);
      
      // Run the decision tree
      const decisions = await this.runDecisionTree(task);
      
      if (decisions.length > 0) {
        // Execute decisions
        await this.executeDecisions(task, decisions);
        
        // Update pending_tasks if we created sub-tasks
        const pendingTypes = decisions
          .filter(d => d.createTask && d.pendingType)
          .map(d => d.pendingType);
        
        if (pendingTypes.length > 0) {
          await this.updatePendingTasks(task.taskID, pendingTypes);
        }
        
        // Check if we should remove the task
        const shouldRemove = decisions.some(d => d.removeOrchestrationTask);
        if (shouldRemove) {
          await this.queueManager.removeTask(task.taskID);
          this.logger.info(`${this.workerName}: Removed completed task ${task.taskID}`);
        }
      } else {
        this.logger.info(`${this.workerName}: No actions needed for task ${task.taskID}, removing from queue`);
        await this.queueManager.removeTask(task.taskID);
      }
      
      // Update statistics
      this.stats.tasksProcessed++;
      this.stats.lastProcessedAt = new Date().toISOString();
      
      const processingTime = Date.now() - startTime;
      this.logger.info(`${this.workerName}: Task ${task.taskID} processed in ${processingTime}ms`);
      
    } catch (error) {
      this.logger.error(`${this.workerName}: Error processing task ${task.taskID}: ${error.message}`);
      this.stats.errors++;
      
      // Mark task for review instead of removing
      await this.markTaskForReview(task, error.message);
    }
  }

  /**
   * Log task context for debugging
   */
  logTaskContext(task) {
    const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
    const ctx = task.context;
    
    this.logger.debug(`${this.workerName}: Context for ${ourSteamId} -> ${friendSteamId}:`);
    this.logger.debug(`  State: ${ctx.state}`);
    this.logger.debug(`  Objective: ${ctx.objective || 'not set'}`);
    this.logger.debug(`  Source: ${ctx.source || 'not set'}`);
    this.logger.debug(`  Language: ${LanguageUtils.getCurrentLanguage(ctx.language) || 'not detected'}`);
    this.logger.debug(`  Friend's inventory private: ${ctx.inventory_private}`);
    this.logger.debug(`  Friend's inventory items: ${ctx.inventory ? ctx.inventory.length : 'not checked'}`);
    this.logger.debug(`  Our inventory items: ${ctx.our_inventory ? ctx.our_inventory.length : 'not checked'}`);
    this.logger.debug(`  Messages: ${ctx.messages ? ctx.messages.length : 0}`);
    this.logger.debug(`  Trade offers: ${ctx.trade_offers ? ctx.trade_offers.length : 0}`);
    
    if (ctx.referred_from_messages && ctx.referred_from_messages.length > 0) {
      this.logger.debug(`  Referred from messages: ${ctx.referred_from_messages.length}`);
    }
    
    if (ctx.redirected_to && ctx.redirected_to.length > 0) {
      this.logger.debug(`  Redirected to: ${ctx.redirected_to.join(', ')}`);
    }
  }

  /**
   * Run the complete decision tree based on task reason
   * REFACTORED: Routes based on task.reason field
   */
  async runDecisionTree(task) {
    const reason = task.reason;
    
    // Validate reason exists
    if (!reason) {
      this.logger.error(`${this.workerName}: Task ${task.taskID} missing reason field`);
      throw new Error('Task missing reason field');
    }
    
    this.logger.info(`${this.workerName}: Processing task with reason: ${reason}`);
    
    // Route to appropriate handler based on reason
    switch(reason) {
      case 'new_friend':
        return await this.handleNewFriend(task);
        
      case 'reply_needed':
        return await this.handleReplyNeeded(task);
        
      case 'change_in_trade_offers':
        return await this.handleTradeOfferChange(task);
        
      case 'follow_up':
        return await this.handleFollowUp(task);
        
      default:
        this.logger.error(`${this.workerName}: Unknown reason '${reason}' for task ${task.taskID}`);
        throw new Error(`Unknown task reason: ${reason}`);
    }
  }

  /**
   * Handle new_friend - Full decision tree for initiating with new friends
   */
  async handleNewFriend(task) {
    const ctx = task.context;
    const decisions = [];
    
    // STEP 1: Check referred_from_messages
    if (!ctx.referrer_checked) {
      const redirectsResult = await this.redirectManager.checkRedirects(task);
      if (redirectsResult.found) {
        this.logger.info(`${this.workerName}: Found redirect entry, processed ${redirectsResult.messageCount} messages`);
      } else {
        this.logger.debug(`${this.workerName}: No referrer found, marked as checked`);
      }
    }
    
    // STEP 2: Check inventory_private status
    if (ctx.inventory_private === null) {
      decisions.push({
        type: 'inventory_check',
        target: 'friend',
        createTask: true,
        pendingType: 'check_inventory_friend',
        reason: 'Need to check if inventory is private'
      });
      return decisions;
    }
    
    // STEP 3: Handle private inventory
    if (ctx.inventory_private === true) {
      // Use common message flow to handle language detection and messaging
      return this.handleCommonMessageFlow(task, 'ask_open_inventory');
    }
    
    // STEP 4: Inventory not private - assess and set objective if needed
    if (!ctx.objective) {
      const assessment = this.inventoryAssessmentManager.assessInventory(ctx);
      ctx.objective = assessment.objective;
      
      await this.queueManager.updateTask(task.taskID, {
        context: ctx
      });
      
      const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
      await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
        objective: assessment.objective
      });
      
      this.logger.info(`${this.workerName}: Set objective to '${ctx.objective}' - ${assessment.reason}`);
    }
    
    // STEP 5: Handle based on objective
    if (ctx.objective === 'remove') {
      return this.handleRemoveObjective(task);
    }
    
    // For other objectives, perform specific tasks first
    const objectiveResult = await this.handleObjectiveSpecificTasks(task);
    if (objectiveResult) {
      return objectiveResult; // Task created, exit
    }
    
    // STEP 6: Common message flow
    return this.handleCommonMessageFlow(task, this.getTemplateNameForObjective(ctx));
  }

  /**
   * Handle reply_needed reason - friend has replied
   * UPDATED: Gather context (language, inventory, objective) before delegating to AI
   */
  async handleReplyNeeded(task) {
    this.logger.info(`${this.workerName}: Friend replied - checking context before AI`);

    // Ensure we have context before delegating to AI
    const contextDecisions = await this.ensureContextGathered(task);
    if (contextDecisions) {
      return contextDecisions;
    }

    // Context is complete - delegate to AI
    this.logger.info(`${this.workerName}: Context gathered - delegating to AI for reply analysis`);

    const decisions = [];
    decisions.push({
      type: 'consult_ai',
      createTask: true,
      pendingType: 'consult_ai',
      reason: 'Friend replied - needs AI analysis'
    });

    return decisions;
  }

  /**
   * Handle change_in_trade_offers reason - trade offers have changed
   * UPDATED: Gather context before delegating to AI
   */
  async handleTradeOfferChange(task) {
    const ctx = task.context;
    const decisions = [];
    const params = task.params || {};

    this.logger.info(`${this.workerName}: Trade offer change detected - Scenario: ${params.scenario}, Decision type: ${params.decisionType}`);

    // Handle deterministic scenarios first (no context gathering needed)
    if (params.decisionType === 'deterministic_remove_friend') {
      // Scenario 4: Offer expired, or Scenario 5: Escrow completed
      this.logger.info(`${this.workerName}: ${params.description} - removing friend`);

      decisions.push({
        type: 'remove_friend',
        immediately: true,
        createTask: true,
        pendingType: 'remove_friend',
        reason: params.description,
        tradeOfferId: params.tradeOfferId
      });

      return decisions;
    }

    // For all AI-delegated scenarios, ensure context is gathered first
    this.logger.info(`${this.workerName}: Trade offer scenario requires AI - checking context first`);

    const contextDecisions = await this.ensureContextGathered(task);
    if (contextDecisions) {
      return contextDecisions;
    }

    // Context is complete - now check if inventory needs refresh
    const taskCreatedAt = new Date(task.created_at || task.execute).getTime();
    const inventoryUpdatedAt = ctx.inventory_updated_at ?
      new Date(ctx.inventory_updated_at).getTime() : 0;

    if (inventoryUpdatedAt < taskCreatedAt) {
      // Inventory is outdated - update it first
      this.logger.info(`${this.workerName}: Inventory outdated, updating before AI analysis of ${params.scenario}`);

      decisions.push({
        type: 'inventory_check',
        target: 'friend',
        createTask: true,
        pendingType: 'check_inventory_friend',
        reason: `Update inventory before analyzing ${params.scenario}`
      });

      return decisions;
    }

    // Context is complete and inventory is current - delegate to AI
    if (params.decisionType === 'deterministic_recreate') {
      // Scenario 3 (deterministic part): Invalid items, no recent messages - recreate offer
      this.logger.info(`${this.workerName}: ${params.description} - recreating offer (TODO: implement)`);

      // TODO: Implement logic to recreate trade offer similar to the invalidated one
      // For now, delegate to AI as fallback
      decisions.push({
        type: 'consult_ai',
        createTask: true,
        pendingType: 'consult_ai',
        reason: `${params.description} - TODO: deterministic recreate not yet implemented`
      });
    } else {
      // AI-delegated scenarios (1, 2, 3 with messages, 6)
      this.logger.info(`${this.workerName}: ${params.description} - delegating to AI`);

      decisions.push({
        type: 'consult_ai',
        createTask: true,
        pendingType: 'consult_ai',
        reason: params.description,
        scenario: params.scenario,
        tradeOfferId: params.tradeOfferId,
        oldState: params.oldState,
        newState: params.newState
      });
    }

    return decisions;
  }

  /**
   * Handle follow_up reason - time to follow up with friend
   * UPDATED: Gather context first (inventory, objective) before template selection
   */
  async handleFollowUp(task) {
    const ctx = task.context;
    const decisions = [];

    const currentFollowUpCount = ctx.followUpCount || 0;

    // Check if there are incoming messages
    const hasIncomingMessages = ctx.messages && ctx.messages.some(msg => msg.direction === 'incoming');

    if (hasIncomingMessages) {
      // Friend has sent messages - gather context first, then use AI
      this.logger.info(`${this.workerName} Follow-up with incoming messages (count: ${currentFollowUpCount}) - checking context before AI`);

      // Ensure we have context before delegating to AI
      const contextDecisions = await this.ensureContextGathered(task);
      if (contextDecisions) {
        return contextDecisions;
      }

      // Context is complete - delegate to AI
      this.logger.info(`${this.workerName} Context gathered - delegating to AI for follow-up with incoming messages`);

      decisions.push({
        type: 'consult_ai',
        createTask: true,
        pendingType: 'consult_ai',
        reason: 'Follow-up with incoming messages - needs AI analysis'
      });

      return decisions;
    }

    // CONTEXT GATHERING: Ensure we have enough information before selecting template

    // Step 1: Check if language is known (needed for template selection)
    if (!LanguageUtils.isLanguageKnown(ctx.language)) {
      this.logger.info(`${this.workerName} Follow-up missing language - detecting language first`);

      decisions.push({
        type: 'language_detection',
        createTask: true,
        pendingType: 'check_language',
        reason: 'Need to detect language before follow-up'
      });

      return decisions;
    }

    // Step 2: Check inventory_private status if not yet known
    if (ctx.inventory_private === null) {
      this.logger.info(`${this.workerName} Follow-up missing inventory status - checking inventory first`);

      decisions.push({
        type: 'inventory_check',
        target: 'friend',
        createTask: true,
        pendingType: 'check_inventory_friend',
        reason: 'Need to check if inventory is private before follow-up'
      });

      return decisions;
    }

    // Step 3: If inventory is public and objective not set, assess and set it
    if (ctx.inventory_private === false && !ctx.objective) {
      this.logger.info(`${this.workerName} Follow-up missing objective - assessing inventory to set objective`);

      const assessment = this.inventoryAssessmentManager.assessInventory(ctx);
      ctx.objective = assessment.objective;

      await this.queueManager.updateTask(task.taskID, {
        context: ctx
      });

      const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
      await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
        objective: assessment.objective
      });

      this.logger.info(`${this.workerName}: Set objective to '${ctx.objective}' - ${assessment.reason}`);
    }

    // Now we have enough context - proceed with template selection
    let templateName = null;

    if (ctx.inventory_private === true) {
      templateName = `follow_up_private_inventory_${currentFollowUpCount}`;
    } else if (ctx.objective === 'request_cases_as_gift') {
      templateName = `follow_up_request_cases_as_gift_${currentFollowUpCount}`;
    } else if (ctx.objective === 'request_skins_as_gift') {
      templateName = `follow_up_request_skins_as_gift_${currentFollowUpCount}`;
    } else if (ctx.objective === 'trade') {
      templateName = `follow_up_trade_${currentFollowUpCount}`;
    } else if (ctx.objective === 'redirect') {
      templateName = `follow_up_redirect_to_base_${currentFollowUpCount}`;
    }

    if (templateName) {
      const template = this.getTemplate(templateName, LanguageUtils.getCurrentLanguage(ctx.language));

      if (template.found) {
        // Template exists - use it
        this.logger.info(`${this.workerName} Follow-up using template ${templateName} (count: ${currentFollowUpCount})`);

        const decision = {
          type: 'send_message',
          template: templateName,
          language: LanguageUtils.getCurrentLanguage(ctx.language) || 'English', // Pass language from task context
          createTask: true,
          pendingType: 'send_message',
          reason: `Follow-up #${currentFollowUpCount} using template`,
          variables: {
            LANGUAGE: LanguageUtils.getCurrentLanguage(ctx.language) || 'English'
          }
        };

        // Add skinName variable if this is a skin gift request template
        if (templateName.includes('request_skins_as_gift')) {
          decision.variables.skinName = this.inventoryAssessmentManager.getSkinNameForTemplate(ctx);
        }

        // Add steamId variable if this is a redirect follow-up template
        if (templateName.includes('redirect')) {
          if (ctx.redirected_to && ctx.redirected_to.length > 0) {
            decision.variables.steamId = ctx.redirected_to[0]; // Use first account
          } else {
            this.logger.error(`${this.workerName}: Template '${templateName}' requires steamId but redirected_to is empty`);
          }
        }

        decisions.push(decision);
      } else {
        // Template doesn't exist for this language - try AI translation
        this.logger.info(`${this.workerName} Follow-up template ${templateName} not found (count: ${currentFollowUpCount}) - delegating to AI`);

        // Get translation scenario for this template
        const translationScenario = this.getTranslationScenario(templateName);

        if (translationScenario) {
          // We have a translation scenario - use structured prompt
          const aiVariables = {
            LANGUAGE: LanguageUtils.getCurrentLanguage(ctx.language)
          };

          // Extract follow-up number from template name
          // Format: "follow_up_private_inventory_0", "follow_up_gift_request_2", etc.
          const followUpMatch = templateName.match(/^follow_up_.*_(\d+)$/);
          if (followUpMatch) {
            aiVariables.FOLLOW_UP_NUMBER = followUpMatch[1];
          }

          // Add skinName variable if this is a skin gift request template
          if (templateName.includes('request_skins_as_gift')) {
            aiVariables.SKIN_NAME = this.inventoryAssessmentManager.getSkinNameForTemplate(ctx);
          }

          // Add steamId variable if this is a redirect follow-up template
          if (templateName.includes('redirect')) {
            if (ctx.redirected_to && ctx.redirected_to.length > 0) {
              aiVariables.STEAM_ID = ctx.redirected_to[0]; // Use first account
            } else {
              this.logger.error(`${this.workerName}: Template '${templateName}' requires steamId but redirected_to is empty`);
            }
          }

          decisions.push({
            type: 'consult_ai',
            createTask: true,
            pendingType: 'consult_ai',
            reason: `Translate follow-up template '${templateName}' to ${LanguageUtils.getCurrentLanguage(ctx.language)}`,
            promptScenario: translationScenario,
            variables: aiVariables
          });
        } else {
          // No translation scenario available - fall back to generic AI
          this.logger.warn(`${this.workerName}: No translation scenario found for follow-up template '${templateName}'`);

          decisions.push({
            type: 'consult_ai',
            createTask: true,
            pendingType: 'consult_ai',
            reason: 'Follow-up template not available - needs AI'
          });
        }
      }
    } else {
      // Can't determine template - use AI
      this.logger.info(`${this.workerName} Cannot determine follow-up template (count: ${currentFollowUpCount}) - delegating to AI`);

      decisions.push({
        type: 'consult_ai',
        createTask: true,
        pendingType: 'consult_ai',
        reason: 'Cannot determine follow-up template - needs AI'
      });
    }

    return decisions;
  }

  /**
   * Get template name based on objective and context
   */
  getTemplateNameForObjective(ctx) {
    // Check if there's a game invite (but no other real messages)
    const hasGameInvite = (ctx.messages || []).some(msg =>
      msg.direction === 'incoming' && this.isGameInvite(msg)
    );
    const suffix = hasGameInvite ? '_gameinvite' : '';

    switch(ctx.objective) {
      case 'request_cases_as_gift':
        return `request_cases_as_gift${suffix}`;
      case 'request_skins_as_gift':
        return `request_skins_as_gift${suffix}`;
      case 'trade':
        // Check if we created an immediate trade offer (low-value trades < $20)
        if (ctx.immediate_offer_created) {
          return `trade_initiation_with_offer${suffix}`;
        }
        // Check if we have successful item selection result (inventory sufficient)
        if (ctx.item_selection_result && ctx.item_selection_result.success) {
          // Normal trade initiation with sufficient inventory
          return ctx.source === 'match' ? `trade_initiation_match${suffix}` : `trade_initiation_reserve_pipeline${suffix}`;
        }
        // Check if we have insufficient inventory
        if (ctx.base_accounts_checked_at && (!ctx.redirected_to || ctx.redirected_to.length === 0)) {
          // We checked base accounts and found none - use special template
          return `no_inventory_but_interested${suffix}`;
        }
        // Fallback to normal trade initiation
        return ctx.source === 'match' ? `trade_initiation_match${suffix}` : `trade_initiation_reserve_pipeline${suffix}`;
      case 'redirect':
        return `redirect_to_base${suffix}`;
      default:
        throw new Error(`Cannot determine template for objective: ${ctx.objective}`);
    }
  }

  /**
   * Handle 'remove' objective
   */
  async handleRemoveObjective(task) {
    const decisions = [];
    
    this.logger.info(`${this.workerName}: Objective is 'remove' - creating remove task`);
    
    const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
    await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
      state: 'removing'
    });
    
    decisions.push({
      type: 'remove_friend',
      immediately: true,
      createTask: true,
      pendingType: 'remove_friend',
      removeOrchestrationTask: true,
      reason: 'No items of interest or cannot request from this source'
    });
    
    return decisions;
  }

  /**
   * Handle objective-specific tasks
   * Returns decisions if task needs to be created, null if ready for Step 6
   */
  async handleObjectiveSpecificTasks(task) {
    const ctx = task.context;
    const decisions = [];
    
    switch(ctx.objective) {
      case 'request_cases_as_gift':
      case 'request_skins_as_gift':
        if (!ctx.trade_offers || ctx.trade_offers.length === 0) {
          const itemsToReceive = [];
          
          if (ctx.objective === 'request_cases_as_gift') {
            for (const item of ctx.inventory) {
              if (item.market_hash_name && item.market_hash_name.toLowerCase().includes('case')) {
                itemsToReceive.push({
                  market_hash_name: item.market_hash_name,
                  quantity: item.quantity || 1,
                  price: item.price || 0
                });
              }
            }
            this.logger.info(`${this.workerName}: Creating trade offer for ${itemsToReceive.length} cases`);
          } else {
            // Use smart selection for skins
            const selectedItem = this.inventoryAssessmentManager.selectBestSkin(ctx.inventory);

            if (!selectedItem) {
              this.logger.error(`${this.workerName}: Failed to select skin from inventory`);
              return null;
            }

            itemsToReceive.push({
              market_hash_name: selectedItem.market_hash_name,
              quantity: 1,
              price: selectedItem.price || 0
            });
            this.logger.info(`${this.workerName}: Creating trade offer for 1 item: ${selectedItem.market_hash_name}`);
          }
          
          decisions.push({
            type: 'trade_offer',
            action: 'createTradeOffer',
            createTask: true,
            pendingType: 'create_trade_offer',
            itemsToGive: [],
            itemsToReceive: itemsToReceive,
            reason: `Create gift request trade offer for ${ctx.objective}`
          });
          
          return decisions;
        }
        return null;
        
      case 'trade':
        // If we already created an immediate trade offer, skip to message flow (Step 6)
        if (ctx.immediate_offer_created) {
          return null;
        }

        if (ctx.our_inventory === null || ctx.our_inventory === undefined || !ctx.our_inventory_updated_at) {
          this.logger.info(`${this.workerName}: Our inventory not yet checked (our_inventory: ${ctx.our_inventory}, updated_at: ${ctx.our_inventory_updated_at})`);
          decisions.push({
            type: 'inventory_check',
            target: 'our',
            createTask: true,
            pendingType: 'check_inventory_ours',
            reason: 'Need to check our inventory for trade viability'
          });
          return decisions;
        }

        // Calculate friend's items of interest value
        const friendValue = this.inventoryAssessmentManager.calculateInventoryMetrics(ctx.inventory).itemsOfInterestValue;

        // Validate trade viability with real selection logic
        // our_inventory may be null (empty/inaccessible) - treat as empty array
        const selectionResult = this.inventoryAssessmentManager.validateTradeViability(
          ctx.our_inventory || [],
          friendValue,
          ctx.inventory
        );

        if (selectionResult.success) {
          this.logger.info(`${this.workerName}: Our inventory sufficient for trade (strategy: ${selectionResult.strategy_used}, score: ${selectionResult.score})`);

          // Store the entire selection result for later use
          ctx.item_selection_result = selectionResult;

          // NEW: For low-value trades (< $20), create trade offer immediately
          if (friendValue < 20) {
            this.logger.info(`${this.workerName}: Low-value trade ($${friendValue.toFixed(2)} < $20) - creating immediate trade offer`);

            // Extract all items of interest from friend's inventory
            const itemsToReceive = this.inventoryAssessmentManager.extractAllItemsOfInterest(ctx.inventory);

            // Use selected items from item_selection_result
            const itemsToGive = selectionResult.itemsToGive;

            this.logger.info(`${this.workerName}: Creating trade offer: ${itemsToGive.length} items to give, ${itemsToReceive.length} items to receive`);

            // Mark that we created immediate offer (for template selection)
            ctx.immediate_offer_created = true;

            // Persist context before creating offer
            await this.queueManager.updateTask(task.taskID, {
              context: ctx
            });

            const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
            await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
              item_selection_result: selectionResult,
              immediate_offer_created: true
            });

            // Create immediate trade offer
            decisions.push({
              type: 'trade_offer',
              action: 'createTradeOffer',
              createTask: true,
              pendingType: 'create_trade_offer',
              itemsToGive: itemsToGive,
              itemsToReceive: itemsToReceive,
              reason: `Create immediate trade offer for low-value items ($${friendValue.toFixed(2)})`
            });

            return decisions;
          }

          // Regular flow for high-value trades (>= $20)
          this.logger.info(`${this.workerName}: High-value trade ($${friendValue.toFixed(2)} >= $20) - will wait for friend response before creating offer`);

          // Persist to orchestration task
          await this.queueManager.updateTask(task.taskID, {
            context: ctx
          });

          // Persist to negotiation context
          const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
          await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
            item_selection_result: selectionResult
          });

          return null; // Ready for Step 6
        }

        // Insufficient inventory - check base accounts
        this.logger.info(`${this.workerName}: Our inventory insufficient (${selectionResult.reason}) - checking base accounts`);
        
        const baseAccountsResult = await this.inventoryAssessmentManager.checkBaseAccountsInventory(ctx);
        
        // Update context with results
        ctx.base_accounts_checked_at = new Date().toISOString();
        
        if (baseAccountsResult.suitableAccounts && baseAccountsResult.suitableAccounts.length > 0) {
          // Found suitable base accounts - change objective to redirect
          ctx.redirected_to = baseAccountsResult.suitableAccounts;
          ctx.objective = 'redirect';
          this.logger.info(`${this.workerName}: Found ${ctx.redirected_to.length} suitable base account(s), changing objective to 'redirect'`);
          
          // Persist changes
          await this.queueManager.updateTask(task.taskID, {
            context: ctx
          });
          
          const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
          await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
            base_accounts_checked_at: ctx.base_accounts_checked_at,
            redirected_to: ctx.redirected_to,
            objective: ctx.objective
          });

          // Create redirect entry in redirects.json
          await this.redirectManager.addRedirectEntry(ourSteamId, friendSteamId, baseAccountsResult.suitableAccounts);
          
          // Recurse to handle redirect objective
          return this.handleObjectiveSpecificTasks(task);
        } else {
          // No suitable base accounts - continue with trade objective
          this.logger.info(`${this.workerName}: No suitable base accounts found`);
          
          // Persist the check timestamp
          await this.queueManager.updateTask(task.taskID, {
            context: ctx
          });
          
          const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
          await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
            base_accounts_checked_at: ctx.base_accounts_checked_at
          });
          
          return null; // Ready for Step 6 - will use generic template
        }
        
      case 'redirect':
        return null;
        
      default:
        this.logger.error(`${this.workerName}: Unknown objective '${ctx.objective}'`);
        throw new Error(`Unknown objective: ${ctx.objective}`);
    }
  }

  /**
   * Ensure critical context is gathered before delegating to AI
   * Returns decisions array if context gathering needed, null if context is complete
   *
   * @param {Object} task - Orchestration task
   * @param {Object} options - Options for context gathering
   * @param {boolean} options.requireObjective - Whether to require objective (default: true)
   * @returns {Array|null} Decisions array if gathering needed, null if complete
   */
  async ensureContextGathered(task, options = {}) {
    const { requireObjective = true } = options;
    const ctx = task.context;
    const decisions = [];

    // Step 1: Check if language is known
    if (!LanguageUtils.isLanguageKnown(ctx.language)) {
      this.logger.info(`${this.workerName} Context gathering: language not detected - detecting first`);

      decisions.push({
        type: 'language_detection',
        createTask: true,
        pendingType: 'check_language',
        reason: 'Need to detect language before proceeding'
      });

      return decisions;
    }

    // Step 2: Check if inventory status is known
    if (ctx.inventory_private === null) {
      this.logger.info(`${this.workerName} Context gathering: inventory status unknown - checking first`);

      decisions.push({
        type: 'inventory_check',
        target: 'friend',
        createTask: true,
        pendingType: 'check_inventory_friend',
        reason: 'Need to check inventory status before proceeding'
      });

      return decisions;
    }

    // Step 3: If inventory is public and objective not set, assess and set it
    if (requireObjective && ctx.inventory_private === false && !ctx.objective) {
      this.logger.info(`${this.workerName} Context gathering: objective not set - assessing inventory`);

      const assessment = this.inventoryAssessmentManager.assessInventory(ctx);
      ctx.objective = assessment.objective;

      // Update task context
      await this.queueManager.updateTask(task.taskID, {
        context: ctx
      });

      // Persist to negotiation JSON
      const { ourSteamId, friendSteamId } = this.parseTaskID(task.taskID);
      await this.negotiationContextUpdater.updateNegotiationContext(ourSteamId, friendSteamId, {
        objective: assessment.objective
      });

      this.logger.info(`${this.workerName} Context gathering: set objective to '${ctx.objective}' - ${assessment.reason}`);
    }

    // Context is complete
    this.logger.debug(`${this.workerName} Context gathering complete: language=${LanguageUtils.getCurrentLanguage(ctx.language)}, inventory_private=${ctx.inventory_private}, objective=${ctx.objective}`);
    return null;
  }

  /**
   * STEP 6: Common message flow - handle language detection and messaging
   * @param {Object} task - Orchestration task
   * @param {string} templateName - Template name to use
   */
  async handleCommonMessageFlow(task, templateName) {
    const ctx = task.context;
    const decisions = [];

    if (!templateName) {
      this.logger.error(`${this.workerName}: Template name is required for handleCommonMessageFlow`);
      throw new Error('Template name is required');
    }

    // Check if there's a game invite and modify template name if needed
    const hasGameInvite = (ctx.messages || []).some(msg =>
      msg.direction === 'incoming' && this.isGameInvite(msg)
    );
    if (hasGameInvite && !templateName.endsWith('_gameinvite')) {
      templateName = `${templateName}_gameinvite`;
    }

    // Check if language is known
    if (!LanguageUtils.isLanguageKnown(ctx.language)) {
      decisions.push({
        type: 'language_detection',
        createTask: true,
        pendingType: 'check_language',
        reason: 'Need to detect language before sending message'
      });
      return decisions;
    }
    
    // Try to get template for the language
    const template = this.getTemplate(templateName, LanguageUtils.getCurrentLanguage(ctx.language));
    
    if (template.found) {
      this.logger.info(`${this.workerName}: Sending message using template '${templateName}'`);

      const decision = {
        type: 'send_message',
        template: templateName,
        language: LanguageUtils.getCurrentLanguage(ctx.language) || 'English', // Pass language from task context
        createTask: true,
        pendingType: 'send_message',
        reason: `Send message using template '${templateName}'`,
        variables: {
          LANGUAGE: LanguageUtils.getCurrentLanguage(ctx.language) || 'English'
        }
      };

      // Add skinName variable if this is a skin gift request template
      if (templateName.includes('request_skins_as_gift')) {
        decision.variables.skinName = this.inventoryAssessmentManager.getSkinNameForTemplate(ctx);
      }

      // Add steamId variable if this is a redirect template
      if (templateName === 'redirect_to_base' || templateName.includes('redirect_to_base')) {
        if (ctx.redirected_to && ctx.redirected_to.length > 0) {
          decision.variables.steamId = ctx.redirected_to[0]; // Use first account
        } else {
          this.logger.error(`${this.workerName}: Template '${templateName}' requires steamId but redirected_to is empty`);
        }
      }

      decisions.push(decision);
    } else {
      this.logger.info(`${this.workerName}: Template '${templateName}' not found for language - using AI for translation`);
      
      // Map template name to appropriate translation scenario
      const translationScenario = this.getTranslationScenario(templateName);
      
      if (!translationScenario) {
        this.logger.warn(`${this.workerName}: No translation scenario found for template '${templateName}'`);
        // Fallback to generic behavior or skip
        return decisions;
      }
      
      // Build variables for AI translation
      const aiVariables = {
        LANGUAGE: LanguageUtils.getCurrentLanguage(ctx.language),
        TEMPLATE_NAME: templateName  // Pass template name for dynamic reference
      };

      // Extract follow-up number if this is a follow-up template
      // Template format: "follow_up_private_inventory_0", "follow_up_private_inventory_1", etc.
      const followUpMatch = templateName.match(/^follow_up_.*_(\d+)$/);
      if (followUpMatch) {
        aiVariables.FOLLOW_UP_NUMBER = followUpMatch[1];
      }

      // Add skinName variable if this is a skin gift request template
      if (templateName.includes('request_skins_as_gift')) {
        aiVariables.SKIN_NAME = this.inventoryAssessmentManager.getSkinNameForTemplate(ctx);
      }

      // Add steamId variable if this is a redirect template
      if (templateName === 'redirect_to_base' || templateName.includes('redirect_to_base')) {
        if (ctx.redirected_to && ctx.redirected_to.length > 0) {
          aiVariables.STEAM_ID = ctx.redirected_to[0]; // Use first account
        } else {
          this.logger.error(`${this.workerName}: Template '${templateName}' requires steamId but redirected_to is empty`);
        }
      }

      decisions.push({
        type: 'consult_ai',
        createTask: true,
        pendingType: 'consult_ai',
        reason: `Translate template '${templateName}' to ${LanguageUtils.getCurrentLanguage(ctx.language)}`,
        promptScenario: translationScenario,
        variables: aiVariables
      });
    }
    
    return decisions;
  }

  /**
   * Handle gift request flow
   * FIXED: Consistent message handling across all states
   */
  handleGiftRequest(ctx, decisions) {
    if (LanguageUtils.isLanguageKnown(ctx.language)) {
      const aiDecision = this.shouldUseAI(ctx);
      
      if (aiDecision.shouldUse) {
        decisions.push({
          type: 'consult_ai',
          createTask: true,
          pendingType: 'consult_ai',
          reason: aiDecision.reason,
          details: aiDecision.details
        });
      } else {
        // Use templates based on state
        if (ctx.state === 'initiating') {
          // Determine template based on objective
          const template = ctx.objective === 'request_cases_as_gift' 
            ? 'request_cases_as_gift' 
            : 'request_skins_as_gift';
          
          const templateDecision = this.shouldUseAI(ctx, template);
          
          if (templateDecision.shouldUse) {
            decisions.push({
              type: 'consult_ai',
              createTask: true,
              pendingType: 'consult_ai',
              reason: templateDecision.reason,
              details: templateDecision.details,
              englishFallback: templateDecision.englishFallback
            });
          } else {
            const decision = {
              type: 'send_message',
              template: template,
              language: LanguageUtils.getCurrentLanguage(ctx.language) || 'English', // Pass language from task context
              createTask: true,
              pendingType: 'send_message',
              reason: `Send ${ctx.objective} message (template available)`
            };

            // Add variables if template requires them
            if (template === 'request_skins_as_gift') {
              decision.variables = {
                skinName: this.inventoryAssessmentManager.getSkinNameForTemplate(ctx)
              };
            }
            
            decisions.push(decision);
          }
        } else if (ctx.state === 'awaiting_reply') {
          const followUpTemplate = `follow_up_gift_request_${ctx.followUpCount || 0}`;
          const followUpDecision = this.shouldUseAI(ctx, followUpTemplate);

          if (followUpDecision.shouldUse) {
            decisions.push({
              type: 'consult_ai',
              createTask: true,
              pendingType: 'consult_ai',
              reason: followUpDecision.reason,
              details: followUpDecision.details,
              englishFallback: followUpDecision.englishFallback
            });
          } else {
            decisions.push({
              type: 'send_message',
              template: followUpTemplate,
              language: LanguageUtils.getCurrentLanguage(ctx.language) || 'English', // Pass language from task context
              createTask: true,
              pendingType: 'send_message',
              reason: `Follow up on gift request #${ctx.followUpCount || 0} (template available)`
            });
          }
        }
      }
    }
  }

  /**
   * Handle redirect follow-up
   * FIXED: Consistent message handling across all states
   */
  handleRedirectFollowUp(ctx, decisions) {
    const followUpTemplate = `follow_up_redirect_to_base_${ctx.followUpCount || 0}`;
    const aiDecision = this.shouldUseAI(ctx, followUpTemplate);

    if (aiDecision.shouldUse) {
      decisions.push({
        type: 'consult_ai',
        createTask: true,
        pendingType: 'consult_ai',
        reason: aiDecision.reason,
        details: aiDecision.details,
        englishFallback: aiDecision.englishFallback
      });
    } else {
      // Use templates based on state
      if (ctx.state === 'initiating' || ctx.state === 'awaiting_reply') {
        const decision = {
          type: 'send_message',
          template: followUpTemplate,
          language: LanguageUtils.getCurrentLanguage(ctx.language) || 'English', // Pass language from task context
          createTask: true,
          pendingType: 'send_message',
          reason: `Explain redirect follow-up #${ctx.followUpCount || 0} (template available)`,
          variables: {}
        };

        // Add steamId variable for redirect templates
        if (ctx.redirected_to && ctx.redirected_to.length > 0) {
          decision.variables.steamId = ctx.redirected_to[0]; // Use first account
        } else {
          this.logger.error(`${this.workerName}: Redirect template requires steamId but redirected_to is empty`);
        }

        decisions.push(decision);
      }
    }
  }

  /**
   * Execute decisions by creating tasks in appropriate queues
   * DELEGATED to DecisionExecutionManager
   */
  async executeDecisions(task, decisions) {
    await this.decisionExecutionManager.executeDecisions(task, decisions);
  }

  /**
   * Check if a message is a game invite
   */
  isGameInvite(message) {
    return message && message.message &&
           message.message.includes('[gameinvite') &&
           message.message.includes('[/gameinvite]');
  }

  /**
   * Check if there are any incoming messages (from both messages and referred_from_messages)
   * Excludes automated messages like game invites
   */
  hasIncomingMessages(ctx) {
    const allMessages = [
      ...(ctx.messages || []),
      ...(ctx.referred_from_messages || [])
    ];

    return allMessages.some(msg =>
      msg.direction === 'incoming' && !this.isGameInvite(msg)
    );
  }

  /**
   * Update pending_tasks for an orchestration task
   * FIXED: Properly preserves existing context and other task fields
   */
  async updatePendingTasks(taskID, pendingTypes) {
    try {
      // Get CURRENT task from queue (this has the most up-to-date state)
      const currentTasks = await this.queueManager.getTasks();
      const currentTask = currentTasks.find(t => t.taskID === taskID);
      
      if (!currentTask) {
        this.logger.warn(`${this.workerName}: Task ${taskID} not found for pending_tasks update`);
        return;
      }
      
      // Initialize or update pending_tasks on the current task
      if (!currentTask.pending_tasks) {
        currentTask.pending_tasks = [];
      }
      
      // Add new pending types (avoid duplicates)
      for (const type of pendingTypes) {
        if (!currentTask.pending_tasks.includes(type)) {
          currentTask.pending_tasks.push(type);
        }
      }
      
      // Update task in queue - ONLY update pending_tasks, preserve everything else
      await this.queueManager.updateTask(taskID, {
        pending_tasks: currentTask.pending_tasks
        // ✅ QueueManager.updateTask() usa spread operator para preservar otros campos
        // ✅ Incluyendo el contexto que fue actualizado por checkRedirects()
      });
      
      this.logger.info(`${this.workerName}: Updated pending_tasks for ${taskID}: [${currentTask.pending_tasks.join(', ')}]`);
      
    } catch (error) {
      this.logger.error(`${this.workerName}: Failed to update pending_tasks: ${error.message}`);
    }
  }

  /**
   * Mark task for manual review instead of removing
   */
  async markTaskForReview(task, errorMessage) {
    try {
      await this.queueManager.updateTask(task.taskID, {
        needs_review: true,
        error: errorMessage,
        error_at: new Date().toISOString(),
        execute: new Date(Date.now() + 3600000).toISOString() // Retry in 1 hour
      });
      
      this.logger.warn(`${this.workerName}: Task ${task.taskID} marked for review: ${errorMessage}`);
      
    } catch (error) {
      this.logger.error(`${this.workerName}: Failed to mark task for review: ${error.message}`);
    }
  }

  /**
   * Start statistics reporting
   */
  startStatsReporting() {
    // Report stats every minute
    this.statsTimer = setInterval(() => {
      this.logStatistics();
    }, 60000);
  }

  /**
   * Log current statistics
   */
  logStatistics() {
    this.logger.info(`${this.workerName} Statistics:`);
    this.logger.info(`  - Status: ${this.isRunning ? (this.isPaused ? 'PAUSED' : 'RUNNING') : 'STOPPED'}`);
    this.logger.info(`  - Started at: ${this.stats.startedAt || 'Never'}`);
    this.logger.info(`  - Cycles completed: ${this.stats.cycleCount}`);
    this.logger.info(`  - Tasks processed: ${this.stats.tasksProcessed}`);
    this.logger.info(`  - Tasks skipped: ${this.stats.tasksSkipped}`);
    this.logger.info(`  - Tasks created: ${this.stats.tasksCreated}`);
    this.logger.info(`  - Errors: ${this.stats.errors}`);
    this.logger.info(`  - Last processed: ${this.stats.lastProcessedAt || 'Never'}`);
    
    // Get queue statistics
    this.queueManager.getStats().then(queueStats => {
      this.logger.info(`  - Queue: ${queueStats.total} total (${queueStats.ready} ready, ${queueStats.deferred ?? queueStats.pending ?? 0} deferred)`);
    }).catch(error => {
      this.logger.error(`Failed to get queue stats: ${error.message}`);
    });
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      name: this.workerName,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      stats: this.stats,
      config: {
        processInterval: this.processInterval,
        batchSize: this.batchSize
      }
    };
  }
}

module.exports = OrchestrationWorker;