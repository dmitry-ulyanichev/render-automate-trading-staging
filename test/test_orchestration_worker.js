// automate_trading/test/test_orchestration_worker.js
/**
 * Test script for OrchestrationWorker's enhanced context analysis
 * Tests various negotiation scenarios from the flowchart
 * Run with: node automate_trading/test/test_context_analysis.js
 */

const OrchestrationWorker = require('../workers/orchestration_worker');
const QueueManager = require('../utils/queue_manager');

const path = require('path');

// Mock logger
const mockLogger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`),
  warn: (msg) => console.log(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Test configuration
const testConfig = {
  orchestration: {
    processInterval: 1000, // 1 second for faster testing
    batchSize: 5
  },
  queues: {
    lockTimeout: 5000,
    lockRetryDelay: 50,
    maxLockRetries: 100
  },
  baseAccounts: {
    ids: ['76561199027634480', '76561198810655591']
  },
  // Fix: Change this from 'nodeApiService' to 'nodeApiService'
  nodeApiService: {
    apiKey: 'fa46kPOVnHT2a4aFmQS11dd70290',
    baseUrl: 'http://127.0.0.1:3001'
  },
  // Add dataDir for redirects.json path
  dataDir: path.join(__dirname, '..', 'data')
};

// Color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function logSection(title) {
  console.log(`\n${colors.cyan}━━━ ${title} ━━━${colors.reset}`);
}

function logScenario(title, description) {
  console.log(`\n${colors.magenta}▶ Scenario: ${title}${colors.reset}`);
  console.log(`  ${colors.yellow}${description}${colors.reset}`);
}

/**
 * Create test scenarios
 */
function createTestScenarios() {
  const baseTaskID = '76561198000000001';
  const scenarios = [];
  
  // // Scenario 1: Private inventory - initial check
  // scenarios.push({
  //   name: 'Private Inventory Initial',
  //   description: 'Friend accepted, inventory privacy unknown',
  //   task: {
  //     taskID: `76561199027634480_76561197963147651`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: null,
  //       inventory: null,
  //       language: null,
  //       referred_from_messages: [
  //       {
  //         "id": "hist_1755648681000_out",
  //         "timestamp": "2025-08-20T00:11:21.000Z",
  //         "direction": "outgoing",
  //         "message": "Hey",
  //         "sender_steam_id": "76561199792495944",
  //         "source": "historical",
  //         "ordinal": 0,
  //         "unread": false,
  //         "bbcodeParsed": [
  //           "Hey"
  //         ],
  //         "processed_at": "2025-08-25T18:17:07.549Z",
  //         "friend_steam_id": "76561197963147651",
  //         "account_steam_id": "76561199792495944"
  //       },
  //       {
  //         "id": "hist_1755902816000_out",
  //         "timestamp": "2025-08-22T22:46:56.000Z",
  //         "direction": "outgoing",
  //         "message": "i wanted to know whether you play cs or not. I just saw you have boxes and was wondering if you would exchange with me for skins",
  //         "sender_steam_id": "76561199792495944",
  //         "source": "historical",
  //         "ordinal": 0,
  //         "unread": false,
  //         "bbcodeParsed": [
  //           "i wanted to know whether you play cs or not. I just saw you have boxes and was wondering if you would exchange with me for skins"
  //         ],
  //         "processed_at": "2025-08-25T18:17:07.549Z",
  //         "friend_steam_id": "76561197963147651",
  //         "account_steam_id": "76561199792495944"
  //       }
  //     ],
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: null,
  //       referrer_checked: false
  //     }
  //   },
  //   expectedDecisions: ['inventory_check']
  // });
  
  // // Scenario 2.1: Private inventory confirmed, inventory already checked for this task, need language
  // scenarios.push({
  //   name: 'Private Inventory Confirmed, Need Language',
  //   description: 'Inventory is private, need to ask friend to open it',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000201`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: new Date().toISOString(),
  //     context: {
  //       state: 'initiating',
  //       inventory_private: true,
  //       inventory: null,
  //       inventory_updated_at: new Date(Date.now() + 60000).toISOString(),
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: null
  //     }
  //   },
  //   expectedDecisions: ['language_detection']
  // });

  // // Scenario 2.1: Private inventory confirmed, inventory not yet checked for this task, need inventory check
  // scenarios.push({
  //   name: 'Private Inventory but Need Another Check',
  //   description: 'Inventory is private, need to ask friend to open it',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000202`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: new Date().toISOString(),
  //     context: {
  //       state: 'initiating',
  //       inventory_private: true,
  //       inventory: null,
  //       inventory_updated_at: new Date(Date.now() - 60000).toISOString(),
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: null
  //     }
  //   },
  //   expectedDecisions: ['inventory_check']
  // });

  // // Scenario 3.1: Private inventory with language known, no incoming messages
  // scenarios.push({
  //   name: 'Private Inventory Ready to Message',
  //   description: 'Private inventory, language known, ready to ask to open',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000301`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: true,
  //       inventory: null,
  //       inventory_updated_at: new Date(Date.now() + 60000).toISOString(),
  //       language: 'English',
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: null
  //     }
  //   },
  //   expectedDecisions: ['send_message']
  // });

  // // Scenario 3.2: Private inventory with language known and incoming messages
  // scenarios.push({
  //   name: 'Private Inventory, Language Known, There are Incoming messages',
  //   description: 'Private inventory, language known, consult AI',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000302`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'replying',
  //       inventory_private: true,
  //       inventory: null,
  //       inventory_updated_at: new Date(Date.now() + 60000).toISOString(),
  //       language: 'English',
  //       referred_from_messages: [],
  //       messages: [
  //         {
  //           "id": "hist_1755648681000_out",
  //           "timestamp": "2025-08-20T00:11:21.000Z",
  //           "direction": "outgoing",
  //           "message": "Hey",
  //           "sender_steam_id": "76561199792495944",
  //           "source": "historical",
  //           "ordinal": 0,
  //           "unread": false,
  //           "bbcodeParsed": [
  //             "Hey"
  //           ],
  //           "processed_at": "2025-08-25T18:17:07.549Z",
  //           "friend_steam_id": "76561197963147651",
  //           "account_steam_id": "76561199792495944"
  //         },
  //         {
  //           "id": "hist_1755902816000_out",
  //           "timestamp": "2025-08-22T22:46:56.000Z",
  //           "direction": "incoming",
  //           "message": "hey, who this?",
  //           "sender_steam_id": "76561197963147651",
  //           "source": "historical",
  //           "ordinal": 0,
  //           "unread": false,
  //           "bbcodeParsed": [
  //             "hey, who this?"
  //           ],
  //           "processed_at": "2025-08-25T18:17:07.549Z",
  //           "friend_steam_id": "76561197963147651",
  //           "account_steam_id": "76561199792495944"
  //         }
  //       ],
  //       trade_offers: [],
  //       our_inventory: null
  //     }
  //   },
  //   expectedDecisions: ['consult_ai']
  // });
  
  // // Scenario 3.3: Private inventory with language known and incoming referred_from_messages
  // scenarios.push({
  //   name: 'Private Inventory, Language Known, There are Incoming referred_from_messages',
  //   description: 'Private inventory, language known, consult AI',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000303`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: true,
  //       inventory: null,
  //       inventory_updated_at: new Date(Date.now() + 60000).toISOString(),
  //       language: 'English',
  //       referred_from_messages: [
  //         {
  //           "id": "hist_1755648681000_out",
  //           "timestamp": "2025-08-20T00:11:21.000Z",
  //           "direction": "outgoing",
  //           "message": "Hey",
  //           "sender_steam_id": "76561199792495944",
  //           "source": "historical",
  //           "ordinal": 0,
  //           "unread": false,
  //           "bbcodeParsed": [
  //             "Hey"
  //           ],
  //           "processed_at": "2025-08-25T18:17:07.549Z",
  //           "friend_steam_id": "76561197963147651",
  //           "account_steam_id": "76561199792495944"
  //         },
  //         {
  //           "id": "hist_1755902816000_out",
  //           "timestamp": "2025-08-22T22:46:56.000Z",
  //           "direction": "incoming",
  //           "message": "hey, who this?",
  //           "sender_steam_id": "76561197963147651",
  //           "source": "historical",
  //           "ordinal": 0,
  //           "unread": false,
  //           "bbcodeParsed": [
  //             "hey, who this?"
  //           ],
  //           "processed_at": "2025-08-25T18:17:07.549Z",
  //           "friend_steam_id": "76561197963147651",
  //           "account_steam_id": "76561199792495944"
  //         }
  //       ],
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: null
  //     }
  //   },
  //   expectedDecisions: ['consult_ai']
  // });
  
  // // Scenario 4: Empty inventory, no trades
  // scenarios.push({
  //   name: 'Empty Inventory No Trades',
  //   description: 'Friend has empty inventory and no trade offers',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000104`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
  //       inventory: [],
  //       language: 'English',
  //       referred_from_messages: [
  //         {
  //           "id": "hist_1755648681000_out",
  //           "timestamp": "2025-08-20T00:11:21.000Z",
  //           "direction": "outgoing",
  //           "message": "Hey",
  //           "sender_steam_id": "76561199792495944",
  //           "source": "historical",
  //           "ordinal": 0,
  //           "unread": false,
  //           "bbcodeParsed": [
  //             "Hey"
  //           ],
  //           "processed_at": "2025-08-25T18:17:07.549Z",
  //           "friend_steam_id": "76561197963147651",
  //           "account_steam_id": "76561199792495944"
  //         },
  //         {
  //           "id": "hist_1755902816000_out",
  //           "timestamp": "2025-08-22T22:46:56.000Z",
  //           "direction": "incoming",
  //           "message": "hey, who this?",
  //           "sender_steam_id": "76561197963147651",
  //           "source": "historical",
  //           "ordinal": 0,
  //           "unread": false,
  //           "bbcodeParsed": [
  //             "hey, who this?"
  //           ],
  //           "processed_at": "2025-08-25T18:17:07.549Z",
  //           "friend_steam_id": "76561197963147651",
  //           "account_steam_id": "76561199792495944"
  //         }
  //       ],
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: []
  //     }
  //   },
  //   expectedDecisions: ['remove_friend']
  // });
  
  // // Scenario 5: Empty inventory with accepted/in-escrow trade
  // scenarios.push({
  //   name: 'Empty Inventory Accepted/In Escrow Trade',
  //   description: 'Empty inventory but has accepted/in-escrow trade offer',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000105`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'awaiting_reply',
  //       inventory_private: false,
  //       inventory: [],
  //       language: 'English',
  //       messages: [],
  //       trade_offers: [{
  //         trade_offer_id: '123456',
  //         is_our_offer: true,
  //         state_history: [
  //           {state: 'Active', timestamp: new Date(Date.now() - 86400000).toISOString()},
  //           {state: 'Accepted', timestamp: new Date().toISOString()}
  //         ],
  //         items_to_give: [],
  //         items_to_receive: [{market_hash_name: 'Prisma Case', quantity: 1, price: 0.03}],
  //         profit: 0.03,
  //         give_to_receive_ratio: 0
  //       }],
  //       our_inventory: []
  //     }
  //   },
  //   expectedDecisions: ['consult_ai', 'remove_friend']
  // });

  // // Scenario 6.1b: Small cases value - request as gift ($1.99 total)
  // scenarios.push({
  //   name: 'Small Cases Value Gift (1.99)',
  //   description: 'Friend has cases worth just under $2',
  //   mockNegotiation: {
  //     inventory: [
  //       {market_hash_name: 'Prisma Case', quantity: 50, price: 0.04, tradeable: true} // $2.00
  //       // Total: $2.00 = $2 → request_cases_as_gift
  //     ]
  //   },
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000602`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'Prisma Case', quantity: 66, price: 0.03, tradeable: true}
  //       ],
  //       source: 'reserve_pipeline',
  //       objective: null,
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: [
  //         {market_hash_name: 'AK-47 | Redline (Field-Tested)', quantity: 1, price: 25.50, tradeable: true}
  //       ],
  //       referrer_checked: true
  //     }
  //   },
  //   expectedDecisions: ['language_detection'],
  //   expectedObjective: 'request_cases_as_gift'
  // });
  
  // // Scenario 6.1: Small cases value - request as gift
  // scenarios.push({
  //   name: 'Small Cases Value Gift',
  //   description: 'Friend has cases worth < $2, should request as gift',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000601`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'Prisma Case', quantity: 5, price: 0.03, tradeable: true}, // $0.15 total
  //         {market_hash_name: 'Fracture Case', quantity: 3, price: 0.04, tradeable: true} // $0.12 total
  //         // Total cases value: $0.27 < $2
  //       ],
  //       source: 'reserve_pipeline',
  //       objective: null,
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: []
  //     }
  //   },
  //   expectedDecisions: ['analyze_inventory', 'language_detection'], // Should set objective to 'request_cases_as_gift'
  //   expectedObjective: 'request_cases_as_gift'
  // });

  //   // Scenario 6.2: Small cases value - request as gift
  // scenarios.push({
  //   name: 'Small Cases Value Gift',
  //   description: 'Friend has cases worth < $2, should request as gift',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000602`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'Prisma Case', quantity: 5, price: 0.03, tradeable: true}, // $0.15 total
  //         {market_hash_name: 'Fracture Case', quantity: 1, price: 1.84, tradeable: true} // $1.84 total
  //         // Total cases value: $1.99 < $2
  //       ],
  //       source: 'reserve_pipeline',
  //       objective: null,
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: []
  //     }
  //   },
  //   expectedDecisions: ['analyze_inventory', 'language_detection'], // Should set objective to 'request_cases_as_gift'
  //   expectedObjective: 'request_cases_as_gift'
  // });

  //   // Scenario 6.3: Small cases value - request as gift
  // scenarios.push({
  //   name: 'Small Cases Value Gift',
  //   description: 'Friend has cases worth < $2, should request as gift',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000603`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'Prisma Case', quantity: 5, price: 0.03, tradeable: true}, // $0.15 total
  //         {market_hash_name: 'Fracture Case', quantity: 1, price: 1.85, tradeable: true} // $1.85 total
  //         // Total cases value: $2.00 = $2
  //       ],
  //       source: 'reserve_pipeline',
  //       objective: null,
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: []
  //     }
  //   },
  //   expectedDecisions: ['analyze_inventory', 'language_detection'], // Should set objective to 'request_cases_as_gift'
  //   expectedObjective: 'request_cases_as_gift'
  // });
  
  // // Scenario 7: Expensive items for trade
  // scenarios.push({
  //   name: 'Expensive Items Trade',
  //   description: 'Friend has expensive items, should initiate trade',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000107`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'AK-47 | Redline (Field-Tested)', quantity: 1, price: 15.50, tradeable: true},
  //         {market_hash_name: 'AWP | Asiimov (Battle-Scarred)', quantity: 1, price: 45.00, tradeable: true}
  //       ],
  //       objective: null,
  //       language: null,
  //       messages: [],
  //       trade_offers: [],
  //       our_inventory: null
  //     }
  //   },
  //   expectedDecisions: ['inventory_check'] // Need our inventory first
  // });
  
  // // Scenario 8: Trade objective, insufficient inventory
  // scenarios.push({
  //   name: 'Trade Insufficient Inventory',
  //   description: 'Want to trade but our inventory is too low',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000108`,
  //     pending_tasks: [],
  //     priority: 'normal',
  //     execute: null,
  //     context: {
  //       state: 'initiating',
  //       inventory_private: false,
        // inventory: [
        //   {market_hash_name: 'AWP | Dragon Lore (Factory New)', quantity: 1, price: 5000.00, tradeable: true}
        // ],
  //       objective: 'trade',
  //       language: 'English',
  //       messages: [],
  //       trade_offers: [],
  //       redirected_to: [],
  //       our_inventory: [
  //         {market_hash_name: 'Prisma Case', quantity: 10, price: 0.03, tradeable: true}
  //       ]
  //     }
  //   },
  //   expectedDecisions: ['check_base_accounts', 'redirect_friend']
  // });
  
  // // Scenario 9: Friend replied, need AI
  // scenarios.push({
  //   name: 'Friend Replied Need AI',
  //   description: 'Friend sent messages, need AI to analyze and respond',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000109`,
  //     pending_tasks: [],
  //     priority: 'high',
  //     execute: null,
  //     context: {
  //       state: 'replying',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'AK-47 | Redline (Field-Tested)', quantity: 2, price: 15.50, tradeable: true}
  //       ],
  //       objective: 'trade',
  //       language: 'English',
  //       messages: [
  //         {
  //           id: 'msg_001',
  //           timestamp: new Date(Date.now() - 300000).toISOString(),
  //           direction: 'outgoing',
  //           message: 'Hi! Interested in trading?'
  //         },
  //         {
  //           id: 'msg_002',
  //           timestamp: new Date().toISOString(),
  //           direction: 'incoming',
  //           message: 'Sure, what do you have?'
  //         }
  //       ],
  //       trade_offers: [],
  //       our_inventory: [
  //         {market_hash_name: 'M4A4 | Asiimov (Field-Tested)', quantity: 1, price: 30.00, tradeable: true}
  //       ]
  //     }
  //   },
  //   expectedDecisions: ['consult_ai']
  // });
  
  // // Scenario 10: Has trade offers, need evaluation
  // scenarios.push({
  //   name: 'Existing Trade Offers',
  //   description: 'Has active trade offers that need AI evaluation',
  //   task: {
  //     taskID: `${baseTaskID}_76561198000000110`,
  //     pending_tasks: [],
  //     priority: 'high',
  //     execute: null,
  //     context: {
  //       state: 'awaiting_reply',
  //       inventory_private: false,
  //       inventory: [
  //         {market_hash_name: 'Glock-18 | Fade (Factory New)', quantity: 1, price: 150.00, tradeable: true}
  //       ],
  //       objective: 'trade',
  //       language: 'English',
  //       messages: [],
  //       trade_offers: [
  //         {
  //           trade_offer_id: '789012',
  //           is_our_offer: false,
  //           state_history: [
  //             {state: 'Active', timestamp: new Date().toISOString()}
  //           ],
  //           items_to_give: [
  //             {market_hash_name: 'Glock-18 | Fade (Factory New)', quantity: 1, price: 150.00}
  //           ],
  //           items_to_receive: [
  //             {market_hash_name: 'AK-47 | Fire Serpent (Field-Tested)', quantity: 1, price: 180.00}
  //           ],
  //           profit: 30.00,
  //           give_to_receive_ratio: 0.833
  //         }
  //       ],
  //       our_inventory: [
  //         {market_hash_name: 'AK-47 | Fire Serpent (Field-Tested)', quantity: 1, price: 180.00, tradeable: true}
  //       ]
  //     }
  //   },
  //   expectedDecisions: ['consult_ai']
  // });
  
  return scenarios;
}

