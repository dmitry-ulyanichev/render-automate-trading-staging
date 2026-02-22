# Redis Migration Deployment Guide

## Overview

This guide will walk you through deploying the Redis migration to your **remote server**. The code has been updated locally with a **dual-write** approach:

- **Phase 1** (Current): Writes to BOTH files AND Redis, reads from files (safe rollout)
- **Phase 2** (After testing): Reads from Redis, still writes to both (verify Redis works)
- **Phase 3** (Final): Remove file logic, Redis only (maximum performance)

---

## Pre-Deployment Checklist

Before starting, ensure you have:

- [ ] SSH access to the remote server
- [ ] Sudo/root privileges for installing Redis
- [ ] Node.js v14+ installed on remote server
- [ ] PM2 or systemd for process management
- [ ] Backup of existing negotiation JSON files

---

## Part 1: Remote Server Setup

### Step 1: Install Redis on Remote Server

SSH into your remote server:

```bash
ssh user@your-remote-server
```

Install Redis:

```bash
# For Ubuntu/Debian
sudo apt update
sudo apt install redis-server -y

# For CentOS/RHEL
sudo yum install redis -y

# For macOS (if testing locally first)
brew install redis
```

Verify Redis is installed:

```bash
redis-cli --version
```

### Step 2: Configure Redis for Production

Edit Redis configuration:

```bash
sudo nano /etc/redis/redis.conf
# Or on some systems: /etc/redis.conf
```

**Critical settings to configure:**

```conf
# Bind to localhost only (secure)
bind 127.0.0.1

# Set a password (IMPORTANT for production)
requirepass YOUR_STRONG_PASSWORD_HERE

# Enable persistence (BOTH methods for maximum safety)
save 900 1          # Save if 1 key changed in 15 minutes
save 300 10         # Save if 10 keys changed in 5 minutes
save 60 10000       # Save if 10000 keys changed in 1 minute

# AOF persistence (append-only file)
appendonly yes
appendfsync everysec

# Memory limit (adjust based on your data size)
# Estimate: 100 accounts × 50 friends × 5KB ≈ 25MB
# Add trade offers: 100 accounts × 200 offers × 2KB ≈ 40MB
# Set to 256MB for headroom
maxmemory 256mb
maxmemory-policy noeviction  # DO NOT evict data, return errors instead

# Log level
loglevel notice
logfile /var/log/redis/redis-server.log

# RDB persistence location
dir /var/lib/redis
dbfilename dump.rdb
```

**Save and exit** (`Ctrl+X`, then `Y`, then `Enter`)

### Step 3: Start Redis and Enable Auto-Start

```bash
# Start Redis
sudo systemctl start redis-server

# Enable Redis to start on boot
sudo systemctl enable redis-server

# Check Redis status
sudo systemctl status redis-server
```

Expected output: `active (running)`

### Step 4: Test Redis Connection

```bash
# Connect to Redis
redis-cli

# Authenticate (if you set a password)
AUTH YOUR_STRONG_PASSWORD_HERE

# Test
PING
```

Expected response: `PONG`

```bash
# Exit Redis CLI
exit
```

---

## Part 2: Deploy Updated Code

### Step 5: Backup Existing Data

**CRITICAL: Backup before deploying!**

```bash
# On remote server
cd /path/to/your/tradebot

# Create backup directory
mkdir -p backups

# Backup negotiation files
tar -czf backups/negotiations_backup_$(date +%Y%m%d_%H%M%S).tar.gz data/negotiations/

# Verify backup
ls -lh backups/
```

### Step 6: Sync Local Code to Remote Server

From your **local machine**, sync the updated files:

```bash
# Option A: Using rsync (recommended)
rsync -avz --progress \
  node_api_service/ \
  user@your-remote-server:/path/to/tradebot/node_api_service/

# Sync updated package.json
rsync -avz package.json \
  user@your-remote-server:/path/to/tradebot/package.json

# Option B: Using scp
scp -r node_api_service/ user@your-remote-server:/path/to/tradebot/
scp package.json user@your-remote-server:/path/to/tradebot/

# Option C: Using git (if you have a git repo)
# On local machine:
git add .
git commit -m "Add Redis dual-write support for negotiations"
git push origin main

# On remote server:
git pull origin main
```

### Step 7: Install Redis NPM Package

Back on the **remote server**:

```bash
cd /path/to/your/tradebot

# Install the Redis client package
npm install redis@^4.7.0

# Verify installation
npm list redis
```

Expected output: `redis@4.7.0` (or similar version)

### Step 8: Configure Redis Connection

Create or update `.env` file on remote server:

```bash
nano .env
```

Add Redis configuration (if not already in `.env`):

