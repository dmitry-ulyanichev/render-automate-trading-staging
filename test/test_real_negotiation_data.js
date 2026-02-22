// automate_trading/test/test_real_negotiation_data.js
// Test for OrchestrationWorker using real negotiation JSON data

// Load environment variables from .env file
require('dotenv').config();

const OrchestrationWorker = require('../workers/orchestration_worker');
const InventoryWorker = require('../workers/inventory_worker');
const LanguageWorker = require('../workers/language_worker');
const AIWorker = require('../workers/ai_worker');
const MessageWorker = require('../workers/message_worker');
const TradeOfferWorker = require('../workers/trade_offer_worker');
const RemoveFriendWorker = require('../workers/remove_friend_worker');
const FollowUpWorker = require('../workers/follow_up_worker');

const QueueManager = require('../utils/queue_manager');
const path = require('path');

// Test configuration (copied from test_orchestration_worker.js)
const testConfig = {
  orchestration: {
    processInterval: 3000, // 1 second for faster testing
    batchSize: 5
  },
  inventory: {
    processInterval: 2000, // 2 seconds for testing
    batchSize: 3
  },
  language: {
    processInterval: 5000,
    batchSize: 3
  },
  ai: {
    processInterval: 1000,
    batchSize: 2
  },
  message: {
    processInterval: 1500,
    batchSize: 4
  },
  tradeOffer: {
    processInterval: 4000,
    batchSize: 2
  },
  removeFriend: {
    processInterval: 5000,
    batchSize: 5
  },
  followUp: {
    processInterval: 3000,
    batchSize: 3
  },
  queues: {
    lockTimeout: 5000,
    lockRetryDelay: 50,
    maxLockRetries: 100
  },
  baseAccounts: {
    ids: ['76561199027634480']
  },
  nodeApiService: {
    apiKey: 'fa46kPOVnHT2a4aFmQS11dd70290',
    baseUrl: 'http://127.0.0.1:3001'
  },
  dataDir: path.join(__dirname, '..', 'data'),
  
  // ADD: Steam API configuration for testing
  steam: {
    apiKey: process.env.STEAM_API_KEY || 'DUMMY_STEAM_API_KEY_FOR_TESTING',
    timeout: 10000,
    maxRetries: 3
  },
  
  // ADD: Steam API per-endpoint configuration (for SteamApiManager)
  steamApi: {
    getFriendsList: {
      baseInterval: 1000, // Faster for testing
      intervals: [1000, 2000, 4000, 8000, 16000],
      resetTimeoutMinutes: 1,
      maxConsecutiveErrors: 3
    },
    getPlayerSummaries: {
      baseInterval: 1000, // Faster for testing
      intervals: [1000, 2000, 4000, 8000, 16000],
      resetTimeoutMinutes: 1,
      maxConsecutiveErrors: 3
    }
  }
};

// Mock logger for cleaner output
const mockLogger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.log(`[WARN] ${msg}`),
  error: (msg) => console.log(`[ERROR] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`)
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

/**
 * Create test scenarios using real negotiation JSON data
 */
function createRealDataScenarios() {
  const scenarios = [];
  const baseTaskID = '76561199792495944';
  
  // Scenario: Real JSON with different inventories
  scenarios.push({
    name: 'Real JSON',
    description: 'Uses real 76561199792495944.json, can draw referrer data from real 76561199027634480.json',
    expectedCasesValue: 0.0,
    expectedTotalValue: 2.2,
    expectedObjective: 'remove',
    expectedDecisions: ['language_detection'],
    task: {
      taskID: `${baseTaskID}_76561197963147651`,
      pending_tasks: [],
      priority: 'normal',
      execute: new Date().toISOString(),
      created_at: new Date().toISOString()
    }
  });
  
  return scenarios;
}

/**
 * Process a single scenario using real data
 */
