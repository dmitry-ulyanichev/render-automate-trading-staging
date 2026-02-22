// automate_trading/workers/helpers/trade_offer_context_manager.js

/**
 * TradeOfferContextManager
 *
 * Manages orchestration context, negotiation JSON, and Django model synchronization
 * for trade offers. Handles the coordination between multiple data stores.
 */
class TradeOfferContextManager {
  constructor(orchestrationQueue, httpClient, djangoClient, dataTransformer, logger, workerName) {
    this.orchestrationQueue = orchestrationQueue;
    this.httpClient = httpClient;
    this.djangoClient = djangoClient;
    this.dataTransformer = dataTransformer;
    this.logger = logger;
    this.workerName = workerName;
  }

  /**
   * Update trade offer state in orchestration context and negotiation JSON
   * Used for direct queue actions (accept/cancel/decline)
   */
  async updateTradeOfferState(taskID, action, tradeOfferResult, parseTaskID, syncTradeToDjango) {
    try {
      this.logger.info(`${this.workerName} Updating trade offer state for ${taskID}, action: ${action}`);

      // Get current orchestration task
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

      if (!orchestrationTask || !orchestrationTask.context) {
        this.logger.error(`${this.workerName} No orchestration task or context found for ${taskID}`);
        return false;
      }

      const context = orchestrationTask.context;
      const { ourSteamId, friendSteamId } = parseTaskID(taskID);

      // Use upsertTradeOffer to update the offer state
      const updatedTradeOffers = tradeOfferResult.success
        ? this.dataTransformer.upsertTradeOffer(
            context.trade_offers || [],
            { trade_offer_id: tradeOfferResult.tradeOfferID },
            tradeOfferResult.newState
          )
        : context.trade_offers; // If failed, don't update

      // Update context
      const contextUpdates = {
        ...context,
        trade_offers: updatedTradeOffers,
        trade_offers_updated_at: new Date().toISOString(),
        last_trade_action: {
          action: action,
          result: tradeOfferResult.status,
          timestamp: new Date().toISOString()
        }
      };

      // STEP 1: Update orchestration task context
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        context: contextUpdates
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Successfully updated orchestration context for trade offer ${tradeOfferResult.tradeOfferID}`);

        // STEP 2: Update negotiation JSON via HTTP client
        try {
          await this.updateNegotiationContext(ourSteamId, friendSteamId, {
            trade_offers: contextUpdates.trade_offers,
            trade_offers_updated_at: contextUpdates.trade_offers_updated_at,
            last_trade_action: contextUpdates.last_trade_action
          });

          this.logger.info(`${this.workerName} ✅ Successfully updated negotiation JSON for ${ourSteamId} -> ${friendSteamId}`);
        } catch (error) {
          this.logger.error(`${this.workerName} ❌ Failed to update negotiation JSON: ${error.message}`);
        }

        // STEP 3: Sync to Django Trade model (if successful)
        if (tradeOfferResult.success) {
          try {
            // Find the updated trade offer
            const updatedOffer = updatedTradeOffers.find(
              offer => offer.trade_offer_id === tradeOfferResult.tradeOfferID
            );

            if (updatedOffer) {
              await syncTradeToDjango(ourSteamId, updatedOffer, tradeOfferResult.newState);
              this.logger.info(`${this.workerName} ✅ Successfully synced trade state to Django for ${tradeOfferResult.tradeOfferID}`);
            }
          } catch (error) {
            this.logger.error(`${this.workerName} ❌ Failed to sync trade state to Django: ${error.message}`);
          }
        }

        return true;
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update orchestration context for ${taskID}`);
        return false;
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Error updating trade offer state: ${error.message}`);
      return false;
    }
  }

  /**
   * Update orchestration context for gift request trade offers to prevent infinite loops
   * Also updates negotiation JSON via HTTP client
   */
  async updateOrchestrationContextForGiftRequest(taskID, action, tradeOfferResult, itemsToReceive, itemsToGive, parseTaskID, syncTradeToDjango) {
    try {
        this.logger.info(`${this.workerName} Updating orchestration context for gift request ${taskID}`);

        // Get current orchestration task
        const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
        const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

        if (!orchestrationTask || !orchestrationTask.context) {
            this.logger.error(`${this.workerName} No orchestration task or context found for ${taskID}`);
            return false;
        }

        const context = orchestrationTask.context;
        const { ourSteamId, friendSteamId } = parseTaskID(taskID);

        // Create trade offer entry for the context
        const tradeOfferData = {
            trade_offer_id: tradeOfferResult.tradeOfferID,
            friend_steam_id: friendSteamId,  // For filtering by friend
            items_to_give: itemsToGive,
            items_to_receive: itemsToReceive,
            is_our_offer: true,
            action: action
        };

        // Use upsertTradeOffer to add or update the offer
        const updatedTradeOffers = this.dataTransformer.upsertTradeOffer(
            context.trade_offers || [],
            tradeOfferData,
            'Active'
        );

        // Update context with the upserted trade offer
        const contextUpdates = {
            ...context,
            trade_offers: updatedTradeOffers,
            trade_offers_updated_at: new Date().toISOString(),
            // Mark as processed to prevent infinite loops
            trade_offer_created: true,
            last_trade_action: {
                action: action,
                result: tradeOfferResult.status,
                timestamp: new Date().toISOString()
            }
        };

        // STEP 1: Update orchestration task context
        const updateResult = await this.orchestrationQueue.updateTask(taskID, {
            context: contextUpdates
        });

        if (updateResult) {
            this.logger.info(`${this.workerName} ✅ Successfully updated orchestration context with new trade offer ${tradeOfferResult.tradeOfferID}`);

            // STEP 2: Update negotiation JSON via HTTP client
            try {
                await this.updateNegotiationContext(ourSteamId, friendSteamId, {
                    trade_offers: contextUpdates.trade_offers,
                    trade_offers_updated_at: contextUpdates.trade_offers_updated_at,
                    last_trade_action: contextUpdates.last_trade_action
                });

                this.logger.info(`${this.workerName} ✅ Successfully updated negotiation JSON for ${ourSteamId} -> ${friendSteamId}`);
            } catch (error) {
                this.logger.error(`${this.workerName} ❌ Failed to update negotiation JSON: ${error.message}`);
                // Don't return false here - the orchestration task was updated successfully
            }

            // STEP 3: Sync to Django Trade model
            try {
                await syncTradeToDjango(ourSteamId, tradeOfferData, 'Active');
                this.logger.info(`${this.workerName} ✅ Successfully synced trade to Django for ${tradeOfferResult.tradeOfferID}`);
            } catch (error) {
                this.logger.error(`${this.workerName} ❌ Failed to sync trade to Django: ${error.message}`);
                // Don't return false here - the orchestration task was updated successfully
            }

            return true;
        } else {
            this.logger.error(`${this.workerName} ❌ Failed to update orchestration context for ${taskID}`);
            return false;
        }

    } catch (error) {
        this.logger.error(`${this.workerName} Error updating orchestration context: ${error.message}`);
        return false;
    }
  }

  /**
   * Update negotiation context via HTTP client
   * Handles account-level trade_offers properly
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
                // REMOVED: trade_offers (moved to account level)
                // REMOVED: trade_offers_updated_at (moved to account level)
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
        if (Object.keys(friendLevelUpdates).length > 0) {
            Object.assign(currentNegotiations.negotiations[friendSteamId], friendLevelUpdates);
        }
        currentNegotiations.negotiations[friendSteamId].updated_at = new Date().toISOString();

        // Save back via HTTP API
        await this.httpClient.saveNegotiations(ourSteamId, currentNegotiations);

        this.logger.info(`${this.workerName}: Updated negotiation context for ${ourSteamId} -> ${friendSteamId}`);

    } catch (error) {
        this.logger.error(`${this.workerName}: Failed to update negotiation context: ${error.message}`);
        throw error;
    }
  }

  /**
   * Process AI requested actions correctly according to Scenario 9
   * 1. Move action from actions_pending to actions_completed
   * 2. If actions_pending becomes empty, remove "ai_requested_actions" from pending_tasks
   */
  async processAIRequestedActions(taskID, actionId, tradeOfferResult, parseTaskID) {
    try {
      this.logger.info(`${this.workerName} Processing AI requested action ${actionId} for ${taskID}`);

      // Get current orchestration task
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

      if (!orchestrationTask || !orchestrationTask.context) {
          this.logger.error(`${this.workerName} No orchestration task or context found for ${taskID}`);
          return false;
      }

      const context = orchestrationTask.context;
      const { ourSteamId, friendSteamId } = parseTaskID(taskID);

      // Ensure ai_requested_actions exists
      if (!context.ai_requested_actions || !context.ai_requested_actions.actions_pending) {
        this.logger.warn(`${this.workerName} No ai_requested_actions.actions_pending found for ${taskID}`);
        return false;
      }

      // Find the action in actions_pending
      const pendingActions = context.ai_requested_actions.actions_pending;
      const actionIndex = pendingActions.findIndex(action => action.action_id === actionId);

      if (actionIndex === -1) {
        this.logger.error(`${this.workerName} Action ${actionId} not found in actions_pending for ${taskID}`);
        return false;
      }

      // Get the action to move
      const actionToComplete = pendingActions[actionIndex];

      // Create completed action with result
      const completedAction = {
        ...actionToComplete,
        completed_at: new Date().toISOString(),
        result: tradeOfferResult.status,
        success: tradeOfferResult.success,
        details: {
          trade_offer_id: tradeOfferResult.tradeOfferID,
          action: tradeOfferResult.action,
          timestamp: tradeOfferResult.timestamp
        }
      };

      // Remove from pending and add to completed
      const updatedPendingActions = pendingActions.filter((_, index) => index !== actionIndex);
      const updatedCompletedActions = [
        ...(context.ai_requested_actions.actions_completed || []),
        completedAction
      ];

      // Update ai_requested_actions in context
      const updatedAIActions = {
        ...context.ai_requested_actions,
        actions_pending: updatedPendingActions,
        actions_completed: updatedCompletedActions,
        updated_at: new Date().toISOString()
      };

      // Determine if we should remove "ai_requested_actions" from pending_tasks
      const shouldRemoveFromPendingTasks = updatedPendingActions.length === 0;

      // Update pending_tasks if actions_pending is now empty
      let updatedPendingTasks = orchestrationTask.pending_tasks || [];
      if (shouldRemoveFromPendingTasks) {
        updatedPendingTasks = updatedPendingTasks.filter(task => task !== 'ai_requested_actions');
        this.logger.info(`${this.workerName} actions_pending is empty - removing "ai_requested_actions" from pending_tasks`);
      }

      // Build complete context update
      const contextUpdates = {
        ...context,
        ai_requested_actions: updatedAIActions,
        trade_offers_updated_at: new Date().toISOString(),

        // Add dummy trade offer if one was created
        ...(tradeOfferResult.action === 'createTradeOffer' && tradeOfferResult.success && {
          trade_offers: [
            ...(context.trade_offers || []),
            {
              trade_offer_id: tradeOfferResult.tradeOfferID,
              friend_steam_id: friendSteamId,  // ADDED: For filtering by friend
              state: 'Active', // Current state
              created_at: new Date().toISOString(),
              state_history: [{
                state: 'Active',
                timestamp: new Date().toISOString()
              }],
              items_to_give: tradeOfferResult.itemsOffered || 0,
              items_to_receive: tradeOfferResult.itemsRequested || 0,
              is_our_offer: true,
              action_id: actionId // Link to the AI action that created it
            }
          ]
        }),

        // Update existing trade offer state if action was accept/cancel/decline
        ...((['acceptTradeOffer', 'cancelTradeOffer', 'declineTradeOffer'].includes(tradeOfferResult.action)) && {
          trade_offers: tradeOfferResult.success
            ? this.dataTransformer.upsertTradeOffer(
                context.trade_offers || [],
                { trade_offer_id: tradeOfferResult.tradeOfferID },
                tradeOfferResult.newState
              )
            : context.trade_offers // If failed, don't update
        }),

        // Mark as processed to prevent infinite loops in tests
        dummy_trade_offer_processed: true,
        last_trade_offer_action: {
          action: tradeOfferResult.action,
          result: tradeOfferResult.status,
          timestamp: new Date().toISOString()
        }
      };

      // Update the orchestration task
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        context: contextUpdates,
        pending_tasks: updatedPendingTasks,
        updated_at: new Date().toISOString()
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Successfully processed AI requested action:`, {
          actionId: actionId,
          taskID: taskID,
          actionType: actionToComplete.type,
          result: tradeOfferResult.status,
          pendingActionsRemaining: updatedPendingActions.length,
          removedFromPendingTasks: shouldRemoveFromPendingTasks
        });

