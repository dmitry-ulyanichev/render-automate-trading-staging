# Complete Negotiation Fields Reference

## Root Level Fields (Per Account)

These fields are at the root level of the negotiation JSON file:

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `account_steam_id` | string | Our Steam account ID | Required |
| `account_username` | string | Our account username | null |
| `created_at` | ISO string | When file was created | Current time |
| `updated_at` | ISO string | Last modification time | Current time |
| `our_inventory` | array\|null | Our account's inventory items | null |
| `our_inventory_updated_at` | ISO string\|null | When our inventory was last checked | null |
| `negotiations` | object | Map of friend_steam_id to negotiation objects | {} |

## Individual Negotiation Fields (Per Friend)

Each negotiation object (keyed by friend's Steam ID) contains:

### Basic Fields
| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `friend_steam_id` | string | Friend's Steam ID | Required |
| `state` | string | Current negotiation state | 'pending_initiation' |
| `followUpCount` | number | Number of follow-up attempts | 0 |
| `created_at` | ISO string | When negotiation was created | Current time |
| `updated_at` | ISO string | Last modification time | Current time |
| `messages` | array | Conversation messages | [] |

### Orchestration Fields
| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `objective` | string\|null | Trading goal: 'request_cases_as_gift', 'request_skins_as_gift', 'trade', 'redirect' | null |
| `source` | string\|null | How friend was found: 'match', 'reserve_pipeline' | null |
| `inventory_private` | boolean\|null | Is friend's inventory private | null |
| `inventory` | array\|null | Friend's inventory items | null |
| `inventory_updated_at` | ISO string\|null | When friend's inventory was last checked | null |
| `redirected_to` | array | Steam IDs of accounts friend was redirected to | [] |
| `language` | string\|null | Friend's detected language (e.g., 'English', 'Russian') | null |
| `referred_from_messages` | array | Messages from original negotiation if redirected | [] |
| `trade_offers` | array | Active and historical trade offers | [] |
| `trade_offers_updated_at` | ISO string\|null | When trade offers were last updated | null |
| `ai_requested_actions` | object\|null | AI action tracking object | null |

### Tracking Fields
| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `base_accounts_checked_at` | ISO string\|null | When base accounts were last checked for redirect | null |
| `referrer_checked` | boolean | Whether we checked for referrer in redirects.json | false |

## Data Structures

### Inventory Item
```json
{
  "market_hash_name": "AK-47 | Redline (Field-Tested)",
  "quantity": 1,
  "price": 15.50,
  "tradeable": true
}
```

### Message
```json
{
  "id": "msg_1234567890_abc",
  "timestamp": "2025-08-23T10:00:00Z",
  "direction": "incoming" | "outgoing",
  "message": "Hi, interested in trading?",
  "sender_steam_id": "76561198000000001",
  "received_at": "2025-08-23T10:00:00Z",
  "processed_at": "2025-08-23T10:00:01Z"
}
```

### Trade Offer
```json
{
  "trade_offer_id": "8189748113",
  "is_our_offer": true,
  "state_history": [
    {"state": "Active", "timestamp": "2025-08-23T10:00:00Z"},
    {"state": "Accepted", "timestamp": "2025-08-23T10:05:00Z"}
  ],
  "items_to_give": [...],
  "items_to_receive": [...],
  "profit": 29.50,
  "give_to_receive_ratio": 0.344
}
```

### AI Requested Actions
```json
{
  "trigger_message_id": "msg_1234567890",
  "actions_completed": [
    {
      "action_id": "uuid",
      "type": "update_trade_offers",
      "requested_at": "2025-08-23T10:00:00Z",
      "completed_at": "2025-08-23T10:01:00Z",
      "outcome": "success",
      "requires_followup": false
    }
  ],
  "actions_pending": [
    {
      "action_id": "uuid",
      "type": "create_trade_offer",
      "params": {...},
      "requested_at": "2025-08-23T10:02:00Z"
    }
  ],
  "created_at": "2025-08-23T10:00:00Z"
}
```

## State Values

Valid states for negotiations:
- `pending_initiation` - Waiting to start
- `initiating` - Starting conversation
- `removing` - Being removed
- `replying` - Composing reply
- `awaiting_reply` - Waiting for friend's response
- `active` - Active negotiation
- `waiting_for_reply` - Waiting state
- `disconnected_active` - Was active but disconnected
- `completed` - Negotiation finished
- `finished` - Finalized
- `error` - Error state
- `replied` - Has replied