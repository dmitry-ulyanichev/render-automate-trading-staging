// automate_trading/workers/helpers/steam_trade_operations.js

const SteamTradeManager = require('../../utils/steam_trade_manager');

/**
 * SteamTradeOperations
 *
 * Handles direct interactions with Steam's TradeOfferManager API
 * - Creates trade offers
 * - Accepts trade offers
 * - Declines trade offers
 * - Cancels trade offers
 */
class SteamTradeOperations {
  constructor(orchestrationQueue, dataTransformer, logger, workerName) {
    this.orchestrationQueue = orchestrationQueue;
    this.dataTransformer = dataTransformer;
    this.logger = logger;
    this.workerName = workerName;
  }

  /**
   * REAL IMPLEMENTATION: Create a trade offer via Steam
   */
  async createTradeOffer(task, parseTaskID) {
    const { taskID, params } = task;
    const { items_to_give, items_to_receive, message } = params;

    try {
      this.logger.info(`${this.workerName} Creating trade offer for ${taskID}`);

      // Get Steam IDs
      const { ourSteamId, friendSteamId } = parseTaskID(taskID);

      // Get TradeOfferManager instance
      const manager = SteamTradeManager.getManager(ourSteamId);
      if (!manager) {
        throw new Error(`No TradeOfferManager found for account ${ourSteamId}`);
      }

      // Get context to access inventories
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(t => t.taskID === taskID);

      if (!orchestrationTask || !orchestrationTask.context) {
        throw new Error(`No orchestration context found for ${taskID}`);
      }

      const context = orchestrationTask.context;

      // Create the offer
      const offer = manager.createOffer(friendSteamId);

      // Add items we're giving (from our inventory)
      if (items_to_give && items_to_give.length > 0) {
        const ourInventory = context.our_inventory || [];
        this.logger.info(`${this.workerName} Converting ${items_to_give.length} item types to give from our inventory (${ourInventory.length} items)`);

        const myAssets = this.dataTransformer.convertItemsToAssets(items_to_give, ourInventory);
        if (myAssets.length === 0) {
          throw new Error('Failed to convert items_to_give to Steam assets');
        }
        offer.addMyItems(myAssets);
        this.logger.info(`${this.workerName} Added ${myAssets.length} asset instances to give`);
      }

      // Add items we're receiving (from friend's inventory)
      if (items_to_receive && items_to_receive.length > 0) {
        const friendInventory = context.inventory || [];

        // Calculate total item count
        const totalItemCount = items_to_receive.reduce((sum, item) => sum + (item.quantity || 1), 0);

        // Steam's hard limit is 256 items per trade offer
        const MAX_ITEMS_PER_OFFER = 256;
        let itemsToRequest = items_to_receive;

        if (totalItemCount > MAX_ITEMS_PER_OFFER) {
          this.logger.warn(`${this.workerName} Total items (${totalItemCount}) exceeds Steam limit (${MAX_ITEMS_PER_OFFER}). Selecting ${MAX_ITEMS_PER_OFFER} most expensive items.`);

          // Sort by price (descending) and take items until we reach 256
          const sortedItems = [...items_to_receive].sort((a, b) => (b.price || 0) - (a.price || 0));
          itemsToRequest = [];
          let itemCount = 0;

          for (const item of sortedItems) {
            const quantity = item.quantity || 1;
            const remainingSlots = MAX_ITEMS_PER_OFFER - itemCount;

            if (remainingSlots <= 0) break;

            if (quantity <= remainingSlots) {
              // Take all of this item type
              itemsToRequest.push(item);
              itemCount += quantity;
            } else {
              // Take partial quantity to fill remaining slots
              itemsToRequest.push({
                ...item,
                quantity: remainingSlots
              });
              itemCount += remainingSlots;
            }
          }

          this.logger.info(`${this.workerName} Limited to ${itemsToRequest.length} item types totaling ${itemCount} items`);
        }

        this.logger.info(`${this.workerName} Converting ${itemsToRequest.length} item types to receive from partner inventory (${friendInventory.length} items)`);

        const theirAssets = this.dataTransformer.convertItemsToAssets(itemsToRequest, friendInventory);
        if (theirAssets.length === 0) {
          throw new Error('Failed to convert items_to_receive to Steam assets');
        }
        offer.addTheirItems(theirAssets);
        this.logger.info(`${this.workerName} Added ${theirAssets.length} asset instances to receive`);
      }

      // Set message if provided
      if (message) {
        offer.setMessage(message);
      }

      // Send the offer
      const sendResult = await new Promise((resolve, reject) => {
        offer.send((err, status) => {
          if (err) {
            // Enhanced error logging with all error properties
            const errorDetails = {
              message: err.message,
              eresult: err.eresult,
              cause: err.cause
            };

            // Log all enumerable properties
            for (const key in err) {
              if (err.hasOwnProperty(key)) {
                errorDetails[key] = err[key];
              }
            }

            this.logger.error(`${this.workerName} Steam trade offer error:`, JSON.stringify(errorDetails, null, 2));
            reject(err);
          } else {
            resolve({ status, offerId: offer.id });
          }
        });
      });

      this.logger.info(`${this.workerName} ✅ Trade offer created successfully: ${sendResult.offerId} (Status: ${sendResult.status})`);

      // Auto-confirm if mobile confirmation is needed
      let confirmed = false;
      if (sendResult.status === 'pending') {
        confirmed = await this.confirmTradeOffer(ourSteamId, sendResult.offerId);
      }

      return {
        action: 'createTradeOffer',
        success: true,
        status: confirmed ? 'offer_created_and_confirmed' : 'offer_created',
        tradeOfferID: sendResult.offerId,
        steamStatus: sendResult.status,
        confirmed: confirmed,
        itemsOffered: items_to_give ? items_to_give.length : 0,
        itemsRequested: items_to_receive ? items_to_receive.length : 0,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Failed to create trade offer: ${error.message}`);

      return {
        action: 'createTradeOffer',
        success: false,
        status: 'creation_failed',
        error: error.message,
        tradeOfferID: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Confirm a trade offer via Steam mobile confirmation
   * Called after offer.send() returns status 'pending'
   */
  async confirmTradeOffer(ourSteamId, offerId) {
    const community = SteamTradeManager.getCommunity(ourSteamId);
    const identitySecret = SteamTradeManager.getIdentitySecret(ourSteamId);

    if (!community || !identitySecret) {
      this.logger.warn(`${this.workerName} ⚠️ Cannot auto-confirm offer ${offerId} - missing community or identity_secret for ${ourSteamId}`);
      return false;
    }

    try {
      this.logger.info(`${this.workerName} Confirming trade offer ${offerId}...`);

      await new Promise((resolve, reject) => {
        community.acceptConfirmationForObject(identitySecret, offerId, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.logger.info(`${this.workerName} ✅ Trade offer ${offerId} confirmed successfully`);
      return true;

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Failed to confirm trade offer ${offerId}: ${error.message}`);
      return false;
    }
  }