```env
# Redis Configuration
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=YOUR_STRONG_PASSWORD_HERE
REDIS_DB=0
REDIS_CONNECTION_TIMEOUT=5000
REDIS_COMMAND_TIMEOUT=3000
```

**Note**: The password here should match the `requirepass` you set in `redis.conf`.

**Save and exit**.

### Step 9: Verify Configuration Files

Check that `node_api_service/config/config.json` has Redis settings:

```bash
cat node_api_service/config/config.json | grep -A 10 '"redis"'
```

Expected output should include:

```json
"redis": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 6379,
  "password": "",
  "db": 0,
  "connection_timeout": 5000,
  "command_timeout": 3000,
  "use_for_reads": false,
  ...
}
```

**IMPORTANT**: `use_for_reads` should be `false` for Phase 1 (dual-write mode).

---

## Part 3: Migrate Existing Data to Redis

### Step 10: Run Migration Script

This script will backfill all existing negotiation JSON files into Redis:

```bash
cd /path/to/your/tradebot

# Run the migration script
node node_api_service/scripts/migrate_negotiations_to_redis.js
```

Expected output:

```
============================================================
  NEGOTIATION DATA MIGRATION: JSON FILES → REDIS
============================================================

📡 Connecting to Redis...
✅ Connected to Redis

📂 Scanning for negotiation files...
Found 80 negotiation files

🚀 Starting migration...
  [1/80] Migrating 76561199027634480... ✓
  [2/80] Migrating 76561199027634481... ✓
  ...
  [80/80] Migrating 76561199027634560... ✓

🔍 Verifying sample migrations...
  ✓ 76561199027634480: 12 offers, 25 friends
  ...

============================================================
  MIGRATION SUMMARY
============================================================

Total Files:          80
Successful:           80
Failed:               0
Skipped:              0

Total Trade Offers:   1200
Total Friends:        2000

Duration:             12.50s
Avg per account:      156ms

============================================================

✅ Migration completed successfully!

Next steps:
  1. Verify Redis data: redis-cli SMEMBERS negotiation:accounts
  2. Test endpoints with dual-read enabled
  3. Monitor logs for any Redis errors
```

If you see errors, **do not proceed**. Investigate and fix the errors first.

### Step 11: Verify Migration

```bash
# Connect to Redis
redis-cli

# Authenticate
AUTH YOUR_STRONG_PASSWORD_HERE

# Check how many accounts were migrated
SMEMBERS negotiation:accounts

# Pick a sample Steam ID and verify it
HGETALL negotiation:meta:76561199027634480

# Check trade offers for that account
HLEN negotiation:offers:76561199027634480

# Check friends for that account
SCARD negotiation:friends:index:76561199027634480

# Exit
exit
```

All commands should return data. If any return `(empty array)` or `(integer) 0`, the migration may have failed.

---

## Part 4: Restart Services

### Step 12: Restart Node API Service

```bash
# If using PM2
pm2 restart node_api_service

# If using systemd
sudo systemctl restart node_api_service

# If running manually
# Stop the current process (Ctrl+C or kill PID)
# Then start:
node node_api_service/main.js
```

### Step 13: Check Service Logs

```bash
# If using PM2
pm2 logs node_api_service --lines 50

# If using systemd
sudo journalctl -u node_api_service -f -n 50

# If using manual logs
tail -f node_api_service/logs/*.log
```

**Look for these log messages:**

```
✅ Redis manager initialized
📖 Redis reads: DISABLED (dual-write mode, files are primary)
🚀 Node API Service started successfully
```

If you see errors like `Failed to initialize Redis manager`, check:
- Redis is running: `sudo systemctl status redis`
- Password is correct in `.env`
- Firewall allows localhost connections

---

## Part 5: Testing Phase 1 (Dual-Write Mode)

### Step 14: Test Endpoints

**Current behavior**: Reads from files, writes to BOTH files AND Redis.

Test the critical endpoint:

```bash
# Replace with an actual Steam ID from your system
STEAM_ID="76561199027634480"
API_KEY="fa46kPOVnHT2a4aFmQS11dd70290"  # From your config

# Test: Load negotiations (should read from file)
curl -X GET \
  -H "X-API-Key: $API_KEY" \
  "http://127.0.0.1:3001/negotiations/$STEAM_ID"

# Expected response includes: "source": "file"
```

Test atomic-upsert (should write to BOTH):

