// automate_trading/workers/helpers/trade_offer_data_transformer.js

/**
 * TradeOfferDataTransformer
 *
 * Pure data transformation utilities for trade offers
 * - Converts inventory items to Steam asset IDs
 * - Parses raw Steam API responses
 * - Transforms and simplifies trade offer data
 * - Handles Steam ID conversions
 */
class TradeOfferDataTransformer {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Convert inventory items (market_hash_name format) to Steam asset IDs
   * @param {Array} items - Array of items with market_hash_name and quantity
   * @param {Array} inventory - Aggregated inventory with assetids array
   * @returns {Array} - Array of Steam asset objects with assetid, appid, contextid, amount
   */
  convertItemsToAssets(items, inventory) {
    if (!items || items.length === 0) {
      return [];
    }

    if (!inventory || inventory.length === 0) {
      this.logger.error('TradeOfferDataTransformer: Cannot convert items - inventory is empty');
      return [];
    }

    const assets = [];

    for (const item of items) {
      const { market_hash_name, quantity } = item;
      const requestedQuantity = quantity || 1;

      // Find matching item in aggregated inventory
      const inventoryItem = inventory.find(invItem => invItem.market_hash_name === market_hash_name);

      if (!inventoryItem) {
        this.logger.error(`TradeOfferDataTransformer: Item not found in inventory: ${market_hash_name}`);
        continue;
      }

      // Check if assetids array exists
      if (!inventoryItem.assetids || inventoryItem.assetids.length === 0) {
        this.logger.error(`TradeOfferDataTransformer: No assetids found for item: ${market_hash_name}`);
        continue;
      }

      // Take the requested quantity of assetids
      const availableQuantity = inventoryItem.assetids.length;
      const quantityToTake = Math.min(requestedQuantity, availableQuantity);

      for (let i = 0; i < quantityToTake; i++) {
        const assetData = inventoryItem.assetids[i];
        assets.push({
          assetid: assetData.assetid,
          appid: assetData.appid || '730',
          contextid: assetData.contextid || '2',
          amount: 1
        });
      }

      if (requestedQuantity > availableQuantity) {
        this.logger.warn(`TradeOfferDataTransformer: Not enough quantity for ${market_hash_name}. Needed: ${requestedQuantity}, Available: ${availableQuantity}`);
      }
    }

    this.logger.debug(`TradeOfferDataTransformer: Converted ${items.length} item types to ${assets.length} asset instances`);
    return assets;
  }

  /**
   * Simplify item data - extract only essential fields
   * @param {Array} items - Full Steam item objects
   * @returns {Array} - Simplified item objects
   */
  simplifyItemData(items) {
    if (!items || items.length === 0) return [];

    return items.map(item => ({
      assetid: item.assetid,
      appid: item.appid || 730,
      contextid: item.contextid || '2',
      amount: item.amount || 1,
      market_hash_name: item.market_hash_name || item.name,
      name: item.name,
      type: item.type
    }));
  }

