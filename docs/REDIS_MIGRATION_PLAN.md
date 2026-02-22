# Redis Migration Plan: Negotiation Storage

## Executive Summary

**Objective**: Migrate negotiation data from file-based JSON storage to Redis to eliminate file lock contention and enable concurrent operations for 80+ Steam accounts.

**Current Bottleneck**: File locks serialize all negotiation updates, causing 6-12 second delays when 80 accounts update simultaneously.

**Expected Improvement**: Reduce update latency from seconds to milliseconds, enable true concurrency.

---

## 1. Redis Schema Design

### Key Structure Overview

```
# Account-level metadata
negotiation:meta:{steamId}            → Hash (account_steam_id, account_username, created_at, updated_at)

# Trade offers (HIGH PRIORITY - most frequent access)
negotiation:offers:{steamId}          → Hash (trade_offer_id → JSON string of offer data)
negotiation:offers:index:{steamId}    → Sorted Set (score=updated_timestamp, member=trade_offer_id)

# Per-friend negotiations
negotiation:friend:{steamId}:{friendSteamId}  → Hash (all negotiation fields for this friend)

# Negotiations index (for listing all friends)
negotiation:friends:index:{steamId}   → Set (contains all friendSteamIds)

# Global account index
negotiation:accounts                  → Set (contains all steamIds with negotiations)
```

### Detailed Schema

#### 1. Account Metadata
```redis
HSET negotiation:meta:76561199027634480
  account_steam_id "76561199027634480"
  account_username "username"
  created_at "2024-12-22T10:30:00.000Z"
  updated_at "2024-12-22T10:30:00.000Z"
  trade_offers_updated_at "2024-12-22T10:30:00.000Z"
```

#### 2. Trade Offers (Atomic Operations)
```redis
# Store each offer as JSON in a hash
HSET negotiation:offers:76561199027634480
  "6789123456" "{\"trade_offer_id\":\"6789123456\",\"state\":\"Active\",...}"

# Index by timestamp for ordering
ZADD negotiation:offers:index:76561199027634480
  1703241234567 "6789123456"

# Atomic upsert via Lua script (see below)
```

#### 3. Friend Negotiations
```redis
# Store each friend's data as a hash
HMSET negotiation:friend:76561199027634480:76561198123456789
  friend_steam_id "76561198123456789"
  state "active"
  followUpCount "0"
  created_at "2024-12-22T10:30:00.000Z"
  updated_at "2024-12-22T10:30:00.000Z"
  objective "request_cases_as_gift"
  source "match"
  inventory_private "false"
  messages "[{...}]"  # JSON string
  inventory "{...}"    # JSON string
  language "{...}"     # JSON string
  ai_requested_actions "{...}"  # JSON string
  # ... other fields

# Track all friends for this account
SADD negotiation:friends:index:76561199027634480
  "76561198123456789"
```

### Why This Schema?

1. **Granular Access**: Update trade offers without loading entire negotiation file
2. **Atomic Operations**: Redis native commands (HSET, ZADD) are atomic
3. **Fast Lookups**: O(1) access to specific offers or friends
4. **Memory Efficient**: Only load what you need
5. **Scalable**: Can shard by steamId if needed

---

## 2. Redis Lua Scripts for Atomic Operations

### Script 1: Atomic Trade Offer Upsert

```lua
-- atomic_upsert_trade_offer.lua
-- KEYS[1] = negotiation:offers:{steamId}
-- KEYS[2] = negotiation:offers:index:{steamId}
-- KEYS[3] = negotiation:meta:{steamId}
-- ARGV[1] = trade_offer_id
-- ARGV[2] = new trade offer JSON string
-- ARGV[3] = current timestamp (ms)

local offersKey = KEYS[1]
local indexKey = KEYS[2]
local metaKey = KEYS[3]
local tradeOfferId = ARGV[1]
local newOfferJson = ARGV[2]
local timestamp = tonumber(ARGV[3])

-- Get existing offer
local existingOfferJson = redis.call('HGET', offersKey, tradeOfferId)

local operation = 'added'
local finalOfferJson = newOfferJson

if existingOfferJson then
  -- Offer exists - merge logic would go here
  -- For now, simple replacement (merge happens in Node.js before calling script)
  operation = 'updated'
  finalOfferJson = newOfferJson
end

-- Store updated offer
redis.call('HSET', offersKey, tradeOfferId, finalOfferJson)

-- Update index with timestamp
redis.call('ZADD', indexKey, timestamp, tradeOfferId)

-- Update metadata timestamp
redis.call('HSET', metaKey, 'updated_at', redis.call('TIME')[1])
redis.call('HSET', metaKey, 'trade_offers_updated_at', redis.call('TIME')[1])

return operation
```