async function processRealDataScenario(scenario, orchestrationQueue) {
  console.log(`\n${colors.blue}╔═══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║ ${scenario.name.padEnd(57)} ║${colors.reset}`);
  console.log(`${colors.blue}╚═══════════════════════════════════════════════════════════╝${colors.reset}`);
  console.log(`${colors.gray}📄 ${scenario.description}${colors.reset}`);
  
  try {
    // Create orchestration worker (uses real HttpClient with proper config)
    const orchestrationWorker = new OrchestrationWorker(testConfig, mockLogger);

    // Initialize templates before processing
    await orchestrationWorker.initializeTemplatesPrompts();
    
    // Clear any existing task first
    await orchestrationQueue.removeTask(scenario.task.taskID);
    
    // ✅ Load context from real JSON BEFORE adding to queue
    console.log(`📥 Loading context from real JSON...`);
    
    try {
      // Parse taskID properly (using the same logic as OrchestrationWorker)
      const taskIdParts = scenario.task.taskID.split('_');
      if (taskIdParts.length !== 2) {
        throw new Error(`Invalid taskID format: ${scenario.task.taskID}`);
      }
      
      const ourSteamId = taskIdParts[0];
      const friendSteamId = taskIdParts[1];
      
      console.log(`   🆔 Our Steam ID: ${ourSteamId}`);
      console.log(`   👤 Friend Steam ID: ${friendSteamId}`);
      
      const negotiationsData = await orchestrationWorker.httpClient.loadNegotiations(ourSteamId);
      const negotiation = negotiationsData.negotiations[friendSteamId];
      
      if (!negotiation) {
        throw new Error(`Negotiation not found for friend ${friendSteamId} in JSON`);
      }
      
      // ✅ Update task context with real data from JSON BEFORE adding to queue
      scenario.task.context = {
        ...scenario.task.context,
        state: negotiation.state,
        followUpCount: negotiation.followUpCount,
        inventory_private: negotiation.inventory_private,
        inventory: negotiation.inventory,
        inventory_updated_at: negotiation.inventory_updated_at, // ✅ CRÍTICO
        source: negotiation.source,
        objective: negotiation.objective,
        language: negotiation.language,
        messages: negotiation.messages,
        trade_offers: negotiation.trade_offers,
        our_inventory: negotiationsData.our_inventory,
        referrer_checked: negotiation.referrer_checked,
        trade_offers_updated_at: negotiation.trade_offers_updated_at,
        base_accounts_checked_at: negotiation.base_accounts_checked_at,
        redirected_to: negotiation.redirected_to || [],
        referred_from_messages: negotiation.referred_from_messages || [],
        ai_requested_actions: negotiation.ai_requested_actions
      };
      
      console.log(`✅ Context loaded from real JSON:`);
      console.log(`   📦 Inventory items: ${negotiation.inventory ? negotiation.inventory.length : 'null'}`);
      console.log(`   🔒 Inventory private: ${negotiation.inventory_private}`);
      console.log(`   📍 Source: ${negotiation.source}`);
      console.log(`   🎯 Current objective: ${negotiation.objective || 'null'}`);
      console.log(`   🕐 Inventory updated at: ${negotiation.inventory_updated_at || 'never'}`);
      
    } catch (error) {
      console.log(`    ${colors.red}⚠️  Failed to load real JSON data: ${error.message}${colors.reset}`);
      console.log(`    ${colors.yellow}   Continuing with test data...${colors.reset}`);
    }
    
    // ✅ Add task to queue WITH complete context
    const added = await orchestrationQueue.addTask(scenario.task);
    if (!added) {
      throw new Error('Failed to add task to queue');
    }
    
    // ✅ Verify that task was saved with complete context
    const tasksInQueue = await orchestrationQueue.getTasks();
    const addedTask = tasksInQueue.find(t => t.taskID === scenario.task.taskID);
    console.log(`🔍 Task added to queue has context: ${!!addedTask?.context}`);
    console.log(`🔍 Context has inventory_updated_at: ${!!addedTask?.context?.inventory_updated_at}`);
    if (addedTask?.context?.inventory_updated_at) {
      console.log(`🔍 inventory_updated_at value: ${addedTask.context.inventory_updated_at}`);
    }
    
    // Get initial task state
    console.log(`📊 Initial objective: ${colors.yellow}${addedTask?.context?.objective || 'null'}${colors.reset}`);
    
    // Process the task
    console.log(`⚙️  Processing task with OrchestrationWorker...`);
    await orchestrationWorker.processTask(scenario.task);
    
    // Get processed task from queue - FIXED
    const processedTasks = await orchestrationQueue.getTasks();
    const processedTask = processedTasks.find(t => t.taskID === scenario.task.taskID);
    
    if (!processedTask) {
      throw new Error('Task disappeared after processing');
    }
    
    // Display results
    console.log(`\n📊 ASSESSMENT RESULTS:`);
    console.log(`   🎯 Final objective: ${colors.cyan}${processedTask.context?.objective || 'null'}${colors.reset}`);
    console.log(`   🎯 Expected objective: ${colors.cyan}${scenario.expectedObjective}${colors.reset}`);
    
    // Check objective correctness
    const objectiveMatch = processedTask.context?.objective === scenario.expectedObjective;
    if (objectiveMatch) {
      console.log(`   ${colors.green}✅ Objective set correctly${colors.reset}`);
    } else {
      console.log(`   ${colors.red}❌ Objective mismatch!${colors.reset}`);
    }
    
    // Display inventory analysis if available
    if (processedTask.context?.inventory) {
      console.log(`\n📦 INVENTORY ANALYSIS:`);
      const cases = processedTask.context.inventory.filter(item => 
        item.market_hash_name && item.market_hash_name.toLowerCase().includes('case')
      );
      
      let totalCasesValue = 0;
      cases.forEach(caseItem => {
        const value = (caseItem.price || 0) * (caseItem.quantity || 1);
        totalCasesValue += value;
        console.log(`   📦 ${caseItem.market_hash_name}: ${caseItem.quantity}x @ $${caseItem.price} = $${value.toFixed(2)}`);
      });
      
      console.log(`   💰 Total cases value: $${totalCasesValue.toFixed(2)}`);
      console.log(`   📏 Expected value: $${scenario.expectedCasesValue.toFixed(2)}`);
      
      if (Math.abs(totalCasesValue - scenario.expectedCasesValue) < 0.01) {
        console.log(`   ${colors.green}✅ Cases value matches expectation${colors.reset}`);
      } else {
        console.log(`   ${colors.red}❌ Cases value mismatch${colors.reset}`);
      }
    }
    
    // Check what tasks were created in other queues
    console.log(`\n📋 CREATED TASKS:`);
    const createdTasks = {};
    const queueNames = ['language_queue', 'inventory_queue', 'message_queue', 'ai_queue', 'trade_offer_queue', 'remove_friend_queue'];
    
    for (const queueName of queueNames) {
      try {
        const queue = new QueueManager(queueName, testConfig, mockLogger);
        const tasks = await queue.getTasks();
        const relevantTasks = tasks.filter(task => 
          task.taskID === scenario.task.taskID || 
          (task.targetSteamID && task.targetSteamID === '76561198000000601')
        );
        
        if (relevantTasks.length > 0) {
          createdTasks[queueName] = relevantTasks.length;
          console.log(`   📝 ${queueName}: ${relevantTasks.length} task(s)`);
        }
      } catch (error) {
        // Queue might not exist, ignore
      }
    }
    
    if (Object.keys(createdTasks).length === 0) {
      console.log(`   ${colors.gray}(No tasks created in monitored queues)${colors.reset}`);
    }
    
    // Check pending tasks
    if (processedTask.pending_tasks && processedTask.pending_tasks.length > 0) {
      console.log(`\n⏳ PENDING TASKS:`);
      processedTask.pending_tasks.forEach(task => {
        console.log(`   ⏳ ${task}`);
      });
    }
    
    // Overall result
    const success = objectiveMatch;
    console.log(`\n${success ? colors.green + '✅ TEST PASSED' : colors.red + '❌ TEST FAILED'}${colors.reset}`);
    
    return {
      success: success,
      objective: processedTask.context?.objective,
      expectedObjective: scenario.expectedObjective,
      createdTasks: createdTasks,
      pendingTasks: processedTask.pending_tasks || [],
      casesValue: processedTask.context?.inventory ? 
        processedTask.context.inventory
          .filter(item => item.market_hash_name && item.market_hash_name.toLowerCase().includes('case'))
          .reduce((sum, item) => sum + (item.price || 0) * (item.quantity || 1), 0) : 0
    };
    
  } catch (error) {
    console.log(`\n${colors.red}❌ ERROR: ${error.message}${colors.reset}`);
    if (error.stack) {
      console.log(`${colors.gray}${error.stack}${colors.reset}`);
    }
    return { success: false, error: error.message };
  }
}