  /**
   * REAL IMPLEMENTATION: Accept a trade offer
   */
  async acceptTradeOffer(task, parseTaskID) {
    const { taskID, params } = task;
    const { trade_offer_id } = params;

    try {
      this.logger.info(`${this.workerName} Accepting trade offer ${trade_offer_id} for ${taskID}`);

      // Get Steam IDs
      const { ourSteamId } = parseTaskID(taskID);

      // Get TradeOfferManager instance
      const manager = SteamTradeManager.getManager(ourSteamId);
      if (!manager) {
        throw new Error(`No TradeOfferManager found for account ${ourSteamId}`);
      }

      // Get the offer
      const offer = await new Promise((resolve, reject) => {
        manager.getOffer(trade_offer_id, (err, offer) => {
          if (err) reject(err);
          else resolve(offer);
        });
      });

      // Accept the offer
      await new Promise((resolve, reject) => {
        offer.accept((err, status) => {
          if (err) reject(err);
          else resolve(status);
        });
      });

      this.logger.info(`${this.workerName} ✅ Trade offer ${trade_offer_id} accepted successfully`);

      return {
        action: 'acceptTradeOffer',
        success: true,
        status: 'offer_accepted',
        tradeOfferID: trade_offer_id,
        newState: 'Accepted',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Failed to accept trade offer: ${error.message}`);

      return {
        action: 'acceptTradeOffer',
        success: false,
        status: 'accept_failed',
        error: error.message,
        tradeOfferID: trade_offer_id,
        newState: 'Active',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * REAL IMPLEMENTATION: Decline a trade offer
   */
  async declineTradeOffer(task, parseTaskID) {
    const { taskID, params } = task;
    const { trade_offer_id } = params;

    try {
      this.logger.info(`${this.workerName} Declining trade offer ${trade_offer_id} for ${taskID}`);

      // Get Steam IDs
      const { ourSteamId } = parseTaskID(taskID);

      // Get TradeOfferManager instance
      const manager = SteamTradeManager.getManager(ourSteamId);
      if (!manager) {
        throw new Error(`No TradeOfferManager found for account ${ourSteamId}`);
      }

      // Get the offer
      const offer = await new Promise((resolve, reject) => {
        manager.getOffer(trade_offer_id, (err, offer) => {
          if (err) reject(err);
          else resolve(offer);
        });
      });

      // Decline the offer
      await new Promise((resolve, reject) => {
        offer.decline((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.logger.info(`${this.workerName} ✅ Trade offer ${trade_offer_id} declined successfully`);

      return {
        action: 'declineTradeOffer',
        success: true,
        status: 'offer_declined',
        tradeOfferID: trade_offer_id,
        newState: 'Declined',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Failed to decline trade offer: ${error.message}`);

      return {
        action: 'declineTradeOffer',
        success: false,
        status: 'decline_failed',
        error: error.message,
        tradeOfferID: trade_offer_id,
        newState: 'Active',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * REAL IMPLEMENTATION: Cancel a trade offer
   */
  async cancelTradeOffer(task, parseTaskID) {
    const { taskID, params } = task;
    const { trade_offer_id } = params;

    try {
      this.logger.info(`${this.workerName} Canceling trade offer ${trade_offer_id} for ${taskID}`);

      // Get Steam IDs
      const { ourSteamId } = parseTaskID(taskID);

      // Get TradeOfferManager instance
      const manager = SteamTradeManager.getManager(ourSteamId);
      if (!manager) {
        throw new Error(`No TradeOfferManager found for account ${ourSteamId}`);
      }

      // Get the offer
      const offer = await new Promise((resolve, reject) => {
        manager.getOffer(trade_offer_id, (err, offer) => {
          if (err) reject(err);
          else resolve(offer);
        });
      });

      // Cancel the offer
      await new Promise((resolve, reject) => {
        offer.cancel((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      this.logger.info(`${this.workerName} ✅ Trade offer ${trade_offer_id} canceled successfully`);

      return {
        action: 'cancelTradeOffer',
        success: true,
        status: 'offer_cancelled',
        tradeOfferID: trade_offer_id,
        newState: 'Canceled',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      this.logger.error(`${this.workerName} ❌ Failed to cancel trade offer: ${error.message}`);

      return {
        action: 'cancelTradeOffer',
        success: false,
        status: 'cancel_failed',
        error: error.message,
        tradeOfferID: trade_offer_id,
        newState: 'Active',
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = SteamTradeOperations;
