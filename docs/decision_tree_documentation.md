# OrchestrationWorker Decision Tree Documentation

## Complete Decision Flow

The OrchestrationWorker implements a comprehensive decision tree based on the flowchart. Here's the complete logic:

```
START
  ↓
[1] CHECK REFERRED_FROM_MESSAGES
  ├─ Has messages → Continue
  └─ No messages → Check referrer in redirects.json → Continue
  ↓
[2] CHECK INVENTORY_PRIVATE
  ├─ null → CREATE inventory_check task → EXIT
  ├─ true → GO TO [3]
  └─ false → GO TO [4]
  ↓
[3] HANDLE PRIVATE INVENTORY
  ├─ Check if info outdated (inventory_updated_at < task.created_at)
  │   └─ Yes → CREATE inventory_check task → EXIT
  ├─ Language unknown → CREATE language_detection task → EXIT
  └─ Language known:
      ├─ State: initiating → SEND ask_open_inventory message
      ├─ State: replying → CONSULT AI
      └─ State: awaiting_reply:
          ├─ Has new messages → CONSULT AI
          └─ No new messages → SEND follow_up message
  ↓
[4] INVENTORY NOT PRIVATE (false)
  ├─ Inventory empty → GO TO [5]
  └─ Has items → GO TO [6]
  ↓
[5] EMPTY INVENTORY
  ├─ No trade offers → REMOVE friend immediately
  └─ Has trade offers:
      ├─ Has Accepted/InEscrow → CONSULT AI + Schedule removal (14 days)
      └─ No accepted → REMOVE friend immediately
  ↓
[6] HAS ITEMS - ASSESS & SET OBJECTIVE
  ├─ Cases value < $2 AND source=reserve_pipeline → objective='request_cases_as_gift'
  ├─ Total value ≤ $2 AND source=reserve_pipeline → objective='request_skins_as_gift'
  └─ Total value > $2 → objective='trade'
  ↓
[7] HANDLE BY OBJECTIVE
  ├─ REQUEST_CASES_AS_GIFT / REQUEST_SKINS_AS_GIFT → GO TO [8]
  ├─ TRADE → GO TO [9]
  └─ REDIRECT → GO TO [10]
  ↓
[8] GIFT REQUEST FLOW
  ├─ Source=match → REMOVE friend (cannot request from match)
  ├─ Language unknown → CREATE language_detection task
  └─ Language known:
      ├─ State: initiating → SEND gift request message
      ├─ State: replying → CONSULT AI
      └─ State: awaiting_reply → SEND follow_up message
  ↓
[9] TRADE FLOW
  ├─ No trade offers:
  │   ├─ Our inventory unknown → CREATE inventory_check task (our)
  │   ├─ Our value < 12.5% of friend's → SET objective='redirect' → RECURSE
  │   ├─ Language unknown → CREATE language_detection task
  │   └─ Language known:
  │       ├─ State: initiating → SEND trade initiation message
  │       ├─ State: replying → CONSULT AI
  │       └─ State: awaiting_reply:
  │           ├─ Has new messages → CONSULT AI
  │           └─ No new messages → SEND follow_up message
  └─ Has trade offers → CONSULT AI
  ↓
[10] REDIRECT FLOW
  ├─ Not redirected yet:
  │   ├─ Check base accounts (external)
  │   ├─ Language unknown → CREATE language_detection task
  │   └─ Language known → SEND redirect message
  └─ Already redirected:
      ├─ Language unknown → CREATE language_detection task
      └─ Language known:
          ├─ State: initiating/awaiting_reply → SEND explain redirect
          └─ State: replying → CONSULT AI
```

## Decision Types

### 1. **Inventory Check**
- **Target**: Friend or Our account
- **Creates**: Task in `inventory_queue`
- **Pending Type**: `check_inventory_friend` or `check_inventory_ours`

### 2. **Language Detection**
- **Creates**: Task in `language_queue`
- **Pending Type**: `check_language`
- **Used Before**: Sending any message

