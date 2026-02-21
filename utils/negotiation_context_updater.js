// automate_trading/utils/negotiation_context_updater.js
class NegotiationContextUpdater {
  constructor(config, logger, httpClient) {
    this.config = config;
    this.logger = logger;
    this.httpClient = httpClient;
  }

  /**
   * Update negotiation context via HTTP API
   * Replaces the method from OrchestrationWorker
   */
  async updateNegotiationContext(ourSteamId, friendSteamId, updates) {
    try {
      // Load current negotiations
      const currentNegotiations = await this.httpClient.loadNegotiations(ourSteamId);
      
      // Ensure account-level fields exist
      if (!currentNegotiations.trade_offers) {
        currentNegotiations.trade_offers = [];
      }
      if (!currentNegotiations.trade_offers_updated_at) {
        currentNegotiations.trade_offers_updated_at = null;
      }

      // Ensure negotiation exists for this friend
      if (!currentNegotiations.negotiations[friendSteamId]) {
        // Create new negotiation if it doesn't exist
        currentNegotiations.negotiations[friendSteamId] = {
          friend_steam_id: friendSteamId,
          state: 'initiating',
          followUpCount: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [],
          objective: null,
          source: null,
          inventory_private: null,
          inventory: null,
          inventory_updated_at: null,
          redirected_to: [],
          language: null,
          referred_from_messages: [],
          ai_requested_actions: null,
          base_accounts_checked_at: null,
          referrer_checked: false
        };
      }

      // Separate account-level and friend-level updates
      const accountLevelUpdates = {};
      const friendLevelUpdates = {};

      for (const [key, value] of Object.entries(updates)) {
        if (key === 'trade_offers' || key === 'trade_offers_updated_at') {
          accountLevelUpdates[key] = value;
        } else {
          friendLevelUpdates[key] = value;
        }
      }

      // Apply account-level updates
      if (Object.keys(accountLevelUpdates).length > 0) {
        Object.assign(currentNegotiations, accountLevelUpdates);
      }

      // Apply friend-level updates
      Object.assign(currentNegotiations.negotiations[friendSteamId], friendLevelUpdates);
      currentNegotiations.negotiations[friendSteamId].updated_at = new Date().toISOString();
      
      // Save back via HTTP API
      await this.httpClient.saveNegotiations(ourSteamId, currentNegotiations);
      
      this.logger.info(`Updated negotiation context for ${ourSteamId} -> ${friendSteamId}`);
      
    } catch (error) {
      this.logger.error(`Failed to update negotiation context: ${error.message}`);
      throw error;
    }
  }
}

module.exports = NegotiationContextUpdater;