/**
 * Test worker interaction with orchestration tasks
 */
async function testWorkerInteraction() {
  console.log(`\n${colors.blue}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║                    Worker Interaction Test                  ║${colors.reset}`);
  console.log(`${colors.blue}║     Testing Dummy Workers with OrchestrationWorker          ║${colors.reset}`);
  console.log(`${colors.blue}╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  
  // Initialize workers
  const orchestrationWorker = new OrchestrationWorker(testConfig, mockLogger);
  const inventoryWorker = new InventoryWorker(testConfig, mockLogger);
  const languageWorker = new LanguageWorker(testConfig, mockLogger);
  const aiWorker = new AIWorker(testConfig, mockLogger);
  const messageWorker = new MessageWorker(testConfig, mockLogger);
  const tradeOfferWorker = new TradeOfferWorker(testConfig, mockLogger);
  const removeFriendWorker = new RemoveFriendWorker(testConfig, mockLogger);
  
  console.log(`📋 Initialized workers:`);
  console.log(`   ✅ OrchestrationWorker`);
  console.log(`   ✅ InventoryWorker (simplified)`);
  console.log(`   ✅ LanguageWorker (simplified)`);
  console.log(`   ✅ AIWorker (dummy)`);
  console.log(`   ✅ MessageWorker (dummy)`);
  console.log(`   ⏳ TradeOfferWorker (dummy) - commented out`);
  console.log(`   ✅ RemoveFriendWorker (dummy)`);
  console.log(`   ✅ FollowUpWorkerWorker (dummy)`);
  
  try {
    // Initialize templates for orchestration worker
    await orchestrationWorker.initializeTemplatesPrompts();
    console.log(`🔧 OrchestrationWorker templates initialized`);
    
    // Start workers
    await orchestrationWorker.start();
    await inventoryWorker.start();
    await languageWorker.start();
    await aiWorker.start();
    await messageWorker.start();
    await tradeOfferWorker.start();
    await removeFriendWorker.start();
    
    console.log(`🚀 Workers started successfully`);
    
    // Target task configuration
    const ourSteamId = '76561199792495944';
    const friendSteamId = '76561197963147651';
    const taskID = `${ourSteamId}_${friendSteamId}`;
    
    console.log(`\n📄 Loading real negotiation context:`);
    console.log(`   📁 File: ${ourSteamId}.json`);
    console.log(`   👤 Friend: ${friendSteamId}`);
    
    // Load real context from negotiation JSON
    let realContext = {};
    try {
      const negotiationsData = await orchestrationWorker.httpClient.loadNegotiations(ourSteamId);
      const negotiation = negotiationsData.negotiations[friendSteamId];
      
      if (!negotiation) {
        throw new Error(`Negotiation not found for friend ${friendSteamId} in JSON`);
      }
      
      // Build context from real JSON data
      realContext = {
        our_steam_id: ourSteamId,
        friend_steam_id: friendSteamId,
        state: negotiation.state || 'initiating',
        trigger: 'test_worker_interaction',
        followUpCount: negotiation.followUpCount,
        inventory_private: negotiation.inventory_private,
        inventory: negotiation.inventory,
        inventory_updated_at: negotiation.inventory_updated_at,
        source: negotiation.source,
        objective: negotiation.objective,
        language: negotiation.language,
        messages: negotiation.messages || [],
        trade_offers: negotiation.trade_offers || [],
        our_inventory: negotiationsData.our_inventory,
        referrer_checked: negotiation.referrer_checked,
        trade_offers_updated_at: negotiation.trade_offers_updated_at,
        base_accounts_checked_at: negotiation.base_accounts_checked_at,
        redirected_to: negotiation.redirected_to || [],
        referred_from_messages: negotiation.referred_from_messages || [],
        ai_requested_actions: negotiation.ai_requested_actions
      };
      
      console.log(`✅ Real context loaded:`);
      console.log(`   📦 Inventory: ${realContext.inventory ? realContext.inventory.length + ' items' : 'null'}`);
      console.log(`   🔒 Inventory private: ${realContext.inventory_private}`);
      console.log(`   📍 Source: ${realContext.source}`);
      console.log(`   🎯 Current objective: ${realContext.objective || 'none'}`);
      console.log(`   🗣️ Language: ${realContext.language || 'none'}`);
      console.log(`   💬 Messages: ${realContext.messages.length} messages`);
      console.log(`   🕐 Inventory updated: ${realContext.inventory_updated_at || 'never'}`);
      
    } catch (error) {
      console.log(`   ${colors.yellow}⚠️ Failed to load real JSON: ${error.message}${colors.reset}`);
      console.log(`   ${colors.yellow}   Using minimal test context...${colors.reset}`);
      
      // Fallback to minimal context
      realContext = {
        our_steam_id: ourSteamId,
        friend_steam_id: friendSteamId,
        state: 'initiating',
        trigger: 'test_worker_interaction',
        inventory: null,
        language: null
      };
    }
    
    // Create orchestration task with real context
    const orchestrationQueue = new QueueManager('orchestration_queue', testConfig, mockLogger);
    
    // Clear any existing tasks first
    await orchestrationQueue.removeTask(taskID);
    
    const testTask = {
      taskID: taskID,
      pending_tasks: [], // Start empty to trigger OrchestrationWorker processing
      priority: 'normal',
      execute: new Date().toISOString(),
      created_at: new Date().toISOString(),
      context: realContext
    };
    
    console.log(`\n📝 Creating orchestration task:`);
    console.log(`   🆔 TaskID: ${taskID}`);
    console.log(`   📊 Context loaded: ${Object.keys(realContext).length} fields`);
    
    const added = await orchestrationQueue.addTask(testTask);
    if (!added) {
      throw new Error('Failed to add orchestration task to queue');
    }
    
    console.log(`✅ Orchestration task added to queue`);
    
    // Give workers time to discover and process tasks
    console.log(`\n⏳ Processing cycle started - monitoring for 12 seconds...`);
    
    // Track task processing to prevent infinite loops in tests
    const processedTasksTracker = new Map(); // taskID -> processing count
    const maxProcessingPerTask = 3; // Limit each task to 3 processing cycles
    
    // Monitor progress every 3 seconds
    for (let i = 1; i <= 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(`\n🔍 Check #${i} (${i * 3}s):`);
      
      // Check orchestration task status
      const orchestrationTasks = await orchestrationQueue.getTasks();
      const currentTask = orchestrationTasks.find(t => t.taskID === taskID);
      
      if (currentTask) {
        console.log(`   📋 Orchestration task:`);
        console.log(`      🎯 Pending: [${currentTask.pending_tasks ? currentTask.pending_tasks.join(', ') : 'none'}]`);
        console.log(`      🎯 Objective: ${currentTask.context?.objective || 'none'}`);
        console.log(`      🕐 Updated: ${currentTask.updated_at || 'never'}`);
        
        // Track processing count to prevent infinite loops
        const processingCount = (processedTasksTracker.get(taskID) || 0) + 1;
        processedTasksTracker.set(taskID, processingCount);
        
        // If task has been processed too many times and has empty pending_tasks, pause OrchestrationWorker
        if (processingCount >= maxProcessingPerTask && (!currentTask.pending_tasks || currentTask.pending_tasks.length === 0)) {
          console.log(`   ⚠️ Task ${taskID} has been processed ${processingCount} times with empty pending_tasks`);
          console.log(`   ⏸️ Pausing OrchestrationWorker to prevent infinite loop...`);
          orchestrationWorker.pause();
        }
      } else {
        console.log(`   📋 Orchestration task: ✅ COMPLETED/REMOVED`);
      }
      
      // Check inventory queue
      const inventoryQueue = new QueueManager('inventory_queue', testConfig, mockLogger);
      const inventoryTasks = await inventoryQueue.getTasks();
      console.log(`   📦 Inventory queue: ${inventoryTasks.length} tasks`);
      
      // Show worker stats
      // const orchStats = orchestrationWorker.getStats();
      // const invStats = inventoryWorker.getStats();
      // console.log(`   📊 OrchestrationWorker: ${orchStats.tasksProcessed} processed, ${orchStats.tasksCreated} created`);
      // console.log(`   📊 InventoryWorker: ${invStats.tasksProcessed} processed`);
    }
    
    // Final results summary
    console.log(`\n📊 Final Results:`);
    
    const finalOrchestrationTasks = await orchestrationQueue.getTasks();
    const finalTask = finalOrchestrationTasks.find(t => t.taskID === taskID);
    
    if (finalTask) {
      console.log(`📋 Final orchestration task state:`);
      console.log(`   🎯 Pending tasks: [${finalTask.pending_tasks ? finalTask.pending_tasks.join(', ') : 'none'}]`);
      console.log(`   📦 Objective: ${finalTask.context?.objective || 'none'}`);
      console.log(`   🕐 Last updated: ${finalTask.updated_at || 'never'}`);
    } else {
      console.log(`📋 Orchestration task: ${colors.green}✅ COMPLETED AND REMOVED${colors.reset}`);
    }
    
    // Final queue states
    const inventoryQueue = new QueueManager('inventory_queue', testConfig, mockLogger);
    const finalInventoryTasks = await inventoryQueue.getTasks();
    console.log(`📦 Final inventory queue: ${finalInventoryTasks.length} tasks remaining`);
    
    // Final worker statistics
    // console.log(`\n📈 Final Worker Statistics:`);
    // const finalOrchStats = orchestrationWorker.getStats();
    // const finalInvStats = inventoryWorker.getStats();
    // console.log(`   OrchestrationWorker: ${finalOrchStats.tasksProcessed} tasks processed, ${finalOrchStats.tasksCreated} tasks created, ${finalOrchStats.errors} errors`);
    // console.log(`   InventoryWorker: ${finalInvStats.tasksProcessed} tasks processed, ${finalInvStats.errors} errors`);
    
    console.log(`\n${colors.green}✅ Worker interaction test completed successfully!${colors.reset}`);
    
  } catch (error) {
    console.log(`\n${colors.red}❌ Worker test error: ${error.message}${colors.reset}`);
    if (error.stack) {
      console.log(`${colors.gray}${error.stack}${colors.reset}`);
    }
    throw error;
  } finally {
    // Stop workers
    console.log(`\n🛑 Stopping workers...`);
    await orchestrationWorker.stop();
    await inventoryWorker.stop();
    await languageWorker.stop();
    await aiWorker.stop();
    await messageWorker.stop();
    await tradeOfferWorker.stop();
    await removeFriendWorker.stop();
    
    console.log(`✅ All workers stopped`);
  }
}