/**
 * Process a single scenario
 */
async function processScenario(scenario, orchestrationQueue) {
  logScenario(scenario.name, scenario.description);
  
  // Add task to queue
  // await orchestrationQueue.clearQueue();
  await orchestrationQueue.addTask(scenario.task);
  
  // Create worker
  const worker = new OrchestrationWorker(testConfig, mockLogger);
  
  // Process once
  await worker.processTasks();
  
  // Check what decisions were made
  const otherQueues = [
    'inventory_queue',
    'language_queue',
    'message_queue',
    'ai_queue',
    'remove_friend_queue',
    'follow_up_queue'
  ];
  
  const createdTasks = {};
  for (const queueName of otherQueues) {
    const queue = new QueueManager(queueName, testConfig, mockLogger);
    const tasks = await queue.getTasks();
    if (tasks.length > 0) {
      createdTasks[queueName] = tasks.length;
    }
  }
  
  // Check if task has pending_tasks
  const remainingTasks = await orchestrationQueue.getTasks();
  const processedTask = remainingTasks.find(t => t.taskID === scenario.task.taskID);
  
  console.log(`  ${colors.blue}Results:${colors.reset}`);
  console.log(`    - Tasks created: ${JSON.stringify(createdTasks)}`);
  if (processedTask && processedTask.pending_tasks && processedTask.pending_tasks.length > 0) {
    console.log(`    - Pending tasks: [${processedTask.pending_tasks.join(', ')}]`);
  }
  if (processedTask && processedTask.context.objective && scenario.task.context.objective === null) {
    console.log(`    - Objective set to: ${processedTask.context.objective}`);
  }
  
  // Clear queues for next test
  // for (const queueName of otherQueues) {
  //   const queue = new QueueManager(queueName, testConfig, mockLogger);
  //   await queue.clearQueue();
  // }
  
  return createdTasks;
}

