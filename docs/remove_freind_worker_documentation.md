# RemoveFriendWorker Documentation

## Overview
The RemoveFriendWorker processes friend removal tasks from the `remove_friend_queue`. It handles the complete cleanup process when removing friends from our Steam trading system, including database updates and data cleanup.

## Core Functionality

### Processing Flow
The worker executes a 5-step removal process for each task:

1. **Follow-up Queue Cleanup**: Removes any pending follow-up tasks for the friend
2. **Negotiation Removal**: Deletes the friend's negotiation data from JSON files
3. **Link Status Update**: Updates the database Link status based on removal reason
4. **SteamFriend Entry Removal**: Removes the friendship record from the database
5. **Steam Friendship Cancellation**: (Placeholder for future implementation)

### Reason-to-Status Mapping
- `'No items of interest'` → `'EMPTY'`
- `'Friend not responding'` → `'UNRESPONSIVE'`
- Any other reason → `'CANCELED'`

### Task ID Format
Tasks use the format: `{ourSteamId}_{friendSteamId}`
- `ourSteamId`: Steam ID of our account
- `friendSteamId`: Steam ID of the friend being removed

## Dependencies
- **QueueManager**: Manages remove_friend_queue, orchestration_queue, and follow_up_queue
- **HttpClient**: Handles negotiation file operations via node_api_service
- **DjangoClient**: Communicates with Django API for database operations

## Configuration
- `processInterval`: Processing cycle interval (default: 5000ms)
- `batchSize`: Tasks processed per cycle (default: 5)

## Key Methods
- `processTask()`: Main processing logic for individual removal tasks
- `checkAndRemoveFollowUpTasks()`: Step 1 implementation
- `removeNegotiation()`: Step 2 implementation  
- `updateLinkStatus()`: Step 3 implementation
- `removeSteamFriendEntry()`: Step 4 implementation

## Error Handling
The worker continues processing even if individual steps fail, ensuring maximum cleanup completion. All errors are logged with detailed context for debugging.