/**
 * Test FollowUpWorker flow specifically
 */
async function testFollowUpWorkerFlow() {
  console.log(`\n${colors.blue}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║                   FollowUpWorker Flow Test                   ║${colors.reset}`);
  console.log(`${colors.blue}║       Testing FollowUp → Orchestration → Other Workers      ║${colors.reset}`);
  console.log(`${colors.blue}╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  
  // Initialize workers
  const followUpWorker = new FollowUpWorker(testConfig, mockLogger);
  const orchestrationWorker = new OrchestrationWorker(testConfig, mockLogger);
  const inventoryWorker = new InventoryWorker(testConfig, mockLogger);
  const languageWorker = new LanguageWorker(testConfig, mockLogger);
  const aiWorker = new AIWorker(testConfig, mockLogger);
  const messageWorker = new MessageWorker(testConfig, mockLogger);
  
  console.log(`📋 Initialized workers:`);
  console.log(`   ✅ FollowUpWorker`);
  console.log(`   ✅ OrchestrationWorker`);
  console.log(`   ✅ InventoryWorker (simplified)`);
  // console.log(`   ⏳ Other workers (commented out)`);
  
  try {
    // Initialize templates for orchestration worker
    await orchestrationWorker.initializeTemplatesPrompts();
    console.log(`🔧 OrchestrationWorker templates initialized`);
    
    // Start workers
    await followUpWorker.start();
    await orchestrationWorker.start();
    // await inventoryWorker.start();
    // await languageWorker.start();
    // await aiWorker.start();
    await messageWorker.start();
    
    console.log(`🚀 Workers started successfully`);
    
    // Target task configuration
    const ourSteamId = '76561199027634480';
    const friendSteamId = '76561197963147651';
    const taskID = `${ourSteamId}_${friendSteamId}`;
    
    console.log(`\n📄 Expected FollowUp task:`);
    console.log(`   🆔 TaskID: ${taskID}`);
    console.log(`   📁 Should exist in follow_up_queue.json`);
    
    // Verify follow-up task exists
    const followUpQueue = new QueueManager('follow_up_queue', testConfig, mockLogger);
    const orchestrationQueue = new QueueManager('orchestration_queue', testConfig, mockLogger);
    
    const initialFollowUpTasks = await followUpQueue.getTasks();
    const initialOrchestrationTasks = await orchestrationQueue.getTasks();
    
    console.log(`\n📊 Initial queue states:`);
    console.log(`   📮 FollowUp queue: ${initialFollowUpTasks.length} tasks`);
    console.log(`   🎯 Orchestration queue: ${initialOrchestrationTasks.length} tasks`);
    
    // Find our specific task
    const followUpTask = initialFollowUpTasks.find(t => (t.id || t.taskID) === taskID);
    if (followUpTask) {
      const executeTime = new Date(followUpTask.execute);
      const now = new Date();
      const isReady = executeTime <= now;
      
      console.log(`   ✅ Found follow-up task: ${taskID}`);
      console.log(`   ⏰ Execute time: ${followUpTask.execute}`);
      console.log(`   🔄 Ready for execution: ${isReady ? 'YES' : 'NO'}`);
      
      if (!isReady) {
        console.log(`   ⚠️  Task scheduled for future, may not execute during test`);
      }
    } else {
      console.log(`   ❌ Follow-up task ${taskID} not found in queue`);
      console.log(`   📋 Available tasks: ${initialFollowUpTasks.map(t => t.id || t.taskID).join(', ')}`);
    }
    
    // Monitor the cascade effect
    console.log(`\n⏳ Monitoring worker cascade for 20 seconds...`);
    
    // Monitor progress every 4 seconds
    for (let i = 1; i <= 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 4000));
      console.log(`\n🔍 Check #${i} (${i * 4}s):`);
      
      // Check all relevant queues
      const currentFollowUpTasks = await followUpQueue.getTasks();
      const currentOrchestrationTasks = await orchestrationQueue.getTasks();
      
      console.log(`   📮 FollowUp queue: ${currentFollowUpTasks.length} tasks`);
      console.log(`   🎯 Orchestration queue: ${currentOrchestrationTasks.length} tasks`);
      
      // Check if orchestration task was created by FollowUpWorker
      const newOrchestrationTask = currentOrchestrationTasks.find(t => t.taskID === taskID);
      if (newOrchestrationTask) {
        console.log(`   ✅ Orchestration task created by FollowUpWorker!`);
        console.log(`      🎯 Pending: [${newOrchestrationTask.pending_tasks ? newOrchestrationTask.pending_tasks.join(', ') : 'none'}]`);
        console.log(`      🎯 Trigger: ${newOrchestrationTask.context?.trigger || 'unknown'}`);
        console.log(`      🕐 Created: ${newOrchestrationTask.created_at || 'unknown'}`);
      }
      
      // Check other queues for cascade effects
      const inventoryQueue = new QueueManager('inventory_queue', testConfig, mockLogger);
      const inventoryTasks = await inventoryQueue.getTasks();
      console.log(`   📦 Inventory queue: ${inventoryTasks.length} tasks`);
      
      // Show worker stats
      // const followUpStats = followUpWorker.getStats();
      // const orchStats = orchestrationWorker.getStats();
      // const invStats = inventoryWorker.getStats();
      
      // console.log(`   📊 FollowUpWorker: ${followUpStats.tasksProcessed} processed`);
      // console.log(`   📊 OrchestrationWorker: ${orchStats.tasksProcessed} processed, ${orchStats.tasksCreated} created`);
      // console.log(`   📊 InventoryWorker: ${invStats.tasksProcessed} processed`);
      
      // Special logging for first orchestration task creation
      if (i === 1 && newOrchestrationTask) {
        console.log(`   🎉 SUCCESS: FollowUp → Orchestration cascade working!`);
      }
    }
    
    // Final results summary
    console.log(`\n📊 Final Results:`);
    
    const finalFollowUpTasks = await followUpQueue.getTasks();
    const finalOrchestrationTasks = await orchestrationQueue.getTasks();
    
    console.log(`📮 Final FollowUp queue: ${finalFollowUpTasks.length} tasks`);
    console.log(`🎯 Final Orchestration queue: ${finalOrchestrationTasks.length} tasks`);
    
    const createdOrchestrationTask = finalOrchestrationTasks.find(t => t.taskID === taskID);
    if (createdOrchestrationTask) {
      console.log(`✅ Orchestration task successfully created:`);
      console.log(`   🆔 TaskID: ${createdOrchestrationTask.taskID}`);
      console.log(`   🎯 Pending: [${createdOrchestrationTask.pending_tasks ? createdOrchestrationTask.pending_tasks.join(', ') : 'none'}]`);
      console.log(`   📝 Context fields: ${Object.keys(createdOrchestrationTask.context || {}).length}`);
    }
    
    // Final worker statistics
    // console.log(`\n📈 Final Worker Statistics:`);
    // const finalFollowUpStats = followUpWorker.getStats();
    // const finalOrchStats = orchestrationWorker.getStats();
    // const finalInvStats = inventoryWorker.getStats();
    
    // console.log(`   FollowUpWorker: ${finalFollowUpStats.tasksProcessed} processed, ${finalFollowUpStats.errors} errors`);
    // console.log(`   OrchestrationWorker: ${finalOrchStats.tasksProcessed} processed, ${finalOrchStats.tasksCreated} created, ${finalOrchStats.errors} errors`);
    // console.log(`   InventoryWorker: ${finalInvStats.tasksProcessed} processed, ${finalInvStats.errors} errors`);
    
    // Determine test success
    // const testSuccess = (
    //   finalFollowUpStats.tasksProcessed > 0 && // FollowUpWorker processed the task
    //   createdOrchestrationTask && // Orchestration task was created
    //   finalOrchStats.tasksProcessed > 0 // OrchestrationWorker started processing
    // );
    
    // if (testSuccess) {
    //   console.log(`\n${colors.green}✅ FollowUpWorker flow test completed successfully!${colors.reset}`);
    //   console.log(`🔄 Cascade effect: FollowUp → Orchestration → Other Workers`);
    // } else {
    //   console.log(`\n${colors.yellow}⚠️  Test completed with mixed results${colors.reset}`);
    //   if (finalFollowUpStats.tasksProcessed === 0) {
    //     console.log(`❌ FollowUpWorker did not process any tasks`);
    //   }
    //   if (!createdOrchestrationTask) {
    //     console.log(`❌ No orchestration task was created`);
    //   }
    // }
    
  } catch (error) {
    console.log(`\n${colors.red}❌ FollowUpWorker test error: ${error.message}${colors.reset}`);
    if (error.stack) {
      console.log(`${colors.gray}${error.stack}${colors.reset}`);
    }
    throw error;
  } finally {
    // Stop workers
    console.log(`\n🛑 Stopping workers...`);
    await followUpWorker.stop();
    await orchestrationWorker.stop();
    await inventoryWorker.stop();
    await languageWorker.stop();
    await aiWorker.stop();
    await messageWorker.stop();
    
    console.log(`✅ All workers stopped`);
  }
}

