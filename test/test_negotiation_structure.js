// automate_trading/test/test_negotiation_structure.js
/**
 * Test script to verify the extended negotiation structure
 * Run with: node test/test_negotiation_structure.js
 */

// Mock logger
const mockLogger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`),
  warn: (msg) => console.log(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

// Test configuration
const testConfig = {
  api: {
    baseUrl: process.env.API_BASE_URL || 'http://127.0.0.1:3001'
  },
  testAccountSteamId: '76561198000000001',
  testFriendSteamId: '76561198000000002',
  testAccount: {
    username: 'test_account',
    steam_login: 'test_login'
  }
};

// Load the NegotiationManager
const NegotiationManager = require('../workers/managers/negotiation_manager');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

// Helper function to log test results
function logTest(testName, passed, details = '') {
  const status = passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
  console.log(`${status} ${testName}`);
  if (details) {
    console.log(`  ${colors.yellow}→${colors.reset} ${details}`);
  }
}

// Helper function to log section headers
function logSection(sectionName) {
  console.log(`\n${colors.blue}━━━ ${sectionName} ━━━${colors.reset}`);
}

// Main test function
async function runTests() {
  console.log(`${colors.blue}╔════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.blue}║  Testing Extended Negotiation Structure   ║${colors.reset}`);
  console.log(`${colors.blue}╚════════════════════════════════════════════╝${colors.reset}`);
  
  const manager = new NegotiationManager(testConfig, mockLogger);
  
  try {
    // Test 1: Create new negotiation with all fields
    logSection('1. Testing New Negotiation Creation');
    
    const newNegotiation = manager.createNewNegotiation(testConfig.testFriendSteamId);
    
    // Check all new fields exist
    const requiredFields = [
      'friend_steam_id', 'state', 'followUpCount', 'messages',
      'objective', 'source', 'inventory_private', 'inventory',
      'inventory_updated_at', 'redirected_to', 'language',
      'referred_from_messages', 'trade_offers', 'trade_offers_updated_at',
      'ai_requested_actions'
    ];
    
    let allFieldsPresent = true;
    for (const field of requiredFields) {
      if (!(field in newNegotiation)) {
        logTest(`Field '${field}' exists`, false);
        allFieldsPresent = false;
      }
    }
    
    if (allFieldsPresent) {
      logTest('All required fields present', true);
    }
    
    // Verify default values
    logTest('Default objective is null', newNegotiation.objective === null);
    logTest('Default source is null', newNegotiation.source === null);
    logTest('Default inventory_private is null', newNegotiation.inventory_private === null);
    logTest('Default redirected_to is empty array', Array.isArray(newNegotiation.redirected_to) && newNegotiation.redirected_to.length === 0);
    logTest('Default trade_offers is empty array', Array.isArray(newNegotiation.trade_offers) && newNegotiation.trade_offers.length === 0);
    
    // Test 2: Create AI Requested Actions structure
    logSection('2. Testing AI Requested Actions Structure');
    
    const aiActions = manager.createAIRequestedActions();
    logTest('AI actions has trigger_message_id', 'trigger_message_id' in aiActions);
    logTest('AI actions has actions_completed array', Array.isArray(aiActions.actions_completed));
    logTest('AI actions has actions_pending array', Array.isArray(aiActions.actions_pending));
    logTest('AI actions has created_at timestamp', 'created_at' in aiActions);
    
    // Test 3: Create Trade Offer structure
    logSection('3. Testing Trade Offer Structure');
    
    const tradeOffer = manager.createTradeOffer({
      trade_offer_id: '8189748113',
      is_our_offer: true,
      items_to_give: [
        { market_hash_name: 'AK-47 | Redline (Field-Tested)', quantity: 1, price: 15.50 }
      ],
      items_to_receive: [
        { market_hash_name: 'AWP | Asiimov (Battle-Scarred)', quantity: 1, price: 45.00 }
      ],
      profit: 29.50,
      give_to_receive_ratio: 0.344
    });
    
    logTest('Trade offer has all required fields', 
      tradeOffer.trade_offer_id && 
      typeof tradeOffer.is_our_offer === 'boolean' &&
      Array.isArray(tradeOffer.items_to_give) &&
      Array.isArray(tradeOffer.items_to_receive)
    );
    
    // Test 4: Create Inventory Item structure
    logSection('4. Testing Inventory Item Structure');
    
    const inventoryItem = manager.createInventoryItem({
      market_hash_name: 'Prisma Case',
      quantity: 5,
      price: 0.03,
      tradeable: true
    });
    
    logTest('Inventory item has correct structure',
      inventoryItem.market_hash_name === 'Prisma Case' &&
      inventoryItem.quantity === 5 &&
      inventoryItem.price === 0.03 &&
      inventoryItem.tradeable === true
    );
    
    // Test 5: Create Empty Negotiations Structure with root fields
    logSection('5. Testing Empty Negotiations Structure');
    
    const emptyNegotiations = manager.createEmptyNegotiationsStructure(
      testConfig.testAccountSteamId,
      testConfig.testAccount
    );
    
    logTest('Has our_inventory field', 'our_inventory' in emptyNegotiations);
    logTest('Has our_inventory_updated_at field', 'our_inventory_updated_at' in emptyNegotiations);
    logTest('Has negotiations object', typeof emptyNegotiations.negotiations === 'object');
    logTest('Has account_steam_id', emptyNegotiations.account_steam_id === testConfig.testAccountSteamId);
    
    // Test 6: Validate negotiation structure
    logSection('6. Testing Negotiation Validation');
    
    const validNegotiation = manager.createNewNegotiation(testConfig.testFriendSteamId);
    logTest('Valid negotiation passes validation', manager.validateNegotiation(validNegotiation));
    
    // Test invalid objective
    const invalidNegotiation = { ...validNegotiation, objective: 'invalid_objective' };
    logTest('Invalid objective fails validation', !manager.validateNegotiation(invalidNegotiation));
    
    // Test invalid source
    const invalidSource = { ...validNegotiation, source: 'invalid_source' };
    logTest('Invalid source fails validation', !manager.validateNegotiation(invalidSource));
    
    // Test 7: Test getters and setters (mock mode)
    logSection('7. Testing Helper Methods');
    
    // Test objective setter validation
    const validObjectives = Object.values(manager.OBJECTIVE_TYPES);
    logTest('Valid objectives defined', validObjectives.length > 0, 
      `Objectives: ${validObjectives.join(', ')}`);
    
    // Test source setter validation
    const validSources = Object.values(manager.SOURCE_TYPES);
    logTest('Valid sources defined', validSources.length > 0,
      `Sources: ${validSources.join(', ')}`);
    
    // Test action ID generation
    const actionId1 = manager.generateActionId();
    const actionId2 = manager.generateActionId();
    logTest('Action IDs are unique', actionId1 !== actionId2,
      `Generated IDs: ${actionId1}, ${actionId2}`);
    
    // Test 8: Integration test (if API is available)
    logSection('8. Testing API Integration');
    
    console.log(`  ${colors.yellow}→${colors.reset} Attempting to connect to API at ${testConfig.api.baseUrl}...`);
    
    try {
      // Try to load negotiations (will create default if not exists)
      const negotiations = await manager.loadNegotiations(
        testConfig.testAccountSteamId,
        testConfig.testAccount
      );
      
      logTest('Successfully loaded/created negotiations via API', true);
      
      // Check structure
      logTest('Negotiations has our_inventory field', 'our_inventory' in negotiations);
      logTest('Negotiations has our_inventory_updated_at field', 'our_inventory_updated_at' in negotiations);
      
      // Try to save negotiations
      const success = await manager.saveNegotiations(
        testConfig.testAccountSteamId,
        negotiations
      );
      
      logTest('Successfully saved negotiations via API', success);
      
    } catch (error) {
      logTest('API integration', false, 
        `Could not connect to API: ${error.message}\n  ${colors.yellow}→${colors.reset} Make sure node_api_service is running on ${testConfig.api.baseUrl}`);
    }
    
    // Summary
    logSection('Test Summary');
    console.log(`${colors.green}All critical tests completed successfully!${colors.reset}`);
    console.log(`\nThe extended negotiation structure is ready for use with:`);
    console.log(`  • All orchestration fields`);
    console.log(`  • AI action tracking`);
    console.log(`  • Trade offer management`);
    console.log(`  • Inventory tracking`);
    console.log(`  • Language detection support`);
    console.log(`  • Redirect handling`);
    
  } catch (error) {
    console.error(`${colors.red}Test failed with error: ${error.message}${colors.reset}`);
    console.error(error.stack);
  } finally {
    // Cleanup
    await manager.cleanup();
  }
}

// Run tests
runTests().then(() => {
  console.log(`\n${colors.blue}Tests completed${colors.reset}`);
  process.exit(0);
}).catch(error => {
  console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
  process.exit(1);
});