        // UPDATE NEGOTIATION JSON
        try {
          await this.updateNegotiationContext(ourSteamId, friendSteamId, {
            ai_requested_actions: updatedAIActions,
            trade_offers: contextUpdates.trade_offers || context.trade_offers,
            trade_offers_updated_at: contextUpdates.trade_offers_updated_at || new Date().toISOString()
          });

          this.logger.info(`${this.workerName} ✅ Successfully updated negotiation JSON for AI action ${actionId}`);
        } catch (error) {
          this.logger.error(`${this.workerName} ❌ Failed to update negotiation JSON for AI action: ${error.message}`);
          // Continue - the orchestration task was updated successfully
        }

        return true;
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update orchestration task ${taskID}`);
        return false;
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Error processing AI requested action: ${error.message}`);
      return false;
    }
  }

  /**
   * Update orchestration task by removing completed pending task
   * DEPRECATED: This method is replaced by processAIRequestedActions for AI-related actions
   */
  async updateOrchestrationPendingTasks(taskID, completedTask) {
    try {
      this.logger.info(`${this.workerName} Attempting to update orchestration task ${taskID} - removing '${completedTask}'`);

      // For AI actions, we should use processAIRequestedActions instead
      if (completedTask === 'ai_requested_actions') {
        this.logger.warn(`${this.workerName} Use processAIRequestedActions() for AI-related actions instead of this method`);
        return;
      }

      // Get all orchestration tasks
      const allOrchestrationTasks = await this.orchestrationQueue.getTasks();

      // Find the specific task
      const orchestrationTask = allOrchestrationTasks.find(task => task.taskID === taskID);

      if (!orchestrationTask) {
        this.logger.error(`${this.workerName} No orchestration task found with taskID ${taskID}`);
        return;
      }

      // Remove the completed task from pending_tasks
      const updatedPendingTasks = (orchestrationTask.pending_tasks || [])
        .filter(pendingTask => pendingTask !== completedTask);

      // Update the orchestration task
      const updateResult = await this.orchestrationQueue.updateTask(taskID, {
        pending_tasks: updatedPendingTasks,
        updated_at: new Date().toISOString()
      });

      if (updateResult) {
        this.logger.info(`${this.workerName} ✅ Successfully updated orchestration task ${taskID} - removed '${completedTask}'`);
      } else {
        this.logger.error(`${this.workerName} ❌ Failed to update orchestration task ${taskID}`);
      }

    } catch (error) {
      this.logger.error(`${this.workerName} Failed to update orchestration pending_tasks for ${taskID}: ${error.message}`);
      throw error;
    }
  }
}

module.exports = TradeOfferContextManager;