/**
 * Test TradeOfferWorker flow specifically
 * Simulates Scenario 9: AIWorker creates trade_offer task → TradeOfferWorker processes it
 */
async function testTradeOfferWorkerFlow() {
  console.log(`\n${colors.blue}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║                 TradeOfferWorker Flow Test                   ║${colors.reset}`);
  console.log(`${colors.blue}║    Testing AI → TradeOffer → Orchestration Worker Chain     ║${colors.reset}`);
  console.log(`${colors.blue}╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  
  // Initialize workers
  const orchestrationWorker = new OrchestrationWorker(testConfig, mockLogger);
  const tradeOfferWorker = new TradeOfferWorker(testConfig, mockLogger);
  
  console.log(`📋 Initialized workers:`);
  console.log(`   ✅ OrchestrationWorker`);
  console.log(`   ✅ TradeOfferWorker`);
  
  try {
    // Initialize templates for orchestration worker
    await orchestrationWorker.initializeTemplatesPrompts();
    console.log(`🔧 OrchestrationWorker templates initialized`);
    
    // Start workers
    await orchestrationWorker.start();
    await tradeOfferWorker.start();
    
    console.log(`🚀 Workers started successfully`);
    
    // Target task configuration - simulate Scenario 9
    const ourSteamId = '76561199027634480';
    const friendSteamId = '76561197963147651';
    const taskID = `${ourSteamId}_${friendSteamId}`;
    
    console.log(`\n📄 Setting up TradeOffer test scenario:`);
    console.log(`   📁 Our Account: ${ourSteamId}`);
    console.log(`   👤 Friend: ${friendSteamId}`);
    console.log(`   🎯 Scenario: AI has requested createTradeOffer action`);
    
    // Initialize queue managers
    const orchestrationQueue = new QueueManager('orchestration_queue', testConfig, mockLogger);
    const tradeOfferQueue = new QueueManager('trade_offer_queue', testConfig, mockLogger);
    
    // Clean up any existing tasks
    await orchestrationQueue.removeTask(taskID);
    await tradeOfferQueue.removeTask(taskID);
    
    console.log(`🧹 Cleaned up existing tasks`);
    
    // Step 1: Load real negotiation context and simulate AI decision
    console.log(`\n📥 Step 1: Loading real negotiation context...`);
    
    let negotiationContext = {};
    try {
      const negotiationsData = await orchestrationWorker.httpClient.loadNegotiations(ourSteamId);
      const negotiation = negotiationsData.negotiations[friendSteamId];
      
      if (!negotiation) {
        throw new Error(`Negotiation not found for friend ${friendSteamId}`);
      }
      
      // Build enhanced context simulating post-AI analysis
      negotiationContext = {
        our_steam_id: ourSteamId,
        friend_steam_id: friendSteamId,
        state: 'replying', // Friend has replied, we're processing
        trigger: 'test_trade_offer_flow',
        inventory_private: negotiation.inventory_private || false,
        inventory: negotiation.inventory || [],
        objective: 'trade', // AI determined we want to trade
        language: negotiation.language || 'English',
        messages: [
          // Simulate conversation that led to trade offer creation
          {
            id: 'msg_001',
            timestamp: new Date(Date.now() - 600000).toISOString(),
            direction: 'outgoing',
            message: 'Hi! Interested in trading some items?'
          },
          {
            id: 'msg_002', 
            timestamp: new Date(Date.now() - 300000).toISOString(),
            direction: 'incoming',
            message: 'Sure! What do you have in mind?'
          },
          {
            id: 'msg_003',
            timestamp: new Date(Date.now() - 60000).toISOString(),
            direction: 'incoming', 
            message: 'I\'m interested in your AK-47 Redline'
          }
        ],
        trade_offers: [], // No existing trade offers
        our_inventory: negotiationsData.our_inventory || [],
        redirected_to: [],
        referred_from_messages: [],
        
        // CRITICAL: Simulate AI has requested a trade offer creation
        ai_requested_actions: {
          actions_pending: [
            {
              action_id: `trade_${Date.now()}`,
              type: 'create_trade_offer',
              params: {
                items_to_give: [
                  {
                    market_hash_name: 'AK-47 | Redline (Field-Tested)',
                    quantity: 1,
                    price: 15.50
                  }
                ],
                items_to_receive: [
                  {
                    market_hash_name: 'M4A4 | Asiimov (Battle-Scarred)', 
                    quantity: 1,
                    price: 18.00
                  }
                ],
                message: 'Here\'s the trade offer we discussed!'
              },
              requested_at: new Date().toISOString()
            }
          ],
          actions_completed: []
        }
      };
      
      console.log(`✅ Enhanced context prepared:`);
      console.log(`   📦 Friend inventory: ${negotiationContext.inventory ? negotiationContext.inventory.length : 0} items`);
      console.log(`   💬 Messages: ${negotiationContext.messages.length} messages`);
      console.log(`   🤖 AI actions pending: ${negotiationContext.ai_requested_actions.actions_pending.length}`);
      
    } catch (error) {
      console.log(`❌ Failed to load negotiation context: ${error.message}`);
      throw error;
    }
    
    // Step 2: Create orchestration task with pending AI actions
    console.log(`\n📋 Step 2: Creating orchestration task with AI actions pending...`);
    
    const orchestrationTask = {
      taskID: taskID,
      pending_tasks: ['ai_requested_actions'], // This is what triggers TradeOffer processing
      priority: 'high',
      execute: new Date().toISOString(), // Execute immediately
      created_at: new Date().toISOString(),
      context: negotiationContext
    };
    
    const addResult = await orchestrationQueue.addTask(orchestrationTask);
    if (!addResult) {
      throw new Error('Failed to add orchestration task');
    }
    
    console.log(`✅ Orchestration task created with pending AI actions`);
    
    // Step 3: Simulate what AIWorker would have done - create trade_offer_queue task
    console.log(`\n🤖 Step 3: Creating trade offer task (simulating AIWorker output)...`);
    
    const tradeOfferTask = {
      taskID: taskID,
      priority: 'high',
      action: 'createTradeOffer',
      params: negotiationContext.ai_requested_actions.actions_pending[0].params,
      action_id: negotiationContext.ai_requested_actions.actions_pending[0].action_id,
      created_at: new Date().toISOString(),
      execute: new Date().toISOString()
    };
    
    const tradeOfferResult = await tradeOfferQueue.addTask(tradeOfferTask);
    if (!tradeOfferResult) {
      throw new Error('Failed to add trade offer task');
    }
    
    console.log(`✅ Trade offer task created:`);
    console.log(`   🎯 Action: ${tradeOfferTask.action}`);
    console.log(`   📦 Items to give: ${tradeOfferTask.params.items_to_give.length}`);
    console.log(`   📥 Items to receive: ${tradeOfferTask.params.items_to_receive.length}`);
    
    // Step 4: Monitor the processing
    console.log(`\n🔄 Step 4: Monitoring worker processing...`);
    
    let monitoringRounds = 0;
    const maxRounds = 20; // 40 seconds max
    let tradeOfferProcessed = false;
    let orchestrationUpdated = false;
    
    while (monitoringRounds < maxRounds && (!tradeOfferProcessed || !orchestrationUpdated)) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      monitoringRounds++;
      
      console.log(`\n⏱️  Round ${monitoringRounds}: Checking progress...`);
      
      // Check trade_offer_queue status
      const remainingTradeOffers = await tradeOfferQueue.getTasks();
      const tradeOfferCount = remainingTradeOffers.length;
      
      if (tradeOfferCount === 0 && !tradeOfferProcessed) {
        console.log(`   ✅ TradeOfferWorker: Task processed and removed from queue`);
        tradeOfferProcessed = true;
      } else if (tradeOfferCount > 0) {
        console.log(`   ⏳ TradeOfferWorker: ${tradeOfferCount} task(s) still in queue`);
      }
      
      // Check orchestration task status  
      const orchestrationTasks = await orchestrationQueue.getTasks();
      const currentTask = orchestrationTasks.find(t => t.taskID === taskID);
      
      if (currentTask) {
        const pendingTasks = currentTask.pending_tasks || [];
        const hasAIActions = pendingTasks.includes('ai_requested_actions');
        
        console.log(`   📋 OrchestrationWorker: pending_tasks = [${pendingTasks.join(', ')}]`);
        
        if (!hasAIActions && !orchestrationUpdated && tradeOfferProcessed) {
          console.log(`   ✅ OrchestrationWorker: ai_requested_actions removed from pending_tasks`);
          orchestrationUpdated = true;
        }
        
        // Check if AI actions were updated in context
        if (currentTask.context?.ai_requested_actions) {
          const actionsCompleted = currentTask.context.ai_requested_actions.actions_completed || [];
          const actionsPending = currentTask.context.ai_requested_actions.actions_pending || [];
          
          console.log(`   🤖 AI actions - Pending: ${actionsPending.length}, Completed: ${actionsCompleted.length}`);
          
          if (actionsCompleted.length > 0) {
            console.log(`   ✅ Trade offer action moved to completed!`);
            const completedAction = actionsCompleted[0];
            console.log(`      📋 Action: ${completedAction.type}`);
            console.log(`      🎯 Result: ${completedAction.result || 'processing'}`);
            console.log(`      ⏰ Completed: ${completedAction.completed_at}`);
          }
        }
        
        // Check for trade offer in context
        if (currentTask.context?.trade_offers && currentTask.context.trade_offers.length > 0) {
          console.log(`   💼 Trade offers in context: ${currentTask.context.trade_offers.length}`);
          const latestOffer = currentTask.context.trade_offers[0];
          console.log(`      🆔 Trade Offer ID: ${latestOffer.trade_offer_id}`);
          console.log(`      📊 State: ${latestOffer.state_history?.[latestOffer.state_history.length - 1]?.state}`);
        }
        
      } else {
        console.log(`   📋 OrchestrationWorker: Task completed and removed`);
        orchestrationUpdated = true;
      }
      
      // Get worker statistics
      // const tradeOfferStats = tradeOfferWorker.getStats();
      // const orchestrationStats = orchestrationWorker.getStats();
      
      // console.log(`   📊 TradeOfferWorker: ${tradeOfferStats.tasksProcessed} processed, ${tradeOfferStats.errors} errors`);
      // console.log(`   📊 OrchestrationWorker: ${orchestrationStats.tasksProcessed} processed, ${orchestrationStats.errors} errors`);
    }
    
    // Step 5: Final results analysis
    // console.log(`\n📊 Step 5: Final Results Analysis`);
    
    // const finalTradeOfferStats = tradeOfferWorker.getStats();
    // const finalOrchestrationStats = orchestrationWorker.getStats();
    
    // console.log(`\n🏁 Final Statistics:`);
    // console.log(`   🔧 TradeOfferWorker:`);
    // console.log(`      ✅ Tasks processed: ${finalTradeOfferStats.tasksProcessed}`);
    // console.log(`      ❌ Errors: ${finalTradeOfferStats.errors}`);
    // console.log(`      ⏰ Last processed: ${finalTradeOfferStats.lastProcessedAt || 'never'}`);
    
    // console.log(`   🎯 OrchestrationWorker:`);
    // console.log(`      ✅ Tasks processed: ${finalOrchestrationStats.tasksProcessed}`);
    // console.log(`      ❌ Errors: ${finalOrchestrationStats.errors}`);
    // console.log(`      ⏰ Last processed: ${finalOrchestrationStats.lastProcessedAt || 'never'}`);
    
    // // Final state verification
    // const finalOrchestrationTasks = await orchestrationQueue.getTasks();
    // const finalTradeOfferTasks = await tradeOfferQueue.getTasks();
    
    // console.log(`\n🔍 Final State Verification:`);
    // console.log(`   📋 Orchestration queue: ${finalOrchestrationTasks.length} tasks remaining`);
    // console.log(`   💼 Trade offer queue: ${finalTradeOfferTasks.length} tasks remaining`);
    
    // const finalTask = finalOrchestrationTasks.find(t => t.taskID === taskID);
    // if (finalTask) {
    //   console.log(`   📄 Final orchestration task:`);
    //   console.log(`      🎯 Pending tasks: [${(finalTask.pending_tasks || []).join(', ')}]`);
    //   console.log(`      💼 Trade offers: ${finalTask.context?.trade_offers?.length || 0}`);
    //   console.log(`      🤖 AI actions completed: ${finalTask.context?.ai_requested_actions?.actions_completed?.length || 0}`);
    // }
    
    // // Success evaluation
    // const testSuccess = tradeOfferProcessed && (finalTradeOfferStats.tasksProcessed > 0);
    
    // console.log(`\n${testSuccess ? colors.green + '✅ TRADE OFFER TEST PASSED' : colors.red + '❌ TRADE OFFER TEST FAILED'}${colors.reset}`);
    
    // if (testSuccess) {
    //   console.log(`${colors.green}🎉 TradeOfferWorker successfully processed AI-requested trade offer creation!${colors.reset}`);
    // } else {
    //   console.log(`${colors.red}💥 TradeOfferWorker failed to process the trade offer task properly${colors.reset}`);
    // }
    
    // return {
    //   success: testSuccess,
    //   tradeOfferProcessed: tradeOfferProcessed,
    //   orchestrationUpdated: orchestrationUpdated,
    //   tradeOfferStats: finalTradeOfferStats,
    //   orchestrationStats: finalOrchestrationStats,
    //   finalPendingTasks: finalTask?.pending_tasks || [],
    //   tradeOffersCreated: finalTask?.context?.trade_offers?.length || 0
    // };
    
  } catch (error) {
    console.log(`\n${colors.red}❌ TradeOfferWorker test error: ${error.message}${colors.reset}`);
    if (error.stack) {
      console.log(`${colors.gray}${error.stack}${colors.reset}`);
    }
    throw error;
  } finally {
    // Stop workers
    console.log(`\n🛑 Stopping workers...`);
    await tradeOfferWorker.stop();
    await orchestrationWorker.stop();
    
    console.log(`✅ All workers stopped`);
  }
}

/**
 * Main test function
 */
async function runRealDataTest() {
  // console.log(`${colors.magenta}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
  // console.log(`${colors.magenta}║              Real Negotiation Data Test                     ║${colors.reset}`);
  // console.log(`${colors.magenta}║    Testing OrchestrationWorker with Real JSON Data          ║${colors.reset}`);
  // console.log(`${colors.magenta}╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
  
  const orchestrationQueue = new QueueManager('orchestration_queue', testConfig, mockLogger);
  
  try {
    // // Prerequisites check
    // console.log(`\n📋 TEST SETUP:`);
    // console.log(`   📁 Using negotiation JSON: ../data/negotiations/76561198000000001.json`);
    // console.log(`   🤝 Friend Steam ID: 76561198000000601`);
    // console.log(`   📦 Expected inventory: Prisma Case (5x), Fracture Case (3x)`);
    // console.log(`   💰 Expected total value: $0.27 < $2.00 threshold`);
    // console.log(`   🎯 Expected objective: request_cases_as_gift`);
    // console.log(`   📝 Expected decision: create language_detection task`);
    
    // // Create and run scenarios
    // const scenarios = createRealDataScenarios();
    // const results = [];
    
    // for (const scenario of scenarios) {
    //   const result = await processRealDataScenario(scenario, orchestrationQueue);
    //   results.push({
    //     name: scenario.name,
    //     result: result
    //   });
      
    //   // Small delay between scenarios
    //   await new Promise(resolve => setTimeout(resolve, 500));
    // }
    
    // // Summary
    // console.log(`\n${colors.magenta}╔══════════════════════════════════════════════════════════════╗${colors.reset}`);
    // console.log(`${colors.magenta}║                        TEST SUMMARY                         ║${colors.reset}`);
    // console.log(`${colors.magenta}╚══════════════════════════════════════════════════════════════╝${colors.reset}`);
    
    // let passCount = 0;
    // let totalCount = results.length;
    
    // results.forEach(({ name, result }) => {
    //   const status = result.success ? `${colors.green}✅ PASS` : `${colors.red}❌ FAIL`;
    //   console.log(`${status}${colors.reset} ${name}`);
    //   if (result.success) passCount++;
      
    //   if (!result.success && result.error) {
    //     console.log(`     ${colors.red}Error: ${result.error}${colors.reset}`);
    //   }
    // });
    
    // console.log(`\n📊 Results: ${passCount}/${totalCount} tests passed`);
    
    // if (passCount === totalCount) {
    //   console.log(`${colors.green}🎉 All tests passed! The objective setting logic is working correctly.${colors.reset}`);
    // } else {
    //   console.log(`${colors.red}❌ Some tests failed. Check the objective setting and persistence logic.${colors.reset}`);
    // }

    // Run worker interaction test
    console.log(`\n${colors.cyan}Running worker interaction tests...${colors.reset}`);
    await testWorkerInteraction();

    // Run FollowUpWorker flow test
    // console.log(`${colors.cyan}Running FollowUpWorker flow test...${colors.reset}`);
    // await testFollowUpWorkerFlow();

    // Run TradeOfferWorker flow test
    // console.log(`\n${colors.cyan}3/3 Testing TradeOfferWorker Flow...${colors.reset}`);
    // await testTradeOfferWorkerFlow();
    
  } catch (error) {
    console.log(`\n${colors.red}❌ Test setup error: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

// Main execution
if (require.main === module) {
  runRealDataTest().then(() => {
    console.log('\n✨ Test completed.');
  }).catch(error => {
    console.error(`\n💥 Test failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  runRealDataTest,
  testWorkerInteraction,
  createRealDataScenarios,
  testFollowUpWorkerFlow,
  testTradeOfferWorkerFlow,
  processRealDataScenario
};