  /**
   * Parse raw Steam Web API trade offer to our JSON format
   * @param {Object} rawOffer - Raw offer from Steam Web API
   * @param {Object} descriptions - Item descriptions from API response
   * @returns {Object} - Trade offer in our JSON format
   */
  parseRawOfferToJSON(rawOffer, descriptions = {}) {
    // Map Steam state codes to readable names
    const stateNames = {
      1: 'Invalid',
      2: 'Active',
      3: 'Accepted',
      4: 'Countered',
      5: 'Expired',
      6: 'Canceled',
      7: 'Declined',
      8: 'InvalidItems',
      9: 'CreatedNeedsConfirmation',
      10: 'CanceledBySecondFactor',
      11: 'InEscrow'
    };

    // Convert accountid_other to steamid64
    const partnerSteamId64 = this.accountIdToSteamId64(rawOffer.accountid_other);

    // Parse items with simplified data
    const itemsToGive = (rawOffer.items_to_give || []).map(item => ({
      assetid: item.assetid,
      appid: item.appid || 730,
      contextid: item.contextid || '2',
      amount: item.amount || 1,
      market_hash_name: item.market_hash_name || descriptions[`${item.classid}_${item.instanceid}`]?.market_hash_name || '',
      name: item.name || descriptions[`${item.classid}_${item.instanceid}`]?.name || '',
      type: item.type || descriptions[`${item.classid}_${item.instanceid}`]?.type || ''
    }));

    const itemsToReceive = (rawOffer.items_to_receive || []).map(item => ({
      assetid: item.assetid,
      appid: item.appid || 730,
      contextid: item.contextid || '2',
      amount: item.amount || 1,
      market_hash_name: item.market_hash_name || descriptions[`${item.classid}_${item.instanceid}`]?.market_hash_name || '',
      name: item.name || descriptions[`${item.classid}_${item.instanceid}`]?.name || '',
      type: item.type || descriptions[`${item.classid}_${item.instanceid}`]?.type || ''
    }));

    return {
      trade_offer_id: rawOffer.tradeofferid,
      friend_steam_id: partnerSteamId64,
      created_at: new Date(rawOffer.time_created * 1000).toISOString(),
      updated_at: new Date(rawOffer.time_updated * 1000).toISOString(),
      expires_at: rawOffer.expiration_time ? new Date(rawOffer.expiration_time * 1000).toISOString() : null,
      state: stateNames[rawOffer.trade_offer_state] || `Unknown(${rawOffer.trade_offer_state})`,
      state_history: [{
        state: stateNames[rawOffer.trade_offer_state] || `Unknown(${rawOffer.trade_offer_state})`,
        timestamp: new Date(rawOffer.time_updated * 1000).toISOString()
      }],
      items_to_give: itemsToGive,
      items_to_receive: itemsToReceive,
      is_our_offer: rawOffer.is_our_offer || false,
      message: rawOffer.message || '',
      confirmation_method: rawOffer.confirmation_method || null
    };
  }

  /**
   * Convert Steam account ID (32-bit) to SteamID64
   * @param {number} accountId - 32-bit account ID
   * @returns {string} - 64-bit Steam ID
   */
  accountIdToSteamId64(accountId) {
    // Steam ID64 = 76561197960265728 + accountId
    const baseId = BigInt('76561197960265728');
    const steamId64 = baseId + BigInt(accountId);
    return steamId64.toString();
  }

  /**
   * Upsert trade offer - unified method to add or update trade offers in the array
   * @param {Array} tradeOffers - Current trade_offers array
   * @param {Object} offerData - Trade offer data to upsert
   * @param {String} newState - Optional: New state to add to state_history (if updating)
   * @returns {Array} - Updated trade_offers array
   */
  upsertTradeOffer(tradeOffers, offerData, newState = null) {
    const existingIndex = tradeOffers.findIndex(
      offer => offer.trade_offer_id === offerData.trade_offer_id
    );

    if (existingIndex !== -1) {
      // Offer exists - update it
      const existingOffer = tradeOffers[existingIndex];

      // Add new state to history if provided
      const updatedStateHistory = newState ? [
        ...existingOffer.state_history,
        {
          state: newState,
          timestamp: new Date().toISOString()
        }
      ] : existingOffer.state_history;

      // Update the offer
      const updatedOffer = {
        ...existingOffer,
        ...offerData, // Merge new data
        state: newState || existingOffer.state, // Update current state if provided
        state_history: updatedStateHistory,
        updated_at: new Date().toISOString()
      };

      // Replace in array
      return [
        ...tradeOffers.slice(0, existingIndex),
        updatedOffer,
        ...tradeOffers.slice(existingIndex + 1)
      ];
    } else {
      // Offer doesn't exist - add it
      const newOffer = {
        ...offerData,
        state: newState || offerData.state || 'Active', // Set current state
        created_at: offerData.created_at || new Date().toISOString(),
        state_history: offerData.state_history || [{
          state: newState || 'Active',
          timestamp: new Date().toISOString()
        }]
      };

      return [...tradeOffers, newOffer];
    }
  }
}

module.exports = TradeOfferDataTransformer;
