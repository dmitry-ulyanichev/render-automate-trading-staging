# LanguageWorker Documentation

## Overview

The LanguageWorker is a specialized component of the TradeBot orchestration system that automatically detects the preferred language of Steam friends to optimize communication strategies. It processes language detection tasks from the `language_queue` and updates both the orchestration context and persistent negotiation JSON files.

## Current Implementation

### Primary Method: Player Summaries Analysis

The worker uses Steam Web API calls to analyze geographic data:

1. **GetFriendList** - Retrieves the target friend's friends list
2. **GetPlayerSummaries** - Analyzes country codes for up to 100 Steam IDs (target friend + 99 of their friends)
3. **Country-to-Language Mapping** - Maps countries to languages using a weighted scoring system
4. **Language Resolution** - Determines the most likely language using scoring rules and specificity logic

### Fallback Method: Player Name Language Detection

When country data is unavailable (private profiles, API limitations), the worker uses Unicode character analysis on the friend's display name:

1. **Script Detection** - Identifies non-Latin scripts (Cyrillic, CJK, Arabic, Hebrew, Thai, Greek, etc.)
2. **Unique Character Detection** - Identifies language-specific Latin characters (ñ for Spanish, ł for Polish, etc.)
3. **Special Character Detection** - Falls back to general diacritics (ü, é, ç, etc.)

**Detected Languages via Player Name:**
- **Script-based (95% confidence)**: Russian, Chinese, Japanese, Korean, Arabic, Hebrew, Thai, Greek, Hindi, Tamil, Bengali
- **Unique characters (90% confidence)**: Spanish (ñ), Polish (ł), Turkish (ş), Vietnamese (đ/ư), Swedish/Nordic (ø/å), Czech (ř), Hungarian (ő), Romanian (ș), Portuguese (õ), German (ß)
- **General special chars (60% confidence)**: German (ü), French (é), Portuguese (ã)

**Module**: `automate_trading/utils/player_name_language_detector.js`

### Detection Priority

The language resolution follows this priority:

1. **Strong country data (score ≥ 5)** → Use country-based analysis
2. **Weak country data (score < 5) + high-confidence player name (≥85%)** → Prefer player name
3. **No country data + player name detected** → Use player name detection
4. **No data available** → Fall back to English

### Scoring System

- **Primary friend's country**: Full weight (4 = predominant, 3-2 = secondary languages)
- **Friends' countries**: 75% weight to reduce noise
- **Player name detection**: 6-10 score based on confidence (0.6-1.0 × 10)
- **Specificity rule**: Non-English languages preferred in tie-breakers
- **Fallback**: English with score 0 when no data available

### Rate Limiting & Resilience

- **Per-endpoint rate limiting**: Separate adaptive intervals for GetFriendList and GetPlayerSummaries (15s → 4min)
- **Partial data persistence**: Survives Steam API failures between calls
- **Exponential backoff**: 1, 2, 4 minute retry intervals
- **Graceful degradation**: Falls back to player name detection, then English for private profiles or API failures

### Data Persistence

Updates two locations:
- **Orchestration context**: For current task processing
- **Negotiation JSON**: For long-term persistence across sessions

## Supported Countries & Languages

The system maps 50+ countries to their primary and secondary languages, including:
- **Europe**: German, French, Spanish, Italian, English, Portuguese, Dutch, Polish, etc.
- **Americas**: English, Spanish, Portuguese, French
- **Asia**: Russian, Ukrainian, Chinese, Japanese, Korean, Hindi, etc.
- **Multilingual countries**: Belgium (Dutch/French/German), Switzerland (German/French/Italian), Canada (English/French)

## Future Enhancement Methods

### 1. Text Analysis Method (`text_analysis`)
**Purpose**: Analyze profile descriptions, usernames, and message content
**Implementation approach**:
- Steam profile text parsing
- Message history analysis using NLP libraries
- Username linguistic pattern detection
- Steam review/comment language analysis

**Advantages**: Works with private profiles, higher accuracy for multilingual users

### 2. AI Analysis Method (`ai_analysis`)  
**Purpose**: Use LLM to analyze communication patterns and context
**Implementation approach**:
- Feed chat history to language detection models
- Analyze Steam profile comprehensive data
- Cross-reference multiple data sources for confidence scoring
- Use conversation context clues

**Advantages**: Handles nuanced cases, slang detection, code-switching users

### 3. Selenium Scraping Method (`selenium_scraping`)
**Purpose**: Browser automation for detailed profile analysis
**Implementation approach**:
- Automated Steam profile navigation
- Screenshots of profile content for OCR
- Friends activity feed analysis
- Steam group memberships language analysis

**Advantages**: Access to visual data, bypasses some API limitations

## Architecture Decisions

### Extensible Method System
The worker uses a plugin-like architecture where new detection methods can be added without modifying core logic:

```javascript
switch (method) {
  case 'player_summaries': // ✅ Implemented
  case 'text_analysis':    // 🔄 Future
  case 'ai_analysis':      // 🔄 Future  
  case 'selenium_scraping': // 🔄 Future
}
```

### Method Selection Strategy
Future logic could dynamically choose methods based on:
- **Profile privacy settings**: text_analysis for private profiles
- **Negotiation value**: ai_analysis for high-value trades
- **Previous method failures**: selenium_scraping as last resort
- **Performance requirements**: player_summaries for speed

### Confidence Scoring
Multiple methods could be combined with weighted confidence scores:
- Steam API country data: High confidence for geographic matching
- Text analysis: Medium confidence, varies by content amount
- AI analysis: High confidence for conversation context
- Selenium scraping: Variable confidence based on profile completeness

## Integration Points

### Queue Management
- Processes tasks from `language_queue`
- Updates `orchestration_queue` pending tasks
- Supports task retry with exponential backoff

### Steam API Integration
- Uses centralized `SteamApiManager` with per-endpoint rate limiting
- Shares rate limit state across all workers
- Handles 401 errors for private profiles gracefully

### Data Persistence
- Updates negotiation JSON via `HttpClient`
- Maintains task state in `partial_data` for resume capability
- Logs detailed statistics for monitoring and optimization

## Performance Characteristics

- **Processing speed**: 2-3 tasks per cycle (3-second intervals)
- **Steam API calls**: 2 calls per successful detection
- **Memory usage**: Minimal - processes tasks individually
- **Error handling**: Non-blocking - failures don't stop orchestration flow
- **Scalability**: Designed for distributed deployment across multiple instances