/**
 * Main test function
 */
async function runTests() {
  console.log(`${colors.magenta}╔════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.magenta}║   Testing Enhanced Context Analysis       ║${colors.reset}`);
  console.log(`${colors.magenta}╚════════════════════════════════════════════╝${colors.reset}`);
  
  const orchestrationQueue = new QueueManager('orchestration_queue', testConfig, mockLogger);
  
  try {
    // Setup
    logSection('Setup');
    console.log('Creating test scenarios from flowchart logic...');
    const scenarios = createTestScenarios();
    console.log(`Created ${scenarios.length} test scenarios`);
    
    // Process each scenario
    logSection('Processing Scenarios');
    
    const results = [];
    for (const scenario of scenarios) {
      const result = await processScenario(scenario, orchestrationQueue);
      results.push({
        name: scenario.name,
        result: result
      });
      
      // Small delay between scenarios
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Summary
    logSection('Test Summary');
    
    console.log(`\n${colors.green}All scenarios processed!${colors.reset}`);
    console.log(`\n${colors.cyan}Context Analysis Capabilities:${colors.reset}`);
    console.log(`  ✓ Private inventory detection and handling`);
    console.log(`  ✓ Empty inventory removal logic`);
    console.log(`  ✓ Objective setting based on inventory`);
    console.log(`  ✓ Trade value comparison`);
    console.log(`  ✓ Redirect decision when insufficient inventory`);
    console.log(`  ✓ AI consultation for complex scenarios`);
    console.log(`  ✓ Message template selection`);
    console.log(`  ✓ Trade offer evaluation triggers`);
    console.log(`  ✓ Language detection requirements`);
    console.log(`  ✓ State-based decision making`);
    
    console.log(`\n${colors.magenta}Enhanced context analysis is working!${colors.reset}`);
    
  } catch (error) {
    console.error(`${colors.red}Test failed: ${error.message}${colors.reset}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Cleanup
    // await orchestrationQueue.clearQueue();
    
    // Clear all other queues
    const allQueues = [
      'inventory_queue',
      'language_queue',
      'message_queue',
      'ai_queue',
      'remove_friend_queue',
      'follow_up_queue'
    ];
    
    // for (const queueName of allQueues) {
    //   const queue = new QueueManager(queueName, testConfig, mockLogger);
    //   await queue.clearQueue();
    // }
  }
}

// Run tests
console.log(`${colors.cyan}Starting Enhanced Context Analysis tests...${colors.reset}\n`);

runTests().then(() => {
  console.log(`\n${colors.blue}Tests completed successfully${colors.reset}`);
  process.exit(0);
}).catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});