```bash
# Simulate a trade offer update
curl -X POST \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "trade_offer_data": {
      "trade_offer_id": "test_12345",
      "state": "Active",
      "is_our_offer": true,
      "items_to_give": [],
      "items_to_receive": [],
      "partner_steam_id": "76561198123456789",
      "created_at": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'",
      "updated_at": "'$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
    }
  }' \
  "http://127.0.0.1:3001/negotiations/$STEAM_ID/atomic-upsert-trade-offer"

# Expected response includes:
# "success": true
# "operation": "added" (or "updated")
# "redis_written": true
```

### Step 15: Verify Dual-Write

Check that the data was written to BOTH:

**File:**
```bash
cat data/negotiations/$STEAM_ID.json | jq '.trade_offers[] | select(.trade_offer_id=="test_12345")'
```

**Redis:**
```bash
redis-cli
AUTH YOUR_STRONG_PASSWORD_HERE
HGET negotiation:offers:76561199027634480 "test_12345"
exit
```

Both should return the same trade offer data.

### Step 16: Monitor for 24 Hours

**Leave in dual-write mode for at least 24 hours** to ensure:
- No Redis connection errors
- All writes succeed to both files and Redis
- No performance degradation

Monitor logs:

```bash
# Watch for Redis errors (in the logs/ dir)
tail -f node_api.log | grep -i redis
tail -n 100 node_api.log | grep -i redis
tail -f node_api_error.log | grep -i redis
tail -n 100 node_api_error.log | grep -i redis


# Watch for dual-write confirmations (in the logs/ dir)
tail -f node_api_http.log | grep "Dual-write"
tail -n 1000 node_api_http.log | grep "Dual-write"
```

---

## Part 6: Enable Redis Reads (Phase 2)

**Only proceed if Phase 1 ran successfully for 24+ hours with no errors.**

### Step 17: Enable Redis for Reads

Edit `node_api_service/config/config.json`:

```bash
nano node_api_service/config/config.json
```

Change `use_for_reads` from `false` to `true`:

```json
"redis": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 6379,
  "password": "",
  "db": 0,
  "connection_timeout": 5000,
  "command_timeout": 3000,
  "use_for_reads": true,     ← CHANGE THIS
  ...
}
```

**Save and exit**.

### Step 18: Restart Service

```bash
pm2 restart node_api_service
# or
sudo systemctl restart node-api-service
```

Check logs for:

```
📖 Redis reads: ENABLED (primary source)
```

### Step 19: Test Redis Reads

```bash
# Test: Load negotiations (should now read from Redis)
curl -X GET \
  -H "X-API-Key: $API_KEY" \
  "http://127.0.0.1:3001/negotiations/$STEAM_ID"

# Expected response includes: "source": "redis"
```

### Step 20: Measure Performance Improvement

**Before Redis (from logs in Phase 1):**
- Average atomic-upsert time: ~100-500ms (with file locks)

**After Redis (check logs now):**
```bash
tail -f node_api_service/logs/*.log | grep "Redis atomic upsert"
```

Expected: `<10ms` per atomic upsert

**Verify concurrency:**
- With file locks: 80 accounts × 100ms = 8+ seconds of serialization
- With Redis: 80 accounts can update concurrently in <1 second

### Step 21: Monitor for Another 24 Hours

Watch for:
- Redis read errors
- Data consistency (spot-check files vs Redis)
- Performance improvements (check logs for faster operations)

If any errors occur:
1. Change `use_for_reads` back to `false`
2. Restart service
3. Investigate the error
4. Fix and retry

---

## Part 7: Remove File Logic (Phase 3 - Optional)

**Only proceed after Phase 2 is stable for several days.**

This phase is **optional** and can be done later. It removes all file operations for maximum performance.

### Step 22: Archive File Operations Code

This step requires code changes not included in this deployment. To implement:

1. Remove `withFileLock` calls from `negotiations.js`
2. Remove file write operations
3. Keep Redis operations only
4. Update tests

**Recommendation**: Keep dual-write for now. The file operations add minimal overhead compared to the Redis performance gains.

---

## Troubleshooting

### Issue: "Redis connection refused"

**Cause**: Redis not running or wrong host/port.

**Fix**:
```bash
sudo systemctl status redis
sudo systemctl start redis

# Check Redis is listening
sudo netstat -tlnp | grep 6379
```

### Issue: "NOAUTH Authentication required"

**Cause**: Redis has a password but you didn't provide it.

**Fix**: Add password to `.env`:
```env
REDIS_PASSWORD=YOUR_PASSWORD_HERE
```

### Issue: "redis_written": false in responses

**Cause**: Redis write failed but file write succeeded.

**Fix**:
1. Check logs for specific Redis error
2. Verify Redis has sufficient memory: `redis-cli INFO memory`
3. Check `maxmemory` policy in `redis.conf`

### Issue: Migration script fails for some accounts

**Cause**: Corrupted JSON files or invalid data.

**Fix**:
1. Check logs for which files failed
2. Manually inspect those JSON files
3. Fix or remove corrupted files
4. Re-run migration script

### Issue: Data mismatch between files and Redis

**Cause**: Dual-write failed silently.

**Fix**:
1. Check which source is correct
2. Re-run migration script to sync Redis from files:
```bash
node node_api_service/scripts/migrate_negotiations_to_redis.js
```

### Issue: Out of memory errors from Redis

**Cause**: `maxmemory` limit reached.

**Fix**:
1. Check current memory usage:
```bash
redis-cli INFO memory | grep used_memory_human
```

2. Increase `maxmemory` in `redis.conf`:
```conf
maxmemory 512mb  # or higher
```

3. Restart Redis:
```bash
sudo systemctl restart redis
```

---

## Rollback Procedure

If anything goes wrong and you need to rollback:

### Rollback Step 1: Disable Redis

Edit `node_api_service/config/config.json`:

```json
"redis": {
  "enabled": false,   ← CHANGE THIS
  ...
}
```

### Rollback Step 2: Restore Old Code (if needed)

```bash
# If you have git
git checkout main node_api_service/routes/negotiations.js

# Or restore from backup
cp backups/negotiations.js.backup node_api_service/routes/negotiations.js
```

### Rollback Step 3: Restart Service

```bash
pm2 restart node_api_service
# or
sudo systemctl restart node_api_service
```

### Rollback Step 4: Restore Data (if needed)

```bash
# Extract backup
tar -xzf backups/negotiations_backup_YYYYMMDD_HHMMSS.tar.gz -C /path/to/tradebot/
```

---

## Post-Deployment Checklist

After successful deployment:

- [ ] Redis is running and auto-starts on boot
- [ ] All negotiation files migrated to Redis
- [ ] Phase 1 (dual-write, file reads) tested successfully
- [ ] Phase 2 (dual-write, Redis reads) tested successfully
- [ ] Performance improvements verified (atomic-upsert <10ms)
- [ ] No file lock timeout errors in logs
- [ ] Concurrent operations work as expected
- [ ] Redis persistence configured (RDB + AOF)
- [ ] Redis backups automated (optional but recommended)
- [ ] Monitoring set up for Redis memory and errors

---

## Performance Benchmarks

### Expected Before/After Metrics:

| Metric | Before (File Locks) | After (Redis) | Improvement |
|--------|---------------------|---------------|-------------|
| Single atomic-upsert | 100-500ms | <10ms | **10-50x faster** |
| 80 concurrent updates | 8-12 seconds | <1 second | **8-12x faster** |
| Lock contention | High | None | **Eliminated** |
| Disk I/O operations | High | Minimal | **90% reduction** |

---

## Maintenance

### Redis Backups

Set up automated Redis backups:

```bash
# Create backup script
cat > /usr/local/bin/redis-backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/var/backups/redis"
mkdir -p $BACKUP_DIR
redis-cli BGSAVE
sleep 5
cp /var/lib/redis/dump.rdb $BACKUP_DIR/dump_$(date +%Y%m%d_%H%M%S).rdb
# Keep only last 7 days
find $BACKUP_DIR -name "dump_*.rdb" -mtime +7 -delete
EOF

chmod +x /usr/local/bin/redis-backup.sh

# Schedule daily backup at 3 AM
crontab -e
```

Add line:
```cron
0 3 * * * /usr/local/bin/redis-backup.sh
```

### Monitor Redis

```bash
# Check Redis status
redis-cli INFO stats

# Monitor commands in real-time
redis-cli MONITOR

# Check slow queries
redis-cli SLOWLOG GET 10
```

---

## Support

If you encounter issues not covered in this guide:

1. Check logs: `tail -f node_api_service/logs/*.log`
2. Check Redis logs: `sudo tail -f /var/log/redis/redis-server.log`
3. Verify Redis health: `redis-cli PING`
4. Review the REDIS_MIGRATION_PLAN.md file for technical details

---

## Summary

**Phase 1 (Current State)**:
- ✅ Code deployed with dual-write support
- ✅ Redis installed and configured
- ✅ Existing data migrated to Redis
- ✅ Writes go to BOTH files AND Redis
- ✅ Reads from files (safe fallback)

**Phase 2 (After 24h testing)**:
- Switch reads to Redis (`use_for_reads: true`)
- Still writes to both (safety net)
- Verify performance improvements

**Phase 3 (Future - Optional)**:
- Remove file write operations
- Redis becomes sole source of truth
- Maximum performance

🎉 **Congratulations! You've successfully deployed the Redis migration in dual-write mode.**
