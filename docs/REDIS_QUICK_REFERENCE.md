# Redis Migration - Quick Reference Card

## Remote Server Deployment - Essential Commands

### 1. Install Redis
```bash
# Ubuntu/Debian
sudo apt update && sudo apt install redis-server -y

# CentOS/RHEL
sudo yum install redis -y
```

### 2. Configure Redis
```bash
sudo nano /etc/redis/redis.conf
```

Add/modify:
```conf
bind 127.0.0.1
requirepass YOUR_PASSWORD
appendonly yes
appendfsync everysec
maxmemory 256mb
maxmemory-policy noeviction
```

### 3. Start Redis
```bash
sudo systemctl start redis
sudo systemctl enable redis
sudo systemctl status redis
```

### 4. Backup Existing Data
```bash
cd /path/to/tradebot
mkdir -p backups
tar -czf backups/negotiations_backup_$(date +%Y%m%d_%H%M%S).tar.gz data/negotiations/
```

### 5. Sync Code from Local
```bash
# From local machine:
rsync -avz node_api_service/ user@remote:/path/to/tradebot/node_api_service/
rsync -avz package.json user@remote:/path/to/tradebot/
```

### 6. Install Redis Package
```bash
# On remote server:
cd /path/to/tradebot
npm install redis@^4.7.0
```

### 7. Add Redis Password to .env
```bash
nano .env
```

Add:
```env
REDIS_PASSWORD=YOUR_PASSWORD
```

### 8. Run Migration
```bash
node node_api_service/scripts/migrate_negotiations_to_redis.js
```

### 9. Restart Service
```bash
pm2 restart node_api_service
# or
sudo systemctl restart node_api_service
```

### 10. Verify Deployment
```bash
# Check logs
pm2 logs node_api_service --lines 50

# Should see:
# ✅ Redis manager initialized
# 📖 Redis reads: DISABLED (dual-write mode, files are primary)
```

---

## Testing Commands

### Test Endpoint
```bash
STEAM_ID="76561199027634480"
API_KEY="YOUR_API_KEY"

curl -X GET -H "X-API-Key: $API_KEY" \
  "http://127.0.0.1:3001/negotiations/$STEAM_ID"
```

### Verify Redis Data
```bash
redis-cli
AUTH YOUR_PASSWORD
SMEMBERS negotiation:accounts
HGETALL negotiation:meta:76561199027634480
exit
```

### Check Redis Memory
```bash
redis-cli INFO memory | grep used_memory_human
```

---

## Enable Redis Reads (After 24h Testing)

### Edit Config
```bash
nano node_api_service/config/config.json
```

Change:
```json
"use_for_reads": true
```

### Restart
```bash
pm2 restart node_api_service
```

### Verify
```bash
pm2 logs | grep "Redis reads: ENABLED"
```

---

## Monitor Performance

### Check Atomic Upsert Times
```bash
tail -f node_api_service/logs/*.log | grep "Redis atomic upsert"

# Expected: <10ms per operation
```

### Monitor Redis Commands
```bash
redis-cli MONITOR
```

---

## Rollback Commands

### Disable Redis
```bash
nano node_api_service/config/config.json
# Set: "enabled": false

pm2 restart node_api_service
```

### Restore Data
```bash
tar -xzf backups/negotiations_backup_YYYYMMDD_HHMMSS.tar.gz -C /path/to/tradebot/
```

---

## Redis Maintenance

### Manual Backup
```bash
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb /var/backups/redis/dump_$(date +%Y%m%d).rdb
```

### Check Redis Status
```bash
sudo systemctl status redis
redis-cli PING
```

### Restart Redis
```bash
sudo systemctl restart redis
```

---

## Key Files

| File | Purpose |
|------|---------|
| `DEPLOYMENT_GUIDE.md` | Full deployment instructions |
| `REDIS_MIGRATION_SUMMARY.md` | What was changed and why |
| `REDIS_MIGRATION_PLAN.md` | Technical details |
| `node_api_service/config/config.json` | Redis configuration |
| `node_api_service/scripts/migrate_negotiations_to_redis.js` | Migration script |

---

## Configuration Flags

### Phase 1 (Default)
```json
"redis": { "enabled": true, "use_for_reads": false }
```
**Writes**: Files + Redis | **Reads**: Files

### Phase 2 (After testing)
```json
"redis": { "enabled": true, "use_for_reads": true }
```
**Writes**: Files + Redis | **Reads**: Redis

### Rollback
```json
"redis": { "enabled": false }
```
**Writes**: Files only | **Reads**: Files

---

## Expected Performance

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Atomic-upsert | 100-500ms | <10ms | **10-50x** |
| 80 concurrent | 8-12s | <1s | **8-12x** |
| Lock contention | High | None | **Eliminated** |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Connection refused | `sudo systemctl start redis` |
| NOAUTH error | Add password to `.env` |
| Out of memory | Increase `maxmemory` in `redis.conf` |
| Migration failed | Check JSON file validity |
| `redis_written: false` | Check Redis logs and memory |

---

## Support

1. Review logs: `pm2 logs node_api_service`
2. Check Redis: `redis-cli INFO stats`
3. Read deployment guide for detailed troubleshooting

---

**Ready to deploy? Follow DEPLOYMENT_GUIDE.md step-by-step!**
