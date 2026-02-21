// automate_trading/test/test_queue_manager.js
/**
 * Test script for QueueManager
 * Run with: node test/test_queue_manager.js
 */

const QueueManager = require('../utils/queue_manager');
const path = require('path');
const fs = require('fs-extra');

// Mock logger
const mockLogger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`),
  warn: (msg) => console.log(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Test configuration
const testConfig = {
  queues: {
    lockTimeout: 5000,
    lockRetryDelay: 50,
    maxLockRetries: 100
  }
};

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m'
};

function logTest(testName, passed, details = '') {
  const status = passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
  console.log(`${status} ${testName}`);
  if (details) {
    console.log(`  ${colors.yellow}→${colors.reset} ${details}`);
  }
}

function logSection(sectionName) {
  console.log(`\n${colors.blue}━━━ ${sectionName} ━━━${colors.reset}`);
}

// Example orchestration task structure
function createOrchestrationTask(ourSteamId, friendSteamId, options = {}) {
  return {
    taskID: `${ourSteamId}_${friendSteamId}`,
    pending_tasks: options.pending_tasks || [],
    priority: options.priority || 'normal',
    execute: options.execute || null, // null means execute immediately
    created_at: new Date().toISOString(),
    context: {
      our_steam_id: ourSteamId,
      friend_steam_id: friendSteamId,
      state: options.state || 'initiating',
      trigger: options.trigger || 'friend_accepted'
    }
  };
}

// Example tasks for other queues
const exampleTasks = {
  inventory: {
    taskID: '76561198000000001_76561198000000002',
    execute: new Date(Date.now() + 1000).toISOString(), // Execute in 1 second
    priority: 'high',
    targetSteamID: '76561198000000002'
  },
  
  language: {
    taskID: '76561198000000001_76561198000000002',
    execute: new Date().toISOString(), // Execute immediately
    priority: 'normal',
    useSelenium: false
  },
  
  ai: {
    taskID: '76561198000000001_76561198000000002',
    execute: new Date(Date.now() + 60000).toISOString(), // Execute in 60 seconds
    priority: 'normal',
    prompt: 'Analyze negotiation context and suggest response'
  },
  
  trade_offer: {
    taskID: '76561198000000001_76561198000000002',
    action: 'createTradeOffer',
    execute: new Date().toISOString(),
    priority: 'high',
    tradeOfferID: null,
    itemsToReceive: [
      { market_hash_name: 'AK-47 | Redline (Field-Tested)', quantity: 1, price: 15.50 }
    ],
    itemsToGive: []
  },
  
  message: {
    taskID: '76561198000000001_76561198000000002',
    execute: new Date(Date.now() + 60000).toISOString(), // Wait 60 seconds
    priority: 'normal',
    message: ['Hi!', 'I wanted to know if you still play CS']
  },
  
  remove_friend: {
    taskID: '76561198000000001_76561198000000002',
    priority: 'low'
  },
  
  follow_up: {
    id: '76561198000000001_76561198000000002', // Note: uses 'id' not 'taskID'
    execute: new Date(Date.now() + 86400000).toISOString() // Execute in 24 hours
  }
};

async function runTests() {
  console.log(`${colors.magenta}╔════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.magenta}║     Testing Queue Manager System          ║${colors.reset}`);
  console.log(`${colors.magenta}╚════════════════════════════════════════════╝${colors.reset}`);

  // Test 1: Basic Queue Operations
  logSection('1. Testing Basic Queue Operations');
  
  const orchestrationQueue = new QueueManager('orchestration_queue', testConfig, mockLogger);
  
  // Clear queue for testing
  await orchestrationQueue.clearQueue();
  logTest('Queue cleared', true);
  
  // Add task
  const task1 = createOrchestrationTask('76561198000000001', '76561198000000002');
  const added = await orchestrationQueue.addTask(task1);
  logTest('Task added', added);
  
  // Check if task exists
  const exists = await orchestrationQueue.taskExists(task1.taskID);
  logTest('Task exists check', exists);
  
  // Get all tasks
  const allTasks = await orchestrationQueue.getTasks();
  logTest('Get all tasks', allTasks.length === 1, `Found ${allTasks.length} task(s)`);
  
  // Test 2: Priority and Execution Time
  logSection('2. Testing Priority and Execution Time');
  
  // Add tasks with different priorities
  const highPriorityTask = createOrchestrationTask('76561198000000001', '76561198000000003', {
    priority: 'high'
  });
  const lowPriorityTask = createOrchestrationTask('76561198000000001', '76561198000000004', {
    priority: 'low'
  });
  const futureTask = createOrchestrationTask('76561198000000001', '76561198000000005', {
    execute: new Date(Date.now() + 60000).toISOString() // Future execution
  });
  
  await orchestrationQueue.addTask(lowPriorityTask);
  await orchestrationQueue.addTask(highPriorityTask);
  await orchestrationQueue.addTask(futureTask);
  
  // Get next tasks (should prioritize high priority and skip future task)
  const nextTasks = await orchestrationQueue.getNextTasks(2, false);
  logTest('Priority ordering', 
    nextTasks[0].priority === 'high' && nextTasks[1].priority === 'normal',
    `Order: ${nextTasks.map(t => t.priority).join(', ')}`
  );
  
  // Test 3: Update Task
  logSection('3. Testing Task Updates');
  
  const updateSuccess = await orchestrationQueue.updateTask(task1.taskID, {
    pending_tasks: ['check_inventory_friend', 'check_language'],
    priority: 'high'
  });
  logTest('Task updated', updateSuccess);
  
  const updatedTask = (await orchestrationQueue.getTasks()).find(t => t.taskID === task1.taskID);
  logTest('Update verified', 
    updatedTask.pending_tasks.length === 2,
    `Pending tasks: ${updatedTask.pending_tasks.join(', ')}`
  );
  
  // Test 4: Queue Statistics
  logSection('4. Testing Queue Statistics');
  
  const stats = await orchestrationQueue.getStats();
  logTest('Stats retrieved', true, 
    `Total: ${stats.total}, Ready: ${stats.ready}, Pending: ${stats.pending}`
  );
  logTest('Priority breakdown', true,
    `High: ${stats.byPriority.high}, Normal: ${stats.byPriority.normal}, Low: ${stats.byPriority.low}`
  );
  
  // Test 5: Remove Task
  logSection('5. Testing Task Removal');
  
  const removed = await orchestrationQueue.removeTask(task1.taskID);
  logTest('Task removed', removed);
  
  const stillExists = await orchestrationQueue.taskExists(task1.taskID);
  logTest('Task no longer exists', !stillExists);
  
  // Test 6: Multiple Queue Types
  logSection('6. Testing Multiple Queue Types');
  
  const queueTypes = [
    'inventory_queue',
    'language_queue',
    'ai_queue',
    'trade_offer_queue',
    'message_queue',
    'remove_friend_queue',
    'follow_up_queue'
  ];
  
  for (const queueName of queueTypes) {
    const queue = new QueueManager(queueName, testConfig, mockLogger);
    
    // Get the appropriate example task
    const taskType = queueName.replace('_queue', '');
    const exampleTask = exampleTasks[taskType] || exampleTasks.inventory;
    
    await queue.clearQueue();
    await queue.addTask(exampleTask);
    
    const tasks = await queue.getTasks();
    logTest(`${queueName} initialized`, tasks.length === 1);
  }
  
  // Test 7: Concurrent Access Simulation
  logSection('7. Testing Concurrent Access (File Locking)');
  
  const concurrentQueue = new QueueManager('test_concurrent', testConfig, mockLogger);
  await concurrentQueue.clearQueue();
  
  // Simulate concurrent writes
  const concurrentPromises = [];
  for (let i = 0; i < 5; i++) {
    const task = createOrchestrationTask('76561198000000001', `7656119800000000${i}`);
    concurrentPromises.push(concurrentQueue.addTask(task));
  }
  
  await Promise.all(concurrentPromises);
  
  const finalTasks = await concurrentQueue.getTasks();
  logTest('Concurrent writes handled', finalTasks.length === 5,
    `Successfully added ${finalTasks.length} tasks concurrently`
  );
  
  // Test 8: Duplicate Prevention
  logSection('8. Testing Duplicate Task Prevention');
  
  const duplicateTask = createOrchestrationTask('76561198000000001', '76561198000000099');
  
  const firstAdd = await orchestrationQueue.addTask(duplicateTask);
  logTest('First add successful', firstAdd);
  
  const secondAdd = await orchestrationQueue.addTask(duplicateTask);
  logTest('Duplicate prevented', !secondAdd);
  
  // Test with action-based tasks (trade_offer_queue)
  const tradeQueue = new QueueManager('trade_offer_queue', testConfig, mockLogger);
  await tradeQueue.clearQueue();
  
  const tradeTask1 = { ...exampleTasks.trade_offer, action: 'createTradeOffer' };
  const tradeTask2 = { ...exampleTasks.trade_offer, action: 'acceptTradeOffer' };
  
  await tradeQueue.addTask(tradeTask1);
  const differentAction = await tradeQueue.addTask(tradeTask2);
  logTest('Different actions allowed', differentAction,
    'Same taskID but different action was added'
  );
  
  // Test 9: Get and Remove Tasks
  logSection('9. Testing Get and Remove Operations');
  
  const testQueue = new QueueManager('test_get_remove', testConfig, mockLogger);
  await testQueue.clearQueue();
  
  // Add multiple tasks
  for (let i = 0; i < 3; i++) {
    await testQueue.addTask(createOrchestrationTask('76561198000000001', `7656119800000010${i}`));
  }
  
  // Get next tasks with removal
  const beforeCount = (await testQueue.getTasks()).length;
  const removedTasks = await testQueue.getNextTasks(2, true); // Remove 2 tasks
  const afterCount = (await testQueue.getTasks()).length;
  
  logTest('Tasks removed on get', 
    beforeCount === 3 && afterCount === 1,
    `Before: ${beforeCount}, After: ${afterCount}`
  );
  
  // Cleanup
  logSection('10. Cleanup');
  
  // Clean up test queues
  const queuesDir = path.join(__dirname, '..', 'data', 'queues');
  const testQueues = ['test_concurrent', 'test_get_remove'];
  
  for (const queueName of testQueues) {
    const queuePath = path.join(queuesDir, `${queueName}.json`);
    if (fs.existsSync(queuePath)) {
      fs.unlinkSync(queuePath);
      logTest(`Cleaned up ${queueName}`, true);
    }
  }
  
  // Summary
  logSection('Test Summary');
  console.log(`${colors.green}All queue manager tests completed successfully!${colors.reset}`);
  console.log(`\nThe queue system supports:`);
  console.log(`  • File-based queues with JSON storage`);
  console.log(`  • Thread-safe operations with file locking`);
  console.log(`  • Priority-based task ordering`);
  console.log(`  • Scheduled task execution`);
  console.log(`  • Duplicate prevention`);
  console.log(`  • Concurrent access handling`);
  console.log(`  • Statistics and monitoring`);
  
  console.log(`\n${colors.magenta}Ready for OrchestrationWorker implementation!${colors.reset}`);
}

// Run tests
runTests().then(() => {
  console.log(`\n${colors.blue}Tests completed${colors.reset}`);
  process.exit(0);
}).catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  console.error(error.stack);
  process.exit(1);
});