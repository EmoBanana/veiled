/// Veiled Order Module
/// Stores encrypted order metadata for privacy-preserving limit orders.
/// Orders are encrypted with Seal and stored on Walrus.
/// Agent decrypts via seal_approve_order and executes on Ethereum.
#[allow(lint(public_entry))]
module veiled::order {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::event;
    use sui::transfer;

    // =========== Constants ===========
    
    /// Agent address (Ethereum-style, but used for Sui access control)
    const AGENT: address = @0xd8f5bddae49210cdf2d63415ddd4ffd3f80a20947e589dd3f9e576f95fc8a540;
    
    /// Error codes
    const E_NOT_AGENT: u64 = 0;
    const E_NOT_OWNER: u64 = 1;
    const E_ALREADY_EXECUTED: u64 = 2;
    const E_ALREADY_CANCELLED: u64 = 3;

    // =========== Structs ===========

    /// Order metadata stored on-chain (encrypted payload is on Walrus)
    public struct Order has key, store {
        id: UID,
        /// Creator of the order
        user: address,
        /// Walrus blob ID containing encrypted order payload
        blob_id: vector<u8>,
        /// Epoch when order was created
        created_at: u64,
        /// Whether order has been executed
        executed: bool,
        /// Whether order has been cancelled
        cancelled: bool,
    }

    // =========== Events ===========

    /// Emitted when a new order is created
    public struct OrderCreated has copy, drop {
        order_id: address,
        user: address,
        blob_id: vector<u8>,
    }

    /// Emitted when an order is executed
    public struct OrderExecuted has copy, drop {
        order_id: address,
        user: address,
    }

    /// Emitted when an order is cancelled
    public struct OrderCancelled has copy, drop {
        order_id: address,
        user: address,
    }

    // =========== Public Functions ===========

    /// Create a new encrypted order
    /// blob_id: Walrus blob ID containing Seal-encrypted order payload
    public entry fun create_order(
        blob_id: vector<u8>,
        ctx: &mut TxContext
    ) {
        let order = Order {
            id: object::new(ctx),
            user: tx_context::sender(ctx),
            blob_id,
            created_at: tx_context::epoch(ctx),
            executed: false,
            cancelled: false,
        };

        let order_id = object::uid_to_address(&order.id);
        
        event::emit(OrderCreated {
            order_id,
            user: order.user,
            blob_id: order.blob_id,
        });

        // Share object so agent can access it
        transfer::share_object(order);
    }

    /// Cancel an order (owner only, can cancel anytime)
    public entry fun cancel_order(
        order: &mut Order,
        ctx: &TxContext
    ) {
        // Only owner can cancel
        assert!(tx_context::sender(ctx) == order.user, E_NOT_OWNER);
        assert!(!order.cancelled, E_ALREADY_CANCELLED);
        
        order.cancelled = true;
        
        event::emit(OrderCancelled {
            order_id: object::uid_to_address(&order.id),
            user: order.user,
        });
    }

    /// Seal access control: grants decryption permission
    /// Called by Seal SDK when requesting decryption keys
    /// 
    /// Access control is handled by Seal SDK through session key binding:
    /// - Session key is bound to agent's address + this package ID
    /// - Only agent can create valid session keys (requires private key signature)
    /// 
    /// This function only checks business logic (order status).
    public entry fun seal_approve_order(
        _id: vector<u8>,
        order: &Order,
        _ctx: &TxContext
    ) {
        // Cannot decrypt cancelled orders
        assert!(!order.cancelled, E_ALREADY_CANCELLED);
        
        // Cannot decrypt already executed orders
        assert!(!order.executed, E_ALREADY_EXECUTED);
        
        // If we reach here without aborting, Seal key servers will release decryption keys
    }

    /// Mark order as executed (agent only, after ETH settlement)
    public entry fun mark_executed(
        order: &mut Order,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == AGENT, E_NOT_AGENT);
        assert!(!order.executed, E_ALREADY_EXECUTED);
        assert!(!order.cancelled, E_ALREADY_CANCELLED);
        
        order.executed = true;
        
        event::emit(OrderExecuted {
            order_id: object::uid_to_address(&order.id),
            user: order.user,
        });
    }

    // =========== View Functions ===========

    /// Check if order is active (not executed and not cancelled)
    public fun is_active(order: &Order): bool {
        !order.executed && !order.cancelled
    }

    /// Get order owner
    public fun get_user(order: &Order): address {
        order.user
    }

    /// Get blob ID
    public fun get_blob_id(order: &Order): vector<u8> {
        order.blob_id
    }
}