### Script 2: Bulk Remove Friends

```lua
-- bulk_remove_friends.lua
-- KEYS[1] = steamId
-- ARGV[*] = friend_steam_ids to remove

local steamId = KEYS[1]
local removed_count = 0

for i = 1, #ARGV do
  local friendSteamId = ARGV[i]

  -- Remove friend negotiation
  local friendKey = 'negotiation:friend:' .. steamId .. ':' .. friendSteamId
  if redis.call('EXISTS', friendKey) == 1 then
    redis.call('DEL', friendKey)
    redis.call('SREM', 'negotiation:friends:index:' .. steamId, friendSteamId)
    removed_count = removed_count + 1
  end
end

-- Update metadata timestamp
redis.call('HSET', 'negotiation:meta:' .. steamId, 'updated_at', redis.call('TIME')[1])

return removed_count
```

---

## 3. Implementation Plan

### Phase 1: Infrastructure Setup (30 mins)

**Step 1.1: Install Redis**
- macOS: `brew install redis`
- Start Redis: `brew services start redis`
- Verify: `redis-cli ping` → PONG

**Step 1.2: Configure Redis Persistence**

Edit `/opt/homebrew/etc/redis.conf` (or `/usr/local/etc/redis.conf`):
```conf
# Enable both RDB and AOF for maximum durability
save 900 1        # Save if 1 key changed in 15 minutes
save 300 10       # Save if 10 keys changed in 5 minutes
save 60 10000     # Save if 10000 keys changed in 1 minute

appendonly yes
appendfsync everysec
```

Restart Redis: `brew services restart redis`

**Step 1.3: Install Node.js Redis Client**

```bash
cd "/Users/mac/Documents/IT/Django Projects/tradebot"
npm install redis@^4.7.0 --save
```

**Step 1.4: Add Environment Variables**

Add to `.env`:
```env
# Redis Configuration
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_CONNECTION_TIMEOUT=5000
REDIS_COMMAND_TIMEOUT=3000
```

### Phase 2: Create Redis Manager Utility (45 mins)

**Step 2.1: Create `node_api_service/utils/redis-manager.js`**

This will be a central Redis connection manager with:
- Connection pooling
- Automatic reconnection
- Graceful error handling
- Lua script loading
- Helper methods for negotiation operations

**Key Features**:
- Singleton pattern (single Redis client instance)
- Pre-loaded Lua scripts for atomic operations
- Typed helper methods (getNegotiation, saveNegotiation, atomicUpsertTradeOffer, etc.)
- Connection health monitoring
- Fallback error handling

**Step 2.2: Create Lua Scripts**

Create directory: `node_api_service/redis_scripts/`

Files:
- `atomic_upsert_trade_offer.lua`
- `bulk_remove_friends.lua`

### Phase 3: Migration Utilities (30 mins)

**Step 3.1: Create Data Migration Script**

`node_api_service/scripts/migrate_negotiations_to_redis.js`

Features:
- Read all JSON files from `data/negotiations/`
- Parse and validate each file
- Write to Redis using new schema
- Verify data integrity
- Generate migration report
- Support dry-run mode
- Support selective migration (specific steamIds)

**Step 3.2: Create Rollback Script**

`node_api_service/scripts/rollback_redis_to_files.js`

Features:
- Read all negotiations from Redis
- Write back to JSON files
- Preserve original file structure
- Verify file integrity

### Phase 4: Update Negotiations Routes (90 mins)

**Priority Order** (migrate critical endpoints first):

1. **POST /:steamId/atomic-upsert-trade-offer** (HIGHEST PRIORITY)
   - Replace file lock with Redis Lua script
   - Measure performance improvement
   - Add logging for before/after comparison

2. **GET /:steamId** (Load negotiations)
   - Load from Redis (metadata + offers + friends)
   - Construct same response structure
   - Handle non-existent keys (return default structure)

3. **POST /:steamId** (Save negotiations)
   - Parse incoming data
   - Write to multiple Redis keys
   - Use Redis transaction (MULTI/EXEC) for atomicity

4. **DELETE /:steamId/friend/:friendSteamId** (Remove friend)
   - Single DEL + SREM operation
   - Update metadata timestamp

5. **POST /:steamId/remove-friends** (Bulk remove)
   - Use Lua script for atomicity
   - Return count of removed friends

6. **GET /:steamId/health** (Health check)
   - Check if Redis keys exist
   - Return metadata from Redis

7. **GET /** (Stats)
   - Scan Redis for all account keys
   - Pipeline GET operations for performance
   - Aggregate stats

### Phase 5: Update Configuration (15 mins)

**Step 5.1: Update `node_api_service/config/config.json`**

Add Redis section:
```json
{
  "redis": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 6379,
    "password": "",
    "db": 0,
    "connection_timeout": 5000,
    "command_timeout": 3000,
    "retry_strategy": {
      "max_retries": 3,
      "retry_delay": 1000
    }
  },
  "migration": {
    "dual_write_enabled": false,
    "fallback_to_files": false
  }
}
```

**Step 5.2: Update `automate_trading/config/config.js`**

Add Redis-aware configuration (if needed for monitoring/debugging).

### Phase 6: Testing Strategy (60 mins)

**Test 1: Unit Tests**
- Test RedisManager connection
- Test Lua scripts in isolation
- Test each endpoint with mock data

**Test 2: Integration Tests**
- Migrate sample data to Redis
- Test all endpoints against Redis
- Verify data consistency
- Test concurrent operations (simulate 10+ accounts)

**Test 3: Load Testing**
- Simulate 80 concurrent atomic-upsert operations
- Measure latency (should be <10ms per operation)
- Compare with file-based latency baseline

**Test 4: Failover Testing**
- Stop Redis mid-operation
- Verify graceful error handling
- Verify Redis restart recovery

### Phase 7: Production Migration (30 mins)

**Step 7.1: Backup Existing Files**
```bash
tar -czf negotiations_backup_$(date +%Y%m%d_%H%M%S).tar.gz data/negotiations/
```

**Step 7.2: Run Migration Script**
```bash
node node_api_service/scripts/migrate_negotiations_to_redis.js --production
```

**Step 7.3: Verify Migration**
- Check Redis key count matches file count
- Spot-check sample negotiations
- Run health checks on all accounts

**Step 7.4: Deploy Updated Code**
- Restart node_api_service with Redis-enabled routes
- Restart automate_trading service
- Monitor logs for errors

**Step 7.5: Monitor Performance**
- Watch atomic-upsert latency logs
- Verify no file lock timeouts
- Monitor Redis memory usage

---

## 4. Redis Configuration Recommendations

### Memory Management

```conf
# Set max memory (adjust based on your negotiation data size)
# Estimate: 100 accounts × 50 friends × 5KB = ~25MB
# Add trade offers: 100 accounts × 200 offers × 2KB = ~40MB
# Total estimate: ~100MB (set to 256MB for headroom)
maxmemory 256mb

# Eviction policy (DO NOT evict - we want all data)
maxmemory-policy noeviction
```

### Persistence Strategy

**Recommendation**: Use **both** RDB and AOF

- **RDB (Snapshotting)**: Fast recovery, point-in-time backups
- **AOF (Append-Only File)**: Maximum durability, every write logged

```conf
# RDB Configuration
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
dir /opt/homebrew/var/db/redis/

# AOF Configuration
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec  # Balance between performance and durability
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

### Connection Pooling

Redis client config in RedisManager:
```javascript
{
  socket: {
    connectTimeout: 5000,
    keepAlive: 5000,
    noDelay: true
  },
  commandsQueueMaxLength: 1000,  // Allow 1000 commands to queue
  readonly: false,
  enableOfflineQueue: true,
  maxRetriesPerRequest: 3
}
```

---

## 5. Migration Safety & Rollback Strategy

### Dual-Write Period (Optional)

If you want extra safety, implement a dual-write period:

1. **Phase A**: Write to both files and Redis (read from files)
2. **Phase B**: Write to both, read from Redis (verify consistency)
3. **Phase C**: Write to Redis only (files become backups)

**Implementation**: Add `dual_write_enabled` flag to config.

### Rollback Strategy

If Redis migration fails:

1. **Immediate Rollback**:
   ```bash
   # Revert code to file-based version
   git checkout main node_api_service/routes/negotiations.js

   # Restart service
   pm2 restart node_api_service
   ```

2. **Data Rollback**:
   ```bash
   # Run rollback script
   node node_api_service/scripts/rollback_redis_to_files.js

   # Verify files
   ls -lh data/negotiations/
   ```

3. **Redis Cleanup** (if needed):
   ```bash
   redis-cli FLUSHDB
   ```

### Data Validation

After migration, run validation script:
```bash
node node_api_service/scripts/validate_redis_migration.js
```

Checks:
- File count == Redis account count
- Sample negotiation data matches (spot check)
- All trade offers present
- All friends present
- Timestamps preserved

---

## 6. Performance Monitoring

### Before Migration Baseline

Capture current metrics:
- Average atomic-upsert latency: **~100-500ms** (from logs)
- Lock acquisition time: **~50-200ms**
- File write time: **~50-300ms**
- Concurrent update serialization: **6-12 seconds** for 80 accounts

### After Migration Targets

Expected Redis performance:
- Average atomic-upsert latency: **<10ms**
- Redis command execution: **<1ms**
- No lock acquisition needed
- Concurrent update time: **~100-200ms** for 80 accounts (true concurrency)

### Metrics to Track

Add to logs:
```javascript
{
  operation: 'atomic_upsert_trade_offer',
  steam_id: '76561199027634480',
  trade_offer_id: '6789123456',
  redis_command_time_ms: 2.5,
  total_time_ms: 5.8,
  operation_type: 'updated',
  timestamp: '2024-12-22T10:30:00.000Z'
}
```

Use winston logger to track:
- Command latency histogram
- Error rate
- Connection health
- Memory usage

---

## 7. Error Handling Strategy

### Connection Errors

**Scenario**: Redis connection lost during operation

**Strategy**:
```javascript
try {
  await redisManager.atomicUpsertTradeOffer(steamId, tradeOfferData);
} catch (error) {
  if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
    // Log error, alert ops team
    logger.error('Redis connection failed', { error, steamId });

    // Return 503 Service Unavailable (do NOT fallback to files)
    return res.status(503).json({
      success: false,
      error: 'Negotiation service temporarily unavailable',
      retry_after: 10  // seconds
    });
  }
  throw error;  // Unexpected error
}
```

**No Fallback to Files**: Maintain single source of truth. If Redis is down, service is down.

### Data Corruption

**Scenario**: Redis returns invalid JSON

**Strategy**:
```javascript
try {
  const offerData = JSON.parse(redisOfferJson);
} catch (parseError) {
  logger.error('Redis data corruption detected', {
    steamId,
    tradeOfferId,
    invalidJson: redisOfferJson
  });

  // Alert ops, but continue (log and skip this offer)
  return null;
}
```

### Lua Script Errors

**Scenario**: Lua script fails mid-execution

**Strategy**:
- Lua scripts are atomic - either all succeed or all fail
- Log error details
- Return error to client with retry guidance

---

## 8. Success Criteria

### Technical Success

✅ Redis installed and configured with persistence
✅ All 7 endpoints migrated to Redis
✅ Lua scripts working for atomic operations
✅ Migration script successfully moves all data
✅ All tests passing (unit, integration, load)
✅ No file locks in codebase (file-manager.js no longer used for negotiations)

### Performance Success

✅ Atomic-upsert latency: **<10ms** (90th percentile)
✅ Concurrent updates: **80 accounts updating in <1 second** (vs. 6-12 seconds)
✅ Zero lock timeouts
✅ Redis memory usage: **<100MB** for typical workload

### Operational Success

✅ Redis persists data correctly (survive restart)
✅ Zero data loss during migration
✅ Graceful error handling (no crashes)
✅ Monitoring and alerting in place
✅ Documentation updated

---

## 9. Implementation Timeline

| Phase | Description | Estimated Time | Priority |
|-------|-------------|----------------|----------|
| 1 | Infrastructure Setup | 30 mins | P0 |
| 2 | Redis Manager Utility | 45 mins | P0 |
| 3 | Migration Utilities | 30 mins | P1 |
| 4 | Update Routes (atomic-upsert) | 30 mins | P0 |
| 4 | Update Routes (GET/POST) | 30 mins | P0 |
| 4 | Update Routes (other endpoints) | 30 mins | P1 |
| 5 | Configuration Updates | 15 mins | P0 |
| 6 | Testing | 60 mins | P0 |
| 7 | Production Migration | 30 mins | P0 |

**Total Estimated Time**: ~4 hours

**Critical Path**: Phases 1, 2, 4 (atomic-upsert), 6, 7 → **~2.5 hours**

---

## 10. Files to Create/Modify

### New Files

```
node_api_service/
├── utils/
│   └── redis-manager.js              # Redis connection manager
├── redis_scripts/
│   ├── atomic_upsert_trade_offer.lua # Atomic upsert Lua script
│   └── bulk_remove_friends.lua       # Bulk remove Lua script
└── scripts/
    ├── migrate_negotiations_to_redis.js     # Migration script
    ├── rollback_redis_to_files.js          # Rollback script
    └── validate_redis_migration.js         # Validation script
```

### Modified Files

```
node_api_service/
├── routes/
│   └── negotiations.js               # Replace file operations with Redis
├── config/
│   └── config.json                   # Add Redis configuration
├── server.js                         # Initialize RedisManager
└── package.json                      # Add redis dependency

automate_trading/
└── config/
    └── config.js                     # Add Redis awareness (optional)

.env                                  # Add Redis environment variables
```

### Deprecated Files (after migration)

```
node_api_service/utils/file-manager.js  # No longer used for negotiations
                                        # (may still be used for other files)
```

---

## 11. Key Architectural Decisions

### Decision 1: Redis Data Structure

**Chosen**: Hash for offers, Hash for friends, Sets for indexes

**Rationale**:
- Granular access (update single offer without loading all)
- Atomic operations (HSET, HMSET)
- Memory efficient
- O(1) lookups

**Alternative Considered**: Single JSON string per account
- **Rejected**: Would require read-modify-write pattern, lose atomicity

### Decision 2: Lua Scripts vs. Transactions

**Chosen**: Lua scripts for complex operations (atomic-upsert)

**Rationale**:
- True atomicity (no other commands can interleave)
- Server-side execution (no network round-trips)
- Can include conditional logic

**Alternative Considered**: MULTI/EXEC transactions
- **Rejected**: Cannot include conditional logic (e.g., merge state_history)

### Decision 3: No Fallback to Files

**Chosen**: Redis is single source of truth, no fallback

**Rationale**:
- Avoid split-brain scenarios
- Simpler codebase
- Clear failure mode (service unavailable)

**Alternative Considered**: Fallback to files on Redis failure
- **Rejected**: Risk of data inconsistency, complex error handling

### Decision 4: AOF + RDB Persistence

**Chosen**: Both appendonly (AOF) and snapshots (RDB)

**Rationale**:
- Maximum durability (AOF)
- Fast recovery (RDB)
- Belt-and-suspenders approach

**Alternative Considered**: RDB only
- **Rejected**: Could lose data between snapshots

### Decision 5: Migration Strategy

**Chosen**: Big-bang migration (all at once, no dual-write)

**Rationale**:
- Simpler implementation
- No synchronization complexity
- Fast to production

**Alternative Considered**: Gradual migration with dual-write
- **Rejected**: More complex, longer timeline, risk of inconsistency

---

## 12. Risk Analysis

### Risk 1: Redis Crashes During Production

**Likelihood**: Low (Redis is very stable)
**Impact**: High (service unavailable)

**Mitigation**:
- Configure Redis persistence (RDB + AOF)
- Monitor Redis health (systemd/pm2 auto-restart)
- Keep file backups for emergency rollback

### Risk 2: Data Migration Corruption

**Likelihood**: Low (migration script validates)
**Impact**: High (data loss)

**Mitigation**:
- Backup all JSON files before migration
- Dry-run migration first
- Validate migration with spot checks
- Keep rollback script ready

### Risk 3: Performance Degradation

**Likelihood**: Very Low (Redis is faster than files)
**Impact**: Medium (user experience)

**Mitigation**:
- Load test before production
- Monitor latency metrics
- Have rollback plan

### Risk 4: Redis Memory Overflow

**Likelihood**: Low (current data is small)
**Impact**: Medium (eviction or OOM)

**Mitigation**:
- Configure maxmemory with noeviction policy
- Monitor memory usage
- Alert at 80% memory threshold

### Risk 5: Lua Script Bugs

**Likelihood**: Medium (new code)
**Impact**: High (data corruption or deadlock)

**Mitigation**:
- Unit test Lua scripts in isolation
- Integration test with real data
- Code review Lua scripts carefully
- Have rollback plan

---

## 13. Post-Migration Checklist

After migration completes:

- [ ] Verify all 80+ accounts migrated to Redis
- [ ] Spot-check 10 random negotiations for data integrity
- [ ] Run health check endpoint for all accounts
- [ ] Monitor atomic-upsert latency (should be <10ms)
- [ ] Verify no file lock errors in logs
- [ ] Check Redis memory usage (should be <100MB)
- [ ] Verify Redis persistence files exist (dump.rdb, appendonly.aof)
- [ ] Test Redis restart recovery
- [ ] Update documentation
- [ ] Archive negotiation JSON backups
- [ ] Remove file-manager.js from negotiations.js imports (if not used elsewhere)
- [ ] Add Redis monitoring to ops dashboard
- [ ] Celebrate! 🎉

---

## 14. Future Enhancements

Once Redis migration is stable:

1. **Redis Clustering**: If scale exceeds single Redis instance
2. **Redis Sentinel**: Automatic failover for high availability
3. **Caching Layer**: Add in-memory cache in Node.js for frequently accessed data
4. **Real-time Updates**: Use Redis Pub/Sub for live negotiation updates
5. **Analytics**: Use Redis Streams for event sourcing and analytics
6. **Sharding**: Partition negotiations by steamId hash for horizontal scaling

---

## Appendix A: Redis Commands Reference

### Common Operations

```bash
# Connect to Redis
redis-cli

# Check memory usage
redis-cli INFO memory

# Count keys
redis-cli DBSIZE

# Get all negotiation accounts
redis-cli SMEMBERS negotiation:accounts

# Get specific offer
redis-cli HGET negotiation:offers:76561199027634480 "6789123456"

# Get all offers for account
redis-cli HGETALL negotiation:offers:76561199027634480

# Get account metadata
redis-cli HGETALL negotiation:meta:76561199027634480

# Monitor commands in real-time
redis-cli MONITOR

# Benchmark performance
redis-cli --intrinsic-latency 100
redis-benchmark -t set,get -n 100000 -q
```

### Backup and Restore

```bash
# Manual save
redis-cli SAVE

# Background save
redis-cli BGSAVE

# Check last save time
redis-cli LASTSAVE

# Restore from backup
# 1. Stop Redis
brew services stop redis

# 2. Replace dump.rdb
cp backup/dump.rdb /opt/homebrew/var/db/redis/dump.rdb

# 3. Start Redis
brew services start redis
```

---

**End of Plan**
