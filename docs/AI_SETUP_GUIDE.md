# AI Integration Setup Guide (Mistral)

## Overview
The AIWorker now supports **real AI translation** using Mistral AI. The system uses a **gateway routing** approach:
- ✅ **`translate_*` scenarios** → Real Mistral AI processing
- 🤖 **Other scenarios** → Dummy implementation (future work)

## Configuration

### 1. Add Environment Variables
Add these to your `.env` file:

```bash
# Mistral AI Configuration
MISTRAL_API_KEY=your_mistral_api_key_here

# Optional: Override defaults
MISTRAL_MODEL=mistral-small-latest      # Default model for translations
MISTRAL_MAX_TOKENS=500                  # Max tokens per response
MISTRAL_TEMPERATURE=0.3                 # Lower = more consistent translations
MISTRAL_TIMEOUT=30000                   # API timeout in ms
MISTRAL_MAX_RETRIES=3                   # Number of retry attempts
MISTRAL_RETRY_DELAY_MS=1000            # Delay between retries

# AI Worker Configuration
AI_PROCESS_INTERVAL=3000                # How often to check for AI tasks (ms)
AI_BATCH_SIZE=2                         # Max tasks to process per cycle
```

### 2. Get Your Mistral API Key
1. Go to https://console.mistral.ai/
2. Sign up or log in
3. Navigate to "API Keys" section
4. Create a new API key
5. Copy it to your `.env` file

## How It Works

### Gateway Routing
```javascript
if (promptScenario.startsWith('translate_')) {
  // Use REAL Mistral AI
  aiResponse = await this.processTranslationTask(task);
} else {
  // Use dummy implementation
  aiResponse = await this.processDummyTask(task);
}
```

### Translation Flow
1. **OrchestrationWorker** creates AI task with:
   - `promptScenario`: `"translate_open_inventory"`, `"translate_follow_up_1"`, etc.
   - `prompt`: Assembled prompt with instructions and template
   - `variables`: `{LANGUAGE: "Swedish", ...}`

2. **AIWorker** receives task and routes to `processTranslationTask()`

3. **Mistral AI** translates the template messages

4. **AIWorker** parses response and creates message task

5. **MessageWorker** sends the translated messages

## Files Modified

### New Files
- ✅ `automate_trading/utils/ai_client.js` - Mistral API client with retry logic
- ✅ `AI_SETUP_GUIDE.md` - This guide

### Modified Files
- ✅ `automate_trading/config/config.js` - Added AI configuration section
- ✅ `automate_trading/workers/ai_worker.js` - Added gateway routing and real translation

## Testing

### Quick Connection Test
The AIClient has a built-in test method. You can verify your API key works:

```javascript
const config = require('./config/config');
const logger = require('./utils/logger');
const AIClient = require('./utils/ai_client');

const client = new AIClient(config, logger);
await client.testConnection(); // Should log "✅ Connection test successful"
```

### End-to-End Translation Test
1. **Ensure you have:**
   - `MISTRAL_API_KEY` in `.env`
   - Template with English messages (e.g., `open_inventory`)
   - Prompt scenario configured (e.g., `translate_open_inventory`)

2. **Start the system:**
   ```bash
   npm run dev:automate
   ```

3. **Trigger a translation scenario:**
   - System will create orchestration task
   - OrchestrationWorker determines translation is needed
   - Creates AI task with `translate_*` scenario
   - AIWorker routes to Mistral AI
   - Translated messages sent to friend

4. **Watch the logs for:**
   ```
   AIWorker: 🔄 Routing to REAL translation processing (Mistral AI)
   AIWorker: 🚀 Calling Mistral AI for translation...
   AIWorker: ✅ Mistral AI response received (1234ms, 123 tokens)
   AIWorker: 📝 Extracted 3 translated messages
   ```

## Supported Translation Scenarios

Based on your prompt assembly system, these scenarios will use real AI:
- ✅ `translate_open_inventory` - Translate opening messages for open inventory
- ✅ `translate_private_inventory` - Translate messages for private inventory
- ✅ `translate_follow_up_1` - Translate first follow-up messages
- ✅ `translate_follow_up_2` - Translate second follow-up messages
- ✅ `translate_follow_up_3` - Translate third follow-up messages

Any other scenario will use dummy implementation until you extend the gateway.

## Cost Considerations

### Mistral Pricing (approximate)
- **mistral-small-latest**: ~$0.001 per 1K tokens
- **Average translation**: ~200-300 tokens per request
- **Cost per translation**: ~$0.0002-0.0003 (very cheap!)

### Optimization Tips
1. Use `mistral-small-latest` for translations (faster + cheaper)
2. Keep `MISTRAL_MAX_TOKENS=500` (translations don't need many tokens)
3. Set `MISTRAL_TEMPERATURE=0.3` (more consistent translations)
4. Monitor usage in Mistral console

## Troubleshooting

### Error: "AI client not initialized"
**Cause:** `MISTRAL_API_KEY` missing or invalid
**Fix:** Check your `.env` file and verify API key

### Error: "Failed to parse messages from AI response"
**Cause:** AI returned unexpected format
**Fix:** Check logs for raw AI response, may need to adjust prompt

### AIWorker falls back to dummy
**Cause:** AI call failed (network, rate limit, etc.)
**Fix:** System gracefully falls back. Check error logs for details.

### No AI tasks created
**Cause:** OrchestrationWorker not creating AI tasks
**Fix:** Verify:
  - Templates exist for target language
  - Prompts JSON has translation scenarios
  - OrchestrationWorker decision logic is triggered

## Future Extensions

To add real AI for other scenarios:

1. **Identify scenario prefix** (e.g., `negotiate_*`, `respond_*`)

2. **Add routing in AIWorker.processTask():**
   ```javascript
   else if (promptScenario && promptScenario.startsWith('negotiate_')) {
     aiResponse = await this.processNegotiationTask(task);
   }
   ```

3. **Implement processing method:**
   ```javascript
   async processNegotiationTask(task) {
     // Call Mistral with negotiation prompt
     // Parse response (may be different format than translation)
     // Return structured response
   }
   ```

## Support

For issues or questions:
- Check logs in `logs/automation.log`
- Review Mistral API console for usage/errors
- Consult Mistral docs: https://docs.mistral.ai/

---

**Status:** ✅ Real translation implemented and ready for testing!
