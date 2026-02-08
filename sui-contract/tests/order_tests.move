#[test_only]
module veiled::order_tests {
    use sui::test_scenario::{Self, Scenario};
    use sui::test_utils;
    use veiled::order::{Self, Order};

    // Test addresses
    const USER: address = @0xCAFE;
    const AGENT: address = @0x54609ff7660d8bF2F6c2c6078dae2E7f791610b4;
    const ATTACKER: address = @0xBAD;

    #[test]
    fun test_create_order() {
        let mut scenario = test_scenario::begin(USER);
        
        // User creates an order
        test_scenario::next_tx(&mut scenario, USER);
        {
            let blob_id = b"QmTestBlobId12345";
            order::create_order(blob_id, test_scenario::ctx(&mut scenario));
        };
        
        // Verify order was created and shared
        test_scenario::next_tx(&mut scenario, USER);
        {
            let order = test_scenario::take_shared<Order>(&scenario);
            assert!(order::is_active(&order), 0);
            assert!(order::get_user(&order) == USER, 1);
            assert!(order::get_blob_id(&order) == b"QmTestBlobId12345", 2);
            test_scenario::return_shared(order);
        };
        
        test_scenario::end(scenario);
    }

    #[test]
    fun test_cancel_order_by_owner() {
        let mut scenario = test_scenario::begin(USER);
        
        // User creates an order
        test_scenario::next_tx(&mut scenario, USER);
        {
            order::create_order(b"QmTestBlobId", test_scenario::ctx(&mut scenario));
        };
        
        // User cancels their order
        test_scenario::next_tx(&mut scenario, USER);
        {
            let mut order = test_scenario::take_shared<Order>(&scenario);
            order::cancel_order(&mut order, test_scenario::ctx(&mut scenario));
            assert!(!order::is_active(&order), 0);
            test_scenario::return_shared(order);
        };
        
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 1)] // E_NOT_OWNER
    fun test_cancel_order_by_non_owner_fails() {
        let mut scenario = test_scenario::begin(USER);
        
        // User creates an order
        test_scenario::next_tx(&mut scenario, USER);
        {
            order::create_order(b"QmTestBlobId", test_scenario::ctx(&mut scenario));
        };
        
        // Attacker tries to cancel (should fail)
        test_scenario::next_tx(&mut scenario, ATTACKER);
        {
            let mut order = test_scenario::take_shared<Order>(&scenario);
            order::cancel_order(&mut order, test_scenario::ctx(&mut scenario));
            test_scenario::return_shared(order);
        };
        
        test_scenario::end(scenario);
    }

    #[test]
    fun test_agent_can_approve_and_execute() {
        let mut scenario = test_scenario::begin(USER);
        
        // User creates an order
        test_scenario::next_tx(&mut scenario, USER);
        {
            order::create_order(b"QmTestBlobId", test_scenario::ctx(&mut scenario));
        };
        
        // Agent approves (decryption access) and marks executed
        test_scenario::next_tx(&mut scenario, AGENT);
        {
            let mut order = test_scenario::take_shared<Order>(&scenario);
            order::seal_approve_order(b"test_id", &order, test_scenario::ctx(&mut scenario));
            order::mark_executed(&mut order, test_scenario::ctx(&mut scenario));
            assert!(!order::is_active(&order), 0);
            test_scenario::return_shared(order);
        };
        
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 0)] // E_NOT_AGENT
    fun test_non_agent_cannot_approve() {
        let mut scenario = test_scenario::begin(USER);
        
        // User creates an order
        test_scenario::next_tx(&mut scenario, USER);
        {
            order::create_order(b"QmTestBlobId", test_scenario::ctx(&mut scenario));
        };
        
        // Attacker tries to approve (should fail)
        test_scenario::next_tx(&mut scenario, ATTACKER);
        {
            let order = test_scenario::take_shared<Order>(&scenario);
            order::seal_approve_order(b"test_id", &order, test_scenario::ctx(&mut scenario));
            test_scenario::return_shared(order);
        };
        
        test_scenario::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 3)] // E_ALREADY_CANCELLED
    fun test_cannot_approve_cancelled_order() {
        let mut scenario = test_scenario::begin(USER);
        
        // User creates and cancels order
        test_scenario::next_tx(&mut scenario, USER);
        {
            order::create_order(b"QmTestBlobId", test_scenario::ctx(&mut scenario));
        };
        
        test_scenario::next_tx(&mut scenario, USER);
        {
            let mut order = test_scenario::take_shared<Order>(&scenario);
            order::cancel_order(&mut order, test_scenario::ctx(&mut scenario));
            test_scenario::return_shared(order);
        };
        
        // Agent tries to approve cancelled order (should fail)
        test_scenario::next_tx(&mut scenario, AGENT);
        {
            let order = test_scenario::take_shared<Order>(&scenario);
            order::seal_approve_order(b"test_id", &order, test_scenario::ctx(&mut scenario));
            test_scenario::return_shared(order);
        };
        
        test_scenario::end(scenario);
    }
}