### 3. **Send Message**
- **Templates Available**:
  - `ask_open_inventory` - Request to open private inventory
  - `request_cases_as_gift` - Ask for cases as gift
  - `request_skins_as_gift` - Ask for skins as gift
  - `trade_initiation_match` - Start trade conversation (match source)
  - `trade_initiation_reserve_pipeline` - Start trade conversation (reserve pipeline)
  - `redirect_to_base` - Redirect to base account
  - `follow_up_private_inventory_[index]` - Follow up no. [index] on inventory request
  - `follow_up_gift_request_[index]` - Follow up no. [index] on gift request
  - `follow_up_redirect_[index]` - Follow up no. [index] on redirect
  - `follow_up_trade_[index]` - Follow up no. [index] on trade
- **Creates**: Task in `message_queue`
- **Pending Type**: `send_message`
- **Delay**: 60 seconds (to batch messages)

### 4. **Consult AI**
- **Creates**: Task in `ai_queue`
- **Pending Type**: `consult_ai`
- **Used When**: Complex situations requiring AI analysis
- **Context**: Full negotiation context included

### 5. **Remove Friend**
- **Creates**: Task in `remove_friend_queue`
- **Pending Type**: `remove_friend` (if immediate)
- **Options**:
  - Immediate removal
  - Scheduled via follow_up (no pending_task)

### 6. **Follow Up**
- **Creates**: Task in `follow_up_queue`
- **Used For**: Scheduled actions (e.g., remove after 14 days)
- **No Pending Type**: Doesn't block orchestration

## Objective Setting Rules

### Request Cases as Gift
- **Condition**: Total case value < $2 AND source = 'reserve_pipeline'
- **Restriction**: Cannot request from 'match' source

### Request Skins as Gift
- **Condition**: Total inventory value ≤ $2 AND source = 'reserve_pipeline'
- **Restriction**: Cannot request from 'match' source

### Trade
- **Condition**: Total inventory value > $2
- **Viability Check**: Our inventory ≥ 12.5% (1/8) of friend's value
- **If Insufficient**: Changes to 'redirect' objective

### Redirect
- **Condition**: Set when our inventory < 12.5% of friend's value
- **Process**: Check base accounts → Send redirect message

## State Transitions

The decision tree respects negotiation states:

- **`initiating`**: First contact, use templates
- **`replying`**: Friend responded, usually needs AI
- **`awaiting_reply`**: Waiting for response, check for new messages
- **`removing`**: Being removed
- **`completed`**: Negotiation finished

## Special Handling

### Private Inventory
1. Always check if info is current (compare timestamps)
2. Need language before asking to open
3. Different messages based on state
4. AI consultation if friend responds but doesn't open

### Empty Inventory
1. Immediate removal if no trades
2. Check for Accepted/InEscrow states
3. Schedule removal after trade completion
4. AI consultation for accepted trades

### Timestamp Validation
- Task timestamp (`created_at` or `execute`) represents when task was created/updated
- Compare with `inventory_updated_at` to ensure fresh data
- Recheck if inventory info is older than task

### Trade Offer States
- **Accepted**: Trade accepted (with Steam Guard)
- **InEscrow**: Trade accepted (without Steam Guard)
- Both treated as successful trades

## Exit Points

The decision tree exits (removes orchestration task) when:
1. Friend removed (empty inventory, no trades)
2. Friend removed (cannot request from match)
3. Friend removed (empty inventory, unaccepted trades)

The task remains in queue when:
1. Waiting for sub-tasks (pending_tasks)
2. Needs periodic checking (private inventory)
3. Ongoing negotiation (messages/trades)

## Error Handling

Tasks with errors are:
1. Marked with `needs_review: true`
2. Given error message
3. Scheduled for retry in 1 hour
4. NOT removed from queue

## Performance Notes

- Process interval: 5 seconds (configurable)
- Batch size: 3 tasks per cycle (configurable)
- Message delay: 60 seconds (to batch responses)
- AI consultation delay: 60 seconds (rate limiting)
- Follow-up delay: Configurable per action