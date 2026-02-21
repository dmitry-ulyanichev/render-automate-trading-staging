# Queue Task Structures

This document defines the standard task structures for each queue in the orchestration system.

## Queue-Specific Task Structures

### 1. orchestration_queue

Core orchestration tasks that analyze negotiation context and create tasks for specialized workers.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:00:00Z",
  "priority": "normal",
  "context": {},
  "pending_tasks": ["check_inventory", "check_language"],
  "created_at": "2025-08-22T11:59:00Z",
  "updated_at": "2025-08-22T11:59:30Z"
}
```

**Fields:**
- `context`: Negotiation context loaded from HTTP API
- `pending_tasks`: Array of pending sub-tasks (removed as completed)
- `created_at`/`updated_at`: Tracking timestamps

### 2. inventory_queue

Tasks for checking Steam inventories and analyzing items.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:00:00Z",
  "priority": "normal",
  "targetSteamID": "76561198000000002"
}
```

**Fields:**
- `targetSteamID`: Steam ID whose inventory to check

### 3. language_queue (UPDATED)

Tasks for detecting friend's preferred language.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:00:00Z",
  "priority": "high",
  "method": "player_summaries",
  "attempts": 0,
  "partial_data": {
    "friends_list": ["steamId1", "steamId2"],
    "friends_obtained_at": "2025-08-22T11:58:00Z",
    "method_progress": {}
  }
}
```

**BREAKING CHANGE:** Replaced `useSelenium: boolean` with new structure:

**New Fields:**
- `method`: Detection method - `'player_summaries' | 'text_analysis' | 'ai_analysis' | 'selenium_scraping'`
- `attempts`: Retry tracking for Steam API rate limits
- `partial_data`: Persistence for partial progress between failures
  - `friends_list`: Steam IDs from GetFriendList API
  - `friends_obtained_at`: Timestamp when friends list was retrieved
  - `method_progress`: Method-specific state (e.g., API call progress)

**Method Types:**
- `player_summaries`: Steam API country analysis (primary implementation)
- `text_analysis`: Profile/message text analysis (future stub)
- `ai_analysis`: AI-powered language detection (future stub)  
- `selenium_scraping`: Browser-based profile scraping (future stub)

### 4. ai_queue

Tasks for AI consultation and decision making.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:01:00Z",
  "priority": "normal",
  "prompt": "Analyze negotiation context and suggest response"
}
```

### 5. trade_offer_queue

Tasks for managing Steam trade offers.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "action": "createTradeOffer",
  "execute": "2025-08-22T12:00:00Z",
  "priority": "high",
  "tradeOfferID": null,
  "itemsToReceive": [
    {
      "market_hash_name": "AK-47 | Redline (Field-Tested)",
      "quantity": 1,
      "price": 15.50
    }
  ],
  "itemsToGive": []
}
```

**Action Types:**
- `"createTradeOffer"` - Create new trade offer
- `"acceptTradeOffer"` - Accept existing offer
- `"cancelTradeOffer"` - Cancel our offer
- `"declineTradeOffer"` - Decline their offer
- `"updateTradeOffers"` - Update trade offer status

### 6. message_queue

Tasks for sending Steam messages.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:01:00Z",
  "priority": "normal",
  "message": ["Hi!", "Do you have boxes in CS by any chance?"]
}
```

**Note:** `message` can be a string or array of strings for multi-line messages.

### 7. remove_friend_queue

Tasks for removing Steam friends.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "priority": "low"
}
```

**Note:** No execute time as these are processed in batches.

### 8. follow_up_queue

Follow-up tasks for unanswered messages.

```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-23T12:00:00Z",
  "created_at": "2025-08-22T12:00:00Z"
}
```

**BREAKING CHANGE:** Updated from using `id` field to `taskID` for consistency with all other queues.

**Migration Notes:**
- **Old format (deprecated):** Used `id` field instead of `taskID`
- **New format:** Uses standard `taskID` field like all other queues  
- **Backward compatibility:** Workers should handle both formats during transition

## Task ID Format

**ALL QUEUES** now use the standard `taskID` format: `{ourSteamID}_{friendSteamID}`

Example: `76561198000000001_76561198000000002`

This ensures:
- **Complete consistency** across all queue types
- **Unified cleanup logic** for queue maintenance
- **Simplified queue management** operations
- **Prevention of duplicates** across the system

## Priority Levels

Tasks are processed in this order:
1. `high` - Urgent tasks (trade offers, important messages)
2. `normal` - Regular processing (default)
3. `low` - Background tasks (friend removal, cleanup)

## Migration Notes

### Language Queue Migration

**Old Structure (Deprecated):**
```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:00:00Z",
  "priority": "normal",
  "useSelenium": false
}
```

**New Structure:**
```json
{
  "taskID": "76561198000000001_76561198000000002",
  "execute": "2025-08-22T12:00:00Z",
  "priority": "high",
  "method": "player_summaries",
  "attempts": 0,
  "partial_data": {
    "friends_list": [],
    "friends_obtained_at": null,
    "method_progress": {}
  }
}
```

**Backward Compatibility:** LanguageWorker should handle both old and new task formats during transition period.

**Method Mapping:**
- `useSelenium: false` → `method: "player_summaries"`
- `useSelenium: true` → `method: "selenium